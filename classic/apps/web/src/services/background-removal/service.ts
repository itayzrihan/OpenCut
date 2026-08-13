import type { ResolvedBackgroundRemovalSettings } from "@/background-removal";
import {
	createIndexedDbPreparedMaskPersistence,
	PREPARED_MASK_SCHEMA_VERSION,
	type PersistedPreparedMaskFrame,
	type PreparedMaskFrameMetadata,
	type PreparedMaskManifest,
	type PreparedMaskPersistence,
} from "./prepared-mask-persistence";
import type {
	BackgroundRemovalBackend,
	BackgroundRemovalWorkerMessage,
	BackgroundRemovalWorkerResponse,
} from "./protocol";

export type BackgroundRemovalModelStatus =
	| { state: "idle" }
	| { state: "loading"; progress: number }
	| { state: "ready"; backend: BackgroundRemovalBackend }
	| { state: "error"; message: string };

export type BackgroundMaskFrame = {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
	contentHash: string;
};

export type BackgroundMaskInvalidation =
	| { kind: "preview"; mediaId: string; sourceTime: number }
	| { kind: "prepared"; groupKey: string };

type BackgroundMaskRecord = {
	alpha: Uint8Array;
	width: number;
	height: number;
	contentHash: string;
};

type PreparedMaskGroup = {
	frames: Map<string, BackgroundMaskRecord>;
	frameIndex: Map<string, PreparedMaskFrameMetadata>;
	byteSize: number;
	totalByteSize: number;
	lastUsed: number;
	complete: boolean;
	expectedInferenceKeys: string[] | null;
};

type PreviewMaskEntry = {
	frame: BackgroundMaskFrame;
	sourceTime: number;
};

type SegmentCompleteResponse = Extract<
	BackgroundRemovalWorkerResponse,
	{ type: "segment-complete" }
>;

type PendingSegment = {
	generation: number;
	resolve: (response: SegmentCompleteResponse) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	removeAbortListener: () => void;
};

type InferenceBitmapFactory = (options: {
	source: CanvasImageSource;
	inputSize: number;
}) => Promise<ImageBitmap>;

export type BackgroundRemovalServiceOptions = {
	workerFactory?: () => Worker;
	inferenceBitmapFactory?: InferenceBitmapFactory;
	persistence?: PreparedMaskPersistence | null;
	autoHydrate?: boolean;
	requestTimeoutMs?: number;
	maxPreparedGroups?: number;
	maxPreparedAlphaBytes?: number;
	previewMaxReuseGapSeconds?: number;
};

const WEBGPU_STARTUP_TIMEOUT_MS = 15_000;
const WASM_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_SEGMENT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_PREPARED_GROUPS = 8;
const DEFAULT_MAX_PREPARED_ALPHA_BYTES = 384 * 1024 * 1024;
const DEFAULT_PREVIEW_MAX_REUSE_GAP_SECONDS = 0.12;
const MAX_PREVIEW_SEQUENCES = 32;

export class BackgroundRemovalService {
	private worker: Worker | null = null;
	private workerGeneration = 0;
	private status: BackgroundRemovalModelStatus = { state: "idle" };
	private listeners = new Set<() => void>();
	private invalidationListeners = new Set<
		(invalidation: BackgroundMaskInvalidation) => void
	>();
	private initialization: Promise<void> | null = null;
	private resolveInitialization: (() => void) | null = null;
	private rejectInitialization: ((error: Error) => void) | null = null;
	private initializationFallbackTimer: ReturnType<typeof setTimeout> | null =
		null;
	private nextRequestId = 1;
	private pending = new Map<number, PendingSegment>();
	private cache = new Map<string, BackgroundMaskFrame>();
	private inFlight = new Map<string, Promise<BackgroundMaskRecord>>();
	private preparedGroups = new Map<string, PreparedMaskGroup>();
	private persistedPreparedManifests = new Map<string, PreparedMaskManifest>();
	private preparedAlphaBytes = 0;
	private reservedPreparedAlphaBytes = 0;
	private latestPreviewMask = new Map<string, PreviewMaskEntry>();
	private pendingPreviewSequence = new Set<string>();
	private persistence: PreparedMaskPersistence | null;
	private persistenceQueue: Promise<void> = Promise.resolve();
	private persistenceErrors = new Map<string, Error>();
	private restorePreparedGroupsPromise: Promise<void> | null = null;
	private hydratingPreparedGroups = new Map<string, Promise<boolean>>();
	private readonly workerFactory: () => Worker;
	private readonly inferenceBitmapFactory: InferenceBitmapFactory;
	private readonly requestTimeoutMs: number;
	private readonly maxPreparedGroups: number;
	private readonly maxPreparedAlphaBytes: number;
	private readonly previewMaxReuseGapSeconds: number;

	constructor(options: BackgroundRemovalServiceOptions = {}) {
		this.workerFactory =
			options.workerFactory ??
			(() =>
				new Worker(new URL("./worker.ts", import.meta.url), {
					type: "module",
				}));
		this.inferenceBitmapFactory =
			options.inferenceBitmapFactory ?? createInferenceBitmap;
		this.persistence =
			options.persistence === undefined
				? createIndexedDbPreparedMaskPersistence()
				: options.persistence;
		this.requestTimeoutMs = normalizePositiveNumber({
			value: options.requestTimeoutMs,
			fallback: DEFAULT_SEGMENT_REQUEST_TIMEOUT_MS,
		});
		this.maxPreparedGroups = Math.max(
			1,
			Math.floor(
				normalizePositiveNumber({
					value: options.maxPreparedGroups,
					fallback: DEFAULT_MAX_PREPARED_GROUPS,
				}),
			),
		);
		this.maxPreparedAlphaBytes = Math.max(
			1,
			Math.floor(
				normalizePositiveNumber({
					value: options.maxPreparedAlphaBytes,
					fallback: DEFAULT_MAX_PREPARED_ALPHA_BYTES,
				}),
			),
		);
		this.previewMaxReuseGapSeconds = normalizePositiveNumber({
			value: options.previewMaxReuseGapSeconds,
			fallback: DEFAULT_PREVIEW_MAX_REUSE_GAP_SECONDS,
		});
		if (options.autoHydrate !== false && this.persistence) {
			queueMicrotask(() => {
				void this.hydratePreparedGroups().catch(() => undefined);
			});
		}
	}

	getStatus = (): BackgroundRemovalModelStatus => this.status;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	subscribeMaskInvalidation = (
		listener: (invalidation: BackgroundMaskInvalidation) => void,
	): (() => void) => {
		this.invalidationListeners.add(listener);
		return () => this.invalidationListeners.delete(listener);
	};

	preload(): Promise<void> {
		if (this.status.state === "ready") return Promise.resolve();
		if (this.status.state === "error") {
			return Promise.reject(new Error(this.status.message));
		}
		if (this.initialization) return this.initialization;

		const worker = this.ensureWorker();
		const generation = this.workerGeneration;
		this.setStatus({ state: "loading", progress: 0 });
		this.initialization = new Promise<void>((resolve, reject) => {
			this.resolveInitialization = resolve;
			this.rejectInitialization = reject;
		});
		worker.postMessage({
			type: "init",
			generation,
			backend: "auto",
		} satisfies BackgroundRemovalWorkerMessage);
		this.initializationFallbackTimer = setTimeout(
			() => this.restartInitializationWithWasm(),
			WEBGPU_STARTUP_TIMEOUT_MS,
		);
		return this.initialization;
	}

	retry(): Promise<void> {
		const restartError = new Error("Background removal model restarted");
		this.resetWorker({
			error: restartError,
			nextStatus: { state: "idle" },
		});
		this.cache.clear();
		this.inFlight.clear();
		this.latestPreviewMask.clear();
		this.pendingPreviewSequence.clear();
		return this.preload();
	}

	async segmentFrame({
		source,
		mediaId,
		sourceTime,
		settings,
		isPreview,
		signal,
		temporalSequenceKey,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		isPreview: boolean;
		signal?: AbortSignal;
		temporalSequenceKey?: string;
	}): Promise<BackgroundMaskFrame> {
		throwIfAborted(signal);
		const inferenceKey = this.buildInferenceKey({
			mediaId,
			sourceTime,
			settings,
			isPreview,
		});
		const renderKey = this.buildRenderKey({ inferenceKey, settings });
		const cached = this.cache.get(renderKey);
		if (cached) {
			this.touchRenderCache({ renderKey, frame: cached });
			return cached;
		}
		const record = await this.getOrRunSegmentation({
			source,
			mediaId,
			sourceTime,
			settings,
			inferenceKey,
			signal,
			temporalSequenceKey,
		});
		throwIfAborted(signal);
		return this.materializeMaskFrame({
			record,
			renderKey,
			settings,
		});
	}

	getPreviewMaskOrSchedule({
		source,
		mediaId,
		sourceTime,
		settings,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
	}): BackgroundMaskFrame | null {
		const inferenceKey = this.buildInferenceKey({
			mediaId,
			sourceTime,
			settings,
			isPreview: true,
		});
		const renderKey = this.buildRenderKey({ inferenceKey, settings });
		const sequenceKey = this.buildPreviewSequenceKey({ mediaId, settings });
		const exact = this.cache.get(renderKey);
		if (exact) {
			this.touchRenderCache({ renderKey, frame: exact });
			this.touchLatestPreviewMask({
				sequenceKey,
				entry: { frame: exact, sourceTime },
			});
			return exact;
		}

		if (!this.pendingPreviewSequence.has(sequenceKey)) {
			this.pendingPreviewSequence.add(sequenceKey);
			void this.segmentFrame({
				source,
				mediaId,
				sourceTime,
				settings,
				isPreview: true,
			})
				.then((frame) => {
					this.touchLatestPreviewMask({
						sequenceKey,
						entry: { frame, sourceTime },
					});
					this.notifyMaskInvalidation({
						kind: "preview",
						mediaId,
						sourceTime,
					});
				})
				.catch(() => undefined)
				.finally(() => {
					this.pendingPreviewSequence.delete(sequenceKey);
				});
		}

		const latest = this.latestPreviewMask.get(sequenceKey);
		if (
			!latest ||
			Math.abs(sourceTime - latest.sourceTime) > this.previewMaxReuseGapSeconds
		) {
			return null;
		}
		this.touchLatestPreviewMask({ sequenceKey, entry: latest });
		return latest.frame;
	}

	async prepareMaskFrame({
		groupKey,
		source,
		mediaId,
		sourceTime,
		settings,
		signal,
		temporalSequenceKey,
	}: {
		groupKey: string;
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		signal?: AbortSignal;
		temporalSequenceKey?: string;
	}): Promise<void> {
		throwIfAborted(signal);
		await this.recoverPreparedGroupPersistence({ groupKey });
		await waitForAbortablePromise({
			promise: this.hydratePreparedGroup({ groupKey }),
			signal,
		});
		throwIfAborted(signal);
		const inferenceKey = this.buildInferenceKey({
			mediaId,
			sourceTime,
			settings,
			isPreview: true,
		});
		const existingGroup = this.preparedGroups.get(groupKey);
		if (existingGroup?.frames.has(inferenceKey)) {
			existingGroup.lastUsed = Date.now();
			this.touchPreparedGroup({ groupKey, group: existingGroup });
			return;
		}
		const unavailableMetadata = existingGroup?.frameIndex.get(inferenceKey);
		if (existingGroup && unavailableMetadata) {
			if (existingGroup.totalByteSize > this.maxPreparedAlphaBytes) {
				throw new Error(
					"Prepared matte data exceeds the in-memory cache limit",
				);
			}
			// A manifest entry without a hydrated frame means its chunk is
			// missing or corrupt. Reapply must regenerate it, not dead-end.
			existingGroup.frameIndex.delete(inferenceKey);
			existingGroup.totalByteSize = Math.max(
				0,
				existingGroup.totalByteSize - unavailableMetadata.byteLength,
			);
			existingGroup.complete = false;
			existingGroup.expectedInferenceKeys = null;
		}

		const record = await this.getOrRunSegmentation({
			source,
			mediaId,
			sourceTime,
			settings,
			inferenceKey,
			signal,
			temporalSequenceKey: temporalSequenceKey ?? groupKey,
		});
		throwIfAborted(signal);
		if (
			!this.reservePreparedCapacity({
				additionalBytes: record.alpha.byteLength,
				keepKey: groupKey,
			})
		) {
			throw new Error("Prepared matte data exceeds the in-memory cache limit");
		}

		const group =
			this.preparedGroups.get(groupKey) ??
			createEmptyPreparedMaskGroup({ lastUsed: Date.now() });
		const metadata = {
			inferenceKey,
			width: record.width,
			height: record.height,
			contentHash: record.contentHash,
			byteLength: record.alpha.byteLength,
		} satisfies PreparedMaskFrameMetadata;
		group.frames.set(inferenceKey, record);
		group.frameIndex.set(inferenceKey, metadata);
		group.byteSize += record.alpha.byteLength;
		group.totalByteSize += record.alpha.byteLength;
		group.lastUsed = Date.now();
		group.complete = false;
		group.expectedInferenceKeys = null;
		this.preparedAlphaBytes += record.alpha.byteLength;
		this.touchPreparedGroup({ groupKey, group });
		this.trimPreparedGroupMetadata({ keepKey: groupKey });
		await this.persistPreparedFrame({
			groupKey,
			group,
			frame: { ...metadata, alpha: record.alpha },
		});
		throwIfAborted(signal);
	}

	getPreparedMaskFrame({
		groupKey,
		mediaId,
		sourceTime,
		settings,
	}: {
		groupKey: string;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
	}): BackgroundMaskFrame | null {
		const group = this.preparedGroups.get(groupKey);
		if (!group) {
			void this.hydratePreparedGroup({ groupKey });
			return null;
		}
		const inferenceKey = this.buildInferenceKey({
			mediaId,
			sourceTime,
			settings,
			isPreview: true,
		});
		const record = group.frames.get(inferenceKey);
		if (!record) {
			if (group.frameIndex.has(inferenceKey)) {
				void this.hydratePreparedGroup({ groupKey });
			}
			return null;
		}
		group.lastUsed = Date.now();
		this.touchPreparedGroup({ groupKey, group });
		const renderKey = this.buildPreparedRenderKey({
			groupKey,
			inferenceKey,
			settings,
		});
		const cached = this.cache.get(renderKey);
		if (cached) {
			this.touchRenderCache({ renderKey, frame: cached });
			return cached;
		}
		return this.materializeMaskFrame({ record, renderKey, settings });
	}

	hasPreparedGroup({ groupKey }: { groupKey: string }): boolean {
		const group = this.preparedGroups.get(groupKey);
		if (!group) void this.hydratePreparedGroup({ groupKey });
		return (group?.frameIndex.size ?? 0) > 0;
	}

	isPreparedGroupComplete({
		groupKey,
		expectedInferenceKeys,
	}: {
		groupKey: string;
		expectedInferenceKeys?: readonly string[];
	}): boolean {
		const group = this.preparedGroups.get(groupKey);
		if (!group) void this.hydratePreparedGroup({ groupKey });
		return (
			!this.persistenceErrors.has(groupKey) &&
			group?.complete === true &&
			hasExactExpectedInferenceKeys(group) &&
			(expectedInferenceKeys === undefined ||
				hasSameKeys({
					left: expectedInferenceKeys,
					right: group.expectedInferenceKeys ?? [],
				})) &&
			group.frames.size === group.frameIndex.size &&
			group.frameIndex.size > 0
		);
	}

	markPreparedGroupComplete({
		groupKey,
		expectedInferenceKeys,
	}: {
		groupKey: string;
		expectedInferenceKeys: readonly string[];
	}): void {
		const group = this.preparedGroups.get(groupKey);
		if (!group || group.frameIndex.size === 0) return;
		const normalizedExpectedKeys = [...new Set(expectedInferenceKeys)].sort();
		if (
			normalizedExpectedKeys.length === 0 ||
			!hasSameKeys({
				left: normalizedExpectedKeys,
				right: group.frameIndex.keys(),
			})
		) {
			throw new Error(
				`Prepared matte cadence is incomplete (${group.frameIndex.size}/${normalizedExpectedKeys.length} unique source frames)`,
			);
		}
		group.complete = true;
		group.expectedInferenceKeys = normalizedExpectedKeys;
		group.lastUsed = Date.now();
		this.touchPreparedGroup({ groupKey, group });
		const manifest = this.buildPreparedMaskManifest({ groupKey, group });
		void this.enqueuePersistence({
			groupKey,
			operation: async () => {
				await this.persistence?.putManifest(manifest);
				this.persistedPreparedManifests.set(groupKey, manifest);
				await this.trimPersistedPreparedGroups({ keepKey: groupKey });
			},
		});
		this.notifyMaskInvalidation({ kind: "prepared", groupKey });
	}

	getPreparedInferenceKey({
		mediaId,
		sourceTime,
		settings,
	}: {
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
	}): string {
		return this.buildInferenceKey({
			mediaId,
			sourceTime,
			settings,
			isPreview: true,
		});
	}

	async preparePreparedGroupApply({
		groupKey,
		expectedInferenceKeys,
		temporalSmoothing,
	}: {
		groupKey: string;
		expectedInferenceKeys: readonly string[];
		temporalSmoothing: number;
	}): Promise<{ reusable: boolean }> {
		await this.recoverPreparedGroupPersistence({ groupKey });
		await this.hydratePreparedGroup({ groupKey });
		if (
			this.isPreparedGroupComplete({
				groupKey,
				expectedInferenceKeys,
			})
		) {
			return { reusable: true };
		}
		const group = this.preparedGroups.get(groupKey);
		if (temporalSmoothing > 0 && (group?.frameIndex.size ?? 0) > 0) {
			// A resumed temporal chain cannot be reconstructed from skipped
			// alpha chunks in a fresh worker. Recompute it from the first key.
			await this.deletePreparedGroupDurably({ groupKey });
		}
		return { reusable: false };
	}

	getPreparedGroupFrameCount({ groupKey }: { groupKey: string }): number {
		const group = this.preparedGroups.get(groupKey);
		if (!group) void this.hydratePreparedGroup({ groupKey });
		return group?.frameIndex.size ?? 0;
	}

	discardPreparedGroup({ groupKey }: { groupKey: string }): void {
		const group = this.preparedGroups.get(groupKey);
		if (group) {
			this.preparedAlphaBytes = Math.max(
				0,
				this.preparedAlphaBytes - group.byteSize,
			);
		}
		this.preparedGroups.delete(groupKey);
		void this.enqueuePersistence({
			groupKey,
			clearFailureOnSuccess: true,
			operation: async () => {
				await this.persistence?.deleteGroup(groupKey);
				this.persistedPreparedManifests.delete(groupKey);
			},
		});
	}

	async hydratePreparedGroups(): Promise<void> {
		if (!this.persistence) return;
		if (this.restorePreparedGroupsPromise) {
			return this.restorePreparedGroupsPromise;
		}
		this.restorePreparedGroupsPromise = this.restorePreparedGroups().catch(
			(error: unknown) => {
				this.restorePreparedGroupsPromise = null;
				throw error;
			},
		);
		return this.restorePreparedGroupsPromise;
	}

	async hydratePreparedGroup({
		groupKey,
	}: {
		groupKey: string;
	}): Promise<boolean> {
		if (!this.persistence) return false;
		await this.hydratePreparedGroups();
		await this.persistenceQueue;
		let group = this.preparedGroups.get(groupKey);
		if (!group) {
			const manifest = await this.persistence.getManifest(groupKey);
			if (!manifest || !isUsablePreparedMaskManifest(manifest)) return false;
			this.persistedPreparedManifests.set(groupKey, manifest);
			group = this.registerPreparedMaskManifest(manifest);
		}
		if (
			group.complete &&
			hasExactExpectedInferenceKeys(group) &&
			group.frameIndex.size > 0 &&
			group.frames.size === group.frameIndex.size
		) {
			return true;
		}
		const pending = this.hydratingPreparedGroups.get(groupKey);
		if (pending) return pending;
		const hydration = this.loadPreparedGroupFrames({
			groupKey,
			group,
		}).finally(() => {
			this.hydratingPreparedGroups.delete(groupKey);
		});
		this.hydratingPreparedGroups.set(groupKey, hydration);
		return hydration;
	}

	async flushPreparedMaskPersistence({
		groupKey,
	}: {
		groupKey: string;
	}): Promise<void> {
		await this.persistenceQueue;
		if (!this.persistence) {
			throw new Error(
				"Persistent prepared matte storage is unavailable in this browser",
			);
		}
		const groupError = this.persistenceErrors.get(groupKey);
		if (groupError) throw groupError;
	}

	getPreparedMemoryUsage(): {
		bytes: number;
		reservedBytes: number;
		maxBytes: number;
		groups: number;
	} {
		return {
			bytes: this.preparedAlphaBytes,
			reservedBytes: this.reservedPreparedAlphaBytes,
			maxBytes: this.maxPreparedAlphaBytes,
			groups: this.preparedGroups.size,
		};
	}

	private getOrRunSegmentation({
		source,
		mediaId,
		sourceTime,
		settings,
		inferenceKey,
		signal,
		temporalSequenceKey,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		inferenceKey: string;
		signal?: AbortSignal;
		temporalSequenceKey?: string;
	}): Promise<BackgroundMaskRecord> {
		if (signal) {
			return this.runSegmentation({
				source,
				mediaId,
				sourceTime,
				settings,
				inferenceKey,
				signal,
				temporalSequenceKey,
			});
		}
		const inFlightKey = temporalSequenceKey
			? `${inferenceKey}:sequence=${temporalSequenceKey}`
			: inferenceKey;
		const pending = this.inFlight.get(inFlightKey);
		if (pending) return pending;
		const promise = this.runSegmentation({
			source,
			mediaId,
			sourceTime,
			settings,
			inferenceKey,
			temporalSequenceKey,
		}).finally(() => this.inFlight.delete(inFlightKey));
		this.inFlight.set(inFlightKey, promise);
		return promise;
	}

	private async runSegmentation({
		source,
		mediaId,
		sourceTime,
		settings,
		inferenceKey,
		signal,
		temporalSequenceKey,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		inferenceKey: string;
		signal?: AbortSignal;
		temporalSequenceKey?: string;
	}): Promise<BackgroundMaskRecord> {
		const deadline = Date.now() + this.requestTimeoutMs;
		// Snapshot the mutable video/canvas source before any model-loading await.
		const bitmap = await waitForBoundedPromise({
			promise: this.inferenceBitmapFactory({
				source,
				inputSize: settings.inputSize,
			}),
			signal,
			timeoutMs: remainingTimeUntil(deadline),
			timeoutMessage: `Background removal timed out after ${this.requestTimeoutMs}ms`,
			disposeLateValue: (lateBitmap) => lateBitmap.close(),
		});
		let bitmapTransferred = false;
		try {
			throwIfAborted(signal);
			try {
				await waitForBoundedPromise({
					promise: this.preload(),
					signal,
					timeoutMs: remainingTimeUntil(deadline),
					timeoutMessage: `Background removal timed out after ${this.requestTimeoutMs}ms`,
				});
			} catch (error) {
				if (isTimeoutError(error)) {
					this.resetWorker({
						error,
						nextStatus: { state: "idle" },
					});
				}
				throw error;
			}
			throwIfAborted(signal);
			const worker = this.ensureWorker();
			const generation = this.workerGeneration;
			const requestId = this.nextRequestId++;
			const requestWaitMs = remainingTimeUntil(deadline);
			const result = await new Promise<SegmentCompleteResponse>(
				(resolve, reject) => {
					const onAbort = () => {
						this.failPendingRequest({
							requestId,
							error: createAbortError(),
							restartWorker: true,
						});
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					const timeout = setTimeout(() => {
						this.failPendingRequest({
							requestId,
							error: new Error(
								`Background removal timed out after ${this.requestTimeoutMs}ms`,
							),
							restartWorker: true,
						});
					}, requestWaitMs);
					this.pending.set(requestId, {
						generation,
						resolve,
						reject,
						timeout,
						removeAbortListener: () =>
							signal?.removeEventListener("abort", onAbort),
					});
					try {
						worker.postMessage(
							{
								type: "segment",
								generation,
								requestId,
								bitmap,
								mediaId,
								sourceTime,
								sequenceKey: [
									temporalSequenceKey ?? "live",
									mediaId,
									settings.inputSize,
									settings.maskThreshold.toFixed(3),
									settings.edgeContrast.toFixed(3),
									settings.temporalSmoothing.toFixed(3),
								].join(":"),
								inputSize: settings.inputSize,
								maskThreshold: settings.maskThreshold,
								edgeContrast: settings.edgeContrast,
								temporalSmoothing: settings.temporalSmoothing,
							} satisfies BackgroundRemovalWorkerMessage,
							[bitmap],
						);
						bitmapTransferred = true;
					} catch (error) {
						this.rejectPendingRequest({
							requestId,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					}
				},
			);
			const alpha = new Uint8Array(result.alpha.length);
			alpha.set(result.alpha);
			return {
				alpha,
				width: result.width,
				height: result.height,
				contentHash: `modnet:${inferenceKey}`,
			};
		} finally {
			if (!bitmapTransferred) bitmap.close();
		}
	}

	private materializeMaskFrame({
		record,
		renderKey,
		settings,
	}: {
		record: BackgroundMaskRecord;
		renderKey: string;
		settings: ResolvedBackgroundRemovalSettings;
	}): BackgroundMaskFrame {
		const canvas = new OffscreenCanvas(record.width, record.height);
		const context = canvas.getContext("2d");
		if (!context)
			throw new Error("Unable to create the background mask texture");
		const rgba = new Uint8ClampedArray(record.alpha.length * 4);
		for (let index = 0; index < record.alpha.length; index++) {
			const offset = index * 4;
			rgba[offset] = 255;
			rgba[offset + 1] = 255;
			rgba[offset + 2] = 255;
			rgba[offset + 3] = record.alpha[index] ?? 0;
		}
		context.putImageData(
			new ImageData(rgba, record.width, record.height),
			0,
			0,
		);
		if (settings.edgeFeather > 0) {
			const unfeathered = new OffscreenCanvas(record.width, record.height);
			const unfeatheredContext = unfeathered.getContext("2d");
			if (unfeatheredContext) {
				unfeatheredContext.putImageData(
					new ImageData(rgba, record.width, record.height),
					0,
					0,
				);
				context.clearRect(0, 0, record.width, record.height);
				context.filter = `blur(${settings.edgeFeather}px)`;
				context.drawImage(unfeathered, 0, 0);
				context.filter = "none";
			}
		}
		const frame: BackgroundMaskFrame = {
			canvas,
			width: record.width,
			height: record.height,
			contentHash: `${record.contentHash}:feather=${settings.edgeFeather.toFixed(2)}`,
		};
		this.cache.set(renderKey, frame);
		while (this.cache.size > settings.cacheEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.cache.delete(oldestKey);
		}
		return frame;
	}

	private buildInferenceKey({
		mediaId,
		sourceTime,
		settings,
		isPreview,
	}: {
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		isPreview: boolean;
	}): string {
		const interval = isPreview ? 1 / settings.previewFps : 0;
		const sampledTime =
			interval > 0 ? Math.round(sourceTime / interval) * interval : sourceTime;
		return [
			mediaId,
			sampledTime.toFixed(5),
			settings.inputSize,
			settings.maskThreshold.toFixed(3),
			settings.edgeContrast.toFixed(3),
			settings.temporalSmoothing.toFixed(3),
		].join(":");
	}

	private buildRenderKey({
		inferenceKey,
		settings,
	}: {
		inferenceKey: string;
		settings: ResolvedBackgroundRemovalSettings;
	}): string {
		return `${inferenceKey}:feather=${settings.edgeFeather.toFixed(2)}`;
	}

	private buildPreparedRenderKey({
		groupKey,
		inferenceKey,
		settings,
	}: {
		groupKey: string;
		inferenceKey: string;
		settings: ResolvedBackgroundRemovalSettings;
	}): string {
		return `prepared:${groupKey}:${this.buildRenderKey({
			inferenceKey,
			settings,
		})}`;
	}

	private buildPreviewSequenceKey({
		mediaId,
		settings,
	}: {
		mediaId: string;
		settings: ResolvedBackgroundRemovalSettings;
	}): string {
		return [
			mediaId,
			settings.inputSize,
			settings.maskThreshold.toFixed(3),
			settings.edgeContrast.toFixed(3),
			settings.temporalSmoothing.toFixed(3),
			settings.edgeFeather.toFixed(2),
		].join(":");
	}

	private touchRenderCache({
		renderKey,
		frame,
	}: {
		renderKey: string;
		frame: BackgroundMaskFrame;
	}) {
		this.cache.delete(renderKey);
		this.cache.set(renderKey, frame);
	}

	private touchLatestPreviewMask({
		sequenceKey,
		entry,
	}: {
		sequenceKey: string;
		entry: PreviewMaskEntry;
	}) {
		this.latestPreviewMask.delete(sequenceKey);
		this.latestPreviewMask.set(sequenceKey, entry);
		while (this.latestPreviewMask.size > MAX_PREVIEW_SEQUENCES) {
			const oldestKey = this.latestPreviewMask.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.latestPreviewMask.delete(oldestKey);
		}
	}

	private touchPreparedGroup({
		groupKey,
		group,
	}: {
		groupKey: string;
		group: PreparedMaskGroup;
	}) {
		this.preparedGroups.delete(groupKey);
		this.preparedGroups.set(groupKey, group);
	}

	private reservePreparedCapacity({
		additionalBytes,
		keepKey,
	}: {
		additionalBytes: number;
		keepKey: string;
	}): boolean {
		if (additionalBytes < 0 || additionalBytes > this.maxPreparedAlphaBytes) {
			return false;
		}
		while (
			this.preparedAlphaBytes +
				this.reservedPreparedAlphaBytes +
				additionalBytes >
			this.maxPreparedAlphaBytes
		) {
			const evictable = [...this.preparedGroups.entries()].find(
				([groupKey, group]) => groupKey !== keepKey && group.byteSize > 0,
			);
			if (!evictable) return false;
			this.evictPreparedGroupPersistently({
				groupKey: evictable[0],
				group: evictable[1],
				ownerGroupKey: keepKey,
			});
		}
		return true;
	}

	private evictPreparedGroupFrames(group: PreparedMaskGroup) {
		this.preparedAlphaBytes = Math.max(
			0,
			this.preparedAlphaBytes - group.byteSize,
		);
		group.frames.clear();
		group.byteSize = 0;
	}

	private evictPreparedGroupPersistently({
		groupKey,
		group,
		ownerGroupKey,
	}: {
		groupKey: string;
		group: PreparedMaskGroup;
		ownerGroupKey: string;
	}) {
		this.evictPreparedGroupFrames(group);
		this.preparedGroups.delete(groupKey);
		void this.enqueuePersistence({
			groupKey: ownerGroupKey,
			operation: async () => {
				await this.persistence?.deleteGroup(groupKey);
				this.persistedPreparedManifests.delete(groupKey);
			},
		});
	}

	private trimPreparedGroupMetadata({ keepKey }: { keepKey: string }) {
		while (this.preparedGroups.size > this.maxPreparedGroups) {
			const removable = [...this.preparedGroups.entries()].find(
				([groupKey]) => groupKey !== keepKey,
			);
			if (!removable) break;
			this.evictPreparedGroupPersistently({
				groupKey: removable[0],
				group: removable[1],
				ownerGroupKey: keepKey,
			});
		}
	}

	private buildPreparedMaskManifest({
		groupKey,
		group,
	}: {
		groupKey: string;
		group: PreparedMaskGroup;
	}): PreparedMaskManifest {
		return {
			schemaVersion: PREPARED_MASK_SCHEMA_VERSION,
			groupKey,
			lastUsed: group.lastUsed,
			complete: group.complete,
			expectedInferenceKeys: group.expectedInferenceKeys,
			totalByteSize: group.totalByteSize,
			frames: [...group.frameIndex.values()],
		};
	}

	private async persistPreparedFrame({
		groupKey,
		group,
		frame,
	}: {
		groupKey: string;
		group: PreparedMaskGroup;
		frame: PersistedPreparedMaskFrame;
	}) {
		const manifest = this.buildPreparedMaskManifest({ groupKey, group });
		await this.enqueuePersistence({
			groupKey,
			operation: async () => {
				await this.persistence?.putFrame({
					manifest,
					frame,
				});
				this.persistedPreparedManifests.set(groupKey, manifest);
				await this.trimPersistedPreparedGroups({ keepKey: groupKey });
			},
		});
	}

	private async trimPersistedPreparedGroups({ keepKey }: { keepKey: string }) {
		if (!this.persistence) return;
		const totalBytes = () =>
			[...this.persistedPreparedManifests.values()].reduce(
				(total, manifest) => total + manifest.totalByteSize,
				0,
			);
		while (
			this.persistedPreparedManifests.size > this.maxPreparedGroups ||
			totalBytes() > this.maxPreparedAlphaBytes
		) {
			const oldest = [...this.persistedPreparedManifests.values()]
				.filter((manifest) => manifest.groupKey !== keepKey)
				.sort((left, right) => left.lastUsed - right.lastUsed)[0];
			if (!oldest) {
				throw new Error(
					"Prepared matte data exceeds the persistent cache limit",
				);
			}
			await this.persistence.deleteGroup(oldest.groupKey);
			this.persistedPreparedManifests.delete(oldest.groupKey);
			const group = this.preparedGroups.get(oldest.groupKey);
			if (group) this.evictPreparedGroupFrames(group);
			this.preparedGroups.delete(oldest.groupKey);
		}
	}

	private enqueuePersistence({
		groupKey,
		operation,
		clearFailureOnSuccess = false,
	}: {
		groupKey: string;
		operation: () => Promise<void> | undefined;
		clearFailureOnSuccess?: boolean;
	}): Promise<void> {
		if (!this.persistence) {
			this.persistenceErrors.set(
				groupKey,
				new Error(
					"Persistent prepared matte storage is unavailable in this browser",
				),
			);
			return Promise.resolve();
		}
		const queued = this.persistenceQueue.then(async () => {
			await operation();
			if (clearFailureOnSuccess) this.persistenceErrors.delete(groupKey);
		});
		this.persistenceQueue = queued.catch((error: unknown) => {
			this.persistenceErrors.set(
				groupKey,
				error instanceof Error ? error : new Error(String(error)),
			);
		});
		return this.persistenceQueue;
	}

	private async recoverPreparedGroupPersistence({
		groupKey,
	}: {
		groupKey: string;
	}) {
		if (!this.persistenceErrors.has(groupKey)) return;
		await this.deletePreparedGroupDurably({ groupKey });
	}

	private async deletePreparedGroupDurably({ groupKey }: { groupKey: string }) {
		await this.persistenceQueue;
		if (!this.persistence) {
			throw new Error(
				"Persistent prepared matte storage is unavailable in this browser",
			);
		}
		try {
			await this.persistence.deleteGroup(groupKey);
		} catch (error) {
			const persistenceError =
				error instanceof Error ? error : new Error(String(error));
			this.persistenceErrors.set(groupKey, persistenceError);
			throw persistenceError;
		}
		this.persistenceErrors.delete(groupKey);
		this.persistedPreparedManifests.delete(groupKey);
		const group = this.preparedGroups.get(groupKey);
		if (group) this.evictPreparedGroupFrames(group);
		this.preparedGroups.delete(groupKey);
	}

	private async restorePreparedGroups() {
		if (!this.persistence) return;
		await this.persistenceQueue;
		const [storedGroupKeys, listedManifests] = await Promise.all([
			this.persistence.listGroupKeys(),
			this.persistence.listManifests(),
		]);
		const manifests = listedManifests
			.filter(isUsablePreparedMaskManifest)
			.sort((left, right) => right.lastUsed - left.lastUsed);
		const keptManifests: PreparedMaskManifest[] = [];
		let keptBytes = 0;
		for (const manifest of manifests) {
			if (
				keptManifests.length >= this.maxPreparedGroups ||
				keptBytes + manifest.totalByteSize > this.maxPreparedAlphaBytes
			) {
				continue;
			}
			keptManifests.push(manifest);
			keptBytes += manifest.totalByteSize;
		}
		const keptKeys = new Set(
			keptManifests.map((manifest) => manifest.groupKey),
		);
		const staleKeys = storedGroupKeys.filter((key) => !keptKeys.has(key));
		for (const groupKey of staleKeys) {
			await this.persistence.deleteGroup(groupKey);
			const group = this.preparedGroups.get(groupKey);
			if (group) this.evictPreparedGroupFrames(group);
			this.preparedGroups.delete(groupKey);
		}
		this.persistedPreparedManifests.clear();
		for (const manifest of keptManifests) {
			this.persistedPreparedManifests.set(manifest.groupKey, manifest);
		}
		for (const manifest of [...keptManifests].reverse()) {
			this.registerPreparedMaskManifest(manifest);
		}
		const newest = keptManifests[0];
		if (!newest) return;
		const group = this.preparedGroups.get(newest.groupKey);
		if (!group) return;
		await this.loadPreparedGroupFrames({
			groupKey: newest.groupKey,
			group,
		});
	}

	private registerPreparedMaskManifest(
		manifest: PreparedMaskManifest,
	): PreparedMaskGroup {
		const existing = this.preparedGroups.get(manifest.groupKey);
		if (existing) return existing;
		const frameIndex = new Map(
			manifest.frames.map((frame) => [frame.inferenceKey, frame]),
		);
		const group = {
			frames: new Map<string, BackgroundMaskRecord>(),
			frameIndex,
			byteSize: 0,
			totalByteSize: manifest.totalByteSize,
			lastUsed: manifest.lastUsed,
			complete: manifest.complete,
			expectedInferenceKeys: manifest.expectedInferenceKeys,
		} satisfies PreparedMaskGroup;
		this.touchPreparedGroup({ groupKey: manifest.groupKey, group });
		this.trimPreparedGroupMetadata({ keepKey: manifest.groupKey });
		return group;
	}

	private async loadPreparedGroupFrames({
		groupKey,
		group,
	}: {
		groupKey: string;
		group: PreparedMaskGroup;
	}): Promise<boolean> {
		if (!this.persistence || group.frameIndex.size === 0) return false;
		const missingFrames = [...group.frameIndex.values()].filter(
			(metadata) => !group.frames.has(metadata.inferenceKey),
		);
		if (missingFrames.length === 0) {
			return group.complete && hasExactExpectedInferenceKeys(group);
		}
		const missingBytes = missingFrames.reduce(
			(total, frame) => total + frame.byteLength,
			0,
		);
		if (
			!this.reservePreparedCapacity({
				additionalBytes: missingBytes,
				keepKey: groupKey,
			})
		) {
			return false;
		}
		this.reservedPreparedAlphaBytes += missingBytes;
		let reservedBytesRemaining = missingBytes;
		const loadedKeys: string[] = [];
		try {
			for (const metadata of missingFrames) {
				const frame = await this.persistence.getFrame({
					groupKey,
					inferenceKey: metadata.inferenceKey,
				});
				if (
					!frame ||
					frame.byteLength !== metadata.byteLength ||
					frame.alpha.byteLength !== metadata.byteLength
				) {
					throw new Error("A persisted prepared matte chunk is unavailable");
				}
				reservedBytesRemaining -= frame.byteLength;
				this.reservedPreparedAlphaBytes = Math.max(
					0,
					this.reservedPreparedAlphaBytes - frame.byteLength,
				);
				group.frames.set(frame.inferenceKey, {
					alpha: frame.alpha,
					width: frame.width,
					height: frame.height,
					contentHash: frame.contentHash,
				});
				loadedKeys.push(frame.inferenceKey);
				group.byteSize += frame.byteLength;
				this.preparedAlphaBytes += frame.byteLength;
			}
			group.lastUsed = Date.now();
			this.touchPreparedGroup({ groupKey, group });
			const touchedManifest = this.buildPreparedMaskManifest({
				groupKey,
				group,
			});
			await this.enqueuePersistence({
				groupKey,
				operation: async () => {
					await this.persistence?.putManifest(touchedManifest);
					this.persistedPreparedManifests.set(groupKey, touchedManifest);
					await this.trimPersistedPreparedGroups({ keepKey: groupKey });
				},
			});
			const complete =
				group.complete &&
				hasExactExpectedInferenceKeys(group) &&
				group.frames.size === group.frameIndex.size;
			if (complete) {
				this.notifyMaskInvalidation({ kind: "prepared", groupKey });
			}
			return complete;
		} catch {
			for (const inferenceKey of loadedKeys) {
				const frame = group.frames.get(inferenceKey);
				if (!frame) continue;
				group.frames.delete(inferenceKey);
				group.byteSize = Math.max(0, group.byteSize - frame.alpha.byteLength);
				this.preparedAlphaBytes = Math.max(
					0,
					this.preparedAlphaBytes - frame.alpha.byteLength,
				);
			}
			return false;
		} finally {
			this.reservedPreparedAlphaBytes = Math.max(
				0,
				this.reservedPreparedAlphaBytes - reservedBytesRemaining,
			);
		}
	}

	private restartInitializationWithWasm() {
		this.initializationFallbackTimer = null;
		if (this.status.state !== "loading" || !this.initialization) return;
		this.terminateCurrentWorker();
		const worker = this.ensureWorker();
		const generation = this.workerGeneration;
		this.setStatus({
			state: "loading",
			progress: Math.max(20, this.status.progress),
		});
		worker.postMessage({
			type: "init",
			generation,
			backend: "wasm",
		} satisfies BackgroundRemovalWorkerMessage);
		this.initializationFallbackTimer = setTimeout(() => {
			const error = new Error(
				`Background removal model startup timed out after ${WASM_STARTUP_TIMEOUT_MS}ms`,
			);
			this.resetWorker({
				error,
				nextStatus: { state: "error", message: error.message },
			});
		}, WASM_STARTUP_TIMEOUT_MS);
	}

	private clearInitializationFallbackTimer() {
		if (this.initializationFallbackTimer === null) return;
		clearTimeout(this.initializationFallbackTimer);
		this.initializationFallbackTimer = null;
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		this.workerGeneration++;
		this.worker = this.workerFactory();
		this.worker.addEventListener("message", this.handleMessage);
		this.worker.addEventListener("error", this.handleWorkerError);
		return this.worker;
	}

	private terminateCurrentWorker() {
		if (!this.worker) {
			this.workerGeneration++;
			return;
		}
		this.worker.removeEventListener("message", this.handleMessage);
		this.worker.removeEventListener("error", this.handleWorkerError);
		this.worker.terminate();
		this.worker = null;
		this.workerGeneration++;
	}

	private resetWorker({
		error,
		nextStatus,
	}: {
		error: Error;
		nextStatus: BackgroundRemovalModelStatus;
	}) {
		this.clearInitializationFallbackTimer();
		this.rejectInitialization?.(error);
		this.resolveInitialization = null;
		this.rejectInitialization = null;
		this.initialization = null;
		for (const [requestId] of this.pending) {
			this.rejectPendingRequest({ requestId, error });
		}
		this.pending.clear();
		this.terminateCurrentWorker();
		this.setStatus(nextStatus);
	}

	private failPendingRequest({
		requestId,
		error,
		restartWorker,
	}: {
		requestId: number;
		error: Error;
		restartWorker: boolean;
	}) {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		if (pending.generation === this.workerGeneration && this.worker !== null) {
			try {
				this.worker.postMessage({
					type: "cancel",
					generation: pending.generation,
					requestId,
				} satisfies BackgroundRemovalWorkerMessage);
			} catch {
				// A failed cancellation is followed by terminating the generation.
			}
		}
		this.rejectPendingRequest({ requestId, error });
		if (restartWorker) {
			this.resetWorker({
				error,
				nextStatus: { state: "idle" },
			});
		}
	}

	private rejectPendingRequest({
		requestId,
		error,
	}: {
		requestId: number;
		error: Error;
	}) {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timeout);
		pending.removeAbortListener();
		pending.reject(error);
	}

	private handleWorkerError = (event: ErrorEvent) => {
		const error = new Error(
			event.message || "Background removal worker failed",
		);
		this.resetWorker({
			error,
			nextStatus: { state: "error", message: error.message },
		});
	};

	private handleMessage = (
		event: MessageEvent<BackgroundRemovalWorkerResponse>,
	) => {
		const response = event.data;
		if (response.generation !== this.workerGeneration) return;
		switch (response.type) {
			case "model-progress":
				this.setStatus({ state: "loading", progress: response.progress });
				break;
			case "model-ready":
				this.clearInitializationFallbackTimer();
				this.setStatus({ state: "ready", backend: response.backend });
				this.resolveInitialization?.();
				this.resolveInitialization = null;
				this.rejectInitialization = null;
				break;
			case "model-error": {
				const error = new Error(response.error);
				this.resetWorker({
					error,
					nextStatus: { state: "error", message: response.error },
				});
				break;
			}
			case "segment-complete": {
				const pending = this.pending.get(response.requestId);
				if (!pending || pending.generation !== response.generation) return;
				this.pending.delete(response.requestId);
				clearTimeout(pending.timeout);
				pending.removeAbortListener();
				pending.resolve(response);
				break;
			}
			case "segment-error":
				this.rejectPendingRequest({
					requestId: response.requestId,
					error: new Error(response.error),
				});
				break;
		}
	};

	private notifyMaskInvalidation(invalidation: BackgroundMaskInvalidation) {
		this.invalidationListeners.forEach((listener) => listener(invalidation));
		// Status consumers also include the smart-layer properties panel. Clone
		// the semantic snapshot so useSyncExternalStore observes cache hydration.
		this.status = { ...this.status };
		this.listeners.forEach((listener) => listener());
	}

	private setStatus(status: BackgroundRemovalModelStatus) {
		this.status = status;
		this.listeners.forEach((listener) => listener());
	}
}

export const backgroundRemovalService = new BackgroundRemovalService();

async function createInferenceBitmap({
	source,
	inputSize,
}: {
	source: CanvasImageSource;
	inputSize: number;
}): Promise<ImageBitmap> {
	const original = await createImageBitmap(source);
	const shortestSide = Math.min(original.width, original.height);
	if (shortestSide <= inputSize) return original;
	const scale = inputSize / shortestSide;
	const resizeWidth = Math.max(1, Math.round(original.width * scale));
	const resizeHeight = Math.max(1, Math.round(original.height * scale));
	try {
		const resized = await createImageBitmap(original, {
			resizeWidth,
			resizeHeight,
			resizeQuality: "high",
		});
		original.close();
		return resized;
	} catch {
		const canvas = new OffscreenCanvas(resizeWidth, resizeHeight);
		const context = canvas.getContext("2d");
		if (!context) {
			original.close();
			throw new Error("Unable to resize the background-removal input");
		}
		context.drawImage(original, 0, 0, resizeWidth, resizeHeight);
		original.close();
		return createImageBitmap(canvas);
	}
}

function createEmptyPreparedMaskGroup({
	lastUsed,
}: {
	lastUsed: number;
}): PreparedMaskGroup {
	return {
		frames: new Map(),
		frameIndex: new Map(),
		byteSize: 0,
		totalByteSize: 0,
		lastUsed,
		complete: false,
		expectedInferenceKeys: null,
	};
}

function isUsablePreparedMaskManifest(manifest: PreparedMaskManifest): boolean {
	if (
		manifest.schemaVersion !== PREPARED_MASK_SCHEMA_VERSION ||
		manifest.groupKey.length === 0 ||
		(manifest.expectedInferenceKeys !== null &&
			(manifest.expectedInferenceKeys.length === 0 ||
				new Set(manifest.expectedInferenceKeys).size !==
					manifest.expectedInferenceKeys.length)) ||
		(manifest.complete &&
			!hasSameKeys({
				left: manifest.expectedInferenceKeys ?? [],
				right: manifest.frames.map((frame) => frame.inferenceKey),
			})) ||
		!Number.isFinite(manifest.totalByteSize) ||
		manifest.totalByteSize < 0
	) {
		return false;
	}
	let byteSize = 0;
	const keys = new Set<string>();
	for (const frame of manifest.frames) {
		if (
			frame.inferenceKey.length === 0 ||
			keys.has(frame.inferenceKey) ||
			!Number.isInteger(frame.width) ||
			frame.width <= 0 ||
			!Number.isInteger(frame.height) ||
			frame.height <= 0 ||
			!Number.isInteger(frame.byteLength) ||
			frame.byteLength <= 0
		) {
			return false;
		}
		keys.add(frame.inferenceKey);
		byteSize += frame.byteLength;
	}
	return byteSize === manifest.totalByteSize;
}

function hasExactExpectedInferenceKeys(group: PreparedMaskGroup): boolean {
	return (
		group.expectedInferenceKeys !== null &&
		hasSameKeys({
			left: group.expectedInferenceKeys,
			right: group.frameIndex.keys(),
		})
	);
}

function hasSameKeys({
	left,
	right,
}: {
	left: Iterable<string>;
	right: Iterable<string>;
}): boolean {
	const leftKeys = [...left].sort();
	const rightKeys = [...right].sort();
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key, index) => key === rightKeys[index]);
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (!signal?.aborted) return;
	throw createAbortError();
}

function createAbortError(): DOMException {
	return new DOMException("Background removal was cancelled", "AbortError");
}

function waitForAbortablePromise<T>({
	promise,
	signal,
}: {
	promise: Promise<T>;
	signal: AbortSignal | undefined;
}): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function waitForBoundedPromise<T>({
	promise,
	signal,
	timeoutMs,
	timeoutMessage,
	disposeLateValue,
}: {
	promise: Promise<T>;
	signal: AbortSignal | undefined;
	timeoutMs: number;
	timeoutMessage: string;
	disposeLateValue?: (value: T) => void;
}): Promise<T> {
	if (signal?.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (
			result: { kind: "value"; value: T } | { kind: "error"; error: unknown },
		) => {
			if (settled) {
				if (result.kind === "value") {
					disposeLateValue?.(result.value);
				}
				return;
			}
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (result.kind === "error") {
				reject(result.error);
			} else {
				resolve(result.value);
			}
		};
		const onAbort = () => finish({ kind: "error", error: createAbortError() });
		const timeout = setTimeout(
			() =>
				finish({
					kind: "error",
					error: createTimeoutError(timeoutMessage),
				}),
			Math.max(1, timeoutMs),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => finish({ kind: "value", value }),
			(error: unknown) => finish({ kind: "error", error }),
		);
	});
}

function remainingTimeUntil(deadline: number): number {
	return Math.max(1, deadline - Date.now());
}

function createTimeoutError(message: string): Error {
	const error = new Error(message);
	error.name = "TimeoutError";
	return error;
}

function isTimeoutError(error: unknown): error is Error {
	return error instanceof Error && error.name === "TimeoutError";
}

function normalizePositiveNumber({
	value,
	fallback,
}: {
	value: number | undefined;
	fallback: number;
}): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}
