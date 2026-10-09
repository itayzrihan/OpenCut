import type { EditorCore } from "@/core";
import type { PlaybackPreparationContext } from "@/core/managers/playback-manager";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer, type AudioClipSource } from "@/media/audio";
import { getClipAudioTiming } from "@/media/audio-sync";
import { resolveEffectiveAudioGain } from "@/timeline/audio-state";
import { formatTimecode, mediaMissingUsed } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import {
	addMediaTime,
	mediaTime,
	mediaTimeToSeconds,
	roundMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { ParallaxSceneNode } from "@/services/renderer/nodes/parallax-scene-node";
import { videoCache } from "@/services/video-cache/service";
import { getSourceTimeAtClipTime } from "@/retime";
import { mapParallaxParentTimeToSourceTime } from "@/parallax-story-teller/camera-geometry";
import { HyperframesRenderCache } from "@/hyperframes/render-cache";
import type { HyperframesRenderContext } from "@/hyperframes/types";

export type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private renderTreeRevision = 0;
	private invalidatedRenderTreeRevision = -1;
	private renderTreeWaiters = new Set<() => void>();
	private _isDegraded = false;
	private _isExporting = false;
	private listeners = new Set<() => void>();
	private readonly hyperframesCache = new HyperframesRenderCache();
	private hyperframesScopeDisposers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		const refreshHyperframes = () => {
			if (this.updateHyperframesCache()) this.notify();
		};
		this.hyperframesScopeDisposers.push(
			this.editor.project.subscribe(refreshHyperframes),
			this.editor.media.subscribe(refreshHyperframes),
		);
		const invalidateRenderTree = () => {
			this.invalidatedRenderTreeRevision = this.renderTreeRevision;
		};
		this.editor.timeline.subscribe(invalidateRenderTree);
		this.editor.scenes.subscribe(invalidateRenderTree);
		this.editor.playback.registerPlaybackPreparer({
			id: "preview-video-frames",
			prepare: this.preparePlaybackFrames,
		});
	}

	getHyperframesRenderContext(): HyperframesRenderContext | undefined {
		this.updateHyperframesCache();
		return this.hyperframesCache.getContext(
			this.editor.project.getActiveOrNull(),
		);
	}

	async readHyperframesManifest({
		assetId,
		signal,
	}: {
		assetId: string;
		signal?: AbortSignal;
	}) {
		this.updateHyperframesCache();
		return this.hyperframesCache.readManifest({
			project: this.editor.project.getActive(),
			assetId,
			signal,
		});
	}

	async readHyperframesAudioClips({
		sceneId,
		signal,
	}: {
		sceneId: string;
		signal?: AbortSignal;
	}): Promise<AudioClipSource[]> {
		this.updateHyperframesCache();
		const project = this.editor.project.getActive();
		if (!Object.keys(project.hyperframesCompositions ?? {}).length) return [];
		const projection = await this.editor.command.readHyperframesAudioClips({
			projectId: project.metadata.id,
			sceneId,
		});
		signal?.throwIfAborted();
		const files = new Map<string, Promise<File | null>>();
		const clips = await Promise.all(
			projection.clips.map(
				async ({ compositionId, element }): Promise<AudioClipSource | null> => {
					let pending = files.get(compositionId);
					if (!pending) {
						pending = this.hyperframesCache.readAudio({
							project,
							assetId: compositionId,
							signal,
						});
						files.set(compositionId, pending);
					}
					const file = await pending;
					if (!file) return null;
					const sourceKey = `hyperframes:${project.metadata.id}:${file.name}`;
					return {
						timelineElement: element,
						id: element.id,
						sourceKey,
						file,
						mediaAsset: {
							id: sourceKey,
							name: element.name,
							type: "audio",
							file,
							duration: (element.sourceDuration ?? 0) / TICKS_PER_SECOND,
						},
						...getClipAudioTiming(element),
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({ element, localTime: 0 }),
						muted: false,
					};
				},
			),
		);
		signal?.throwIfAborted();
		return clips.filter((clip): clip is AudioClipSource => clip !== null);
	}

	private updateHyperframesCache(): boolean {
		return this.hyperframesCache.update({
			project: this.editor.project.getActiveOrNull(),
			mediaAssets: this.editor.media.getAssets(),
		});
	}

	getHyperframesResourceRevision(): number {
		return this.hyperframesCache.revision;
	}

	resetHyperframesRendering(): void {
		this.hyperframesCache.reset();
	}

	dispose(): void {
		this.hyperframesCache.dispose();
		for (const dispose of this.hyperframesScopeDisposers) dispose();
		this.hyperframesScopeDisposers = [];
	}

	private preparePlaybackFrames = async ({
		time,
		lookaheadSeconds,
		signal,
	}: PlaybackPreparationContext): Promise<void> => {
		await this.waitForFreshRenderTree({ signal });
		const renderTree = this.renderTree;
		const fps = this.editor.project.getActive()?.settings.fps;
		if (!renderTree || !fps || signal.aborted) return;

		const framesPerSecond = fps.numerator / fps.denominator;
		const warmupSeconds = Math.min(1, lookaheadSeconds);
		const frameCount = Math.max(
			1,
			// CanvasSink uses a bounded canvas pool. Warming a compact rolling
			// window avoids both startup stalls and hundreds of megabytes of decoded
			// frames while still covering normal compositor jitter.
			Math.min(8, Math.ceil(warmupSeconds * framesPerSecond)),
		);
		const frameDuration = mediaTime({
			ticks: Math.max(1, Math.round(TICKS_PER_SECOND / framesPerSecond)),
		});

		for (let index = 0; index < frameCount; index++) {
			if (signal.aborted) return;
			const frameTime = addMediaTime({
				a: time,
				b: mediaTime({ ticks: frameDuration * index }),
			});
			const requests = collectVideoFrameRequestsAtTime({
				node: renderTree,
				time: frameTime,
			});
			await Promise.all(
				requests.map((request) =>
					videoCache.getFrameAt({
						mediaId: request.mediaId,
						file: request.file,
						url: request.url,
						maxSourceSize: request.maxSourceSize,
						time: request.sourceTime,
					}),
				),
			);
		}
	};

	private waitForFreshRenderTree({ signal }: { signal: AbortSignal }) {
		if (
			this.renderTree &&
			this.renderTreeRevision > this.invalidatedRenderTreeRevision
		) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeoutId);
				signal.removeEventListener("abort", finish);
				this.renderTreeWaiters.delete(finish);
				resolve();
			};
			const timeoutId = window.setTimeout(finish, 750);
			this.renderTreeWaiters.add(finish);
			signal.addEventListener("abort", finish, { once: true });
		});
	}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	get isExporting(): boolean {
		return this._isExporting;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.renderTreeRevision++;
		for (const resolve of [...this.renderTreeWaiters]) resolve();
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async captureSnapshot(): Promise<SnapshotResult> {
		return this.createSnapshot();
	}

	async capturePreviewFrameAt({
		time,
		maxDimension = 512,
		maxBytes = 90_000,
	}: {
		time: MediaTime;
		maxDimension?: number;
		maxBytes?: number;
	}): Promise<SnapshotResult> {
		return this.createSnapshot({
			time,
			maxDimension: Math.max(128, Math.min(1_024, Math.floor(maxDimension))),
			mimeType: "image/jpeg",
			maxBytes: Math.max(16_000, Math.min(250_000, Math.floor(maxBytes))),
		});
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot({
		time,
		maxDimension,
		mimeType = "image/png",
		maxBytes,
	}: {
		time?: MediaTime;
		maxDimension?: number;
		mimeType?: "image/png" | "image/jpeg";
		maxBytes?: number;
	} = {}): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = mediaTime({
				ticks: Math.max(
					0,
					Math.min(
						time ?? this.editor.playback.getCurrentTime(),
						this.editor.timeline.getLastFrameTime(),
					),
				),
			});

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			const outputScale = maxDimension
				? Math.min(
						1,
						maxDimension / Math.max(canvasSize.width, canvasSize.height),
					)
				: 1;
			tempCanvas.width = Math.max(
				1,
				Math.round(canvasSize.width * outputScale),
			);
			tempCanvas.height = Math.max(
				1,
				Math.round(canvasSize.height * outputScale),
			);

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await encodeCanvasBlob({
				canvas: tempCanvas,
				mimeType,
				maxBytes,
			});

			if (!blob) {
				return {
					success: false,
					error: maxBytes
						? `Failed to create preview image within ${maxBytes} bytes`
						: "Failed to create image",
				};
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(
				/:/g,
				"-",
			);
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		if (this._isExporting) {
			return { success: false, error: "An export is already running" };
		}
		this.setExporting(true);
		const releasePlayback = this.editor.playback.suspend();
		const { format, quality, fps, includeAudio } = options;
		const cancellation = new AbortController();
		let exporter: SceneExporter | undefined;
		const cancelInterval = setInterval(() => {
			if (!cancellation.signal.aborted && onCancel?.()) {
				cancellation.abort();
				exporter?.cancel();
				this.resetHyperframesRendering();
			}
		}, 100);

		try {
			const activeScene = this.editor.scenes.getActiveScene();
			const tracks = activeScene.tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();
			const missing: string[] = JSON.parse(
				mediaMissingUsed({
					projectJson: JSON.stringify(this.editor.scenes.getScenes()),
					assetsJson: JSON.stringify(mediaAssets),
				}),
			);
			if (missing.length)
				return {
					success: false,
					error: `Link missing source files before export: ${missing.join(", ")}. Your edits are saved.`,
				};

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;
			const hyperframes = this.getHyperframesRenderContext();

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
					additionalClips: await this.readHyperframesAudioClips({
						sceneId: activeScene.id,
						signal: cancellation.signal,
					}),
				});
			}
			cancellation.signal.throwIfAborted();
			if (
				this.editor.project.getActiveOrNull()?.metadata.id !==
					activeProject.metadata.id ||
				this.editor.project.getActiveOrNull()?.hyperframesCompositions !==
					activeProject.hyperframesCompositions ||
				this.editor.scenes.getActiveSceneOrNull()?.tracks !== tracks
			)
				throw new Error(
					"The project changed while preparing export. Start the export again.",
				);

			const scene = buildScene({
				hyperframes,
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
				scenes: this.editor.scenes.getScenes(),
				activeSceneId: this.editor.scenes.getActiveScene().id,
			});

			exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			try {
				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancellation.signal.aborted) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			if (cancellation.signal.aborted)
				return { success: false, cancelled: true };
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		} finally {
			clearInterval(cancelInterval);
			try {
				this.setExporting(false);
			} finally {
				releasePlayback();
			}
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private setExporting(isExporting: boolean): void {
		if (this._isExporting === isExporting) return;
		this._isExporting = isExporting;
		this.notify();
	}
}

interface VideoFrameRequest {
	mediaId: string;
	file?: File;
	url?: string;
	maxSourceSize?: number;
	sourceTime: number;
}

export function collectVideoFrameRequestsAtTime({
	node,
	time,
}: {
	node: AnyBaseNode;
	time: MediaTime;
}): VideoFrameRequest[] {
	if (node instanceof VideoNode) {
		const localTime = time - node.params.timeOffset;
		if (localTime < 0 || localTime >= node.params.duration) return [];
		const sourceTime = addMediaTime({
			a: mediaTime({ ticks: node.params.trimStart }),
			b: mediaTime({
				ticks: getSourceTimeAtClipTime({
					clipTime: mediaTime({ ticks: localTime }),
					retime: node.params.retime,
				}),
			}),
		});
		return [
			{
				mediaId: node.params.mediaId,
				file: node.params.file,
				url: node.params.url,
				maxSourceSize: node.params.maxSourceSize,
				sourceTime: mediaTimeToSeconds({ time: sourceTime }),
			},
		];
	}

	if (
		node instanceof ParallaxSceneNode &&
		(time < node.params.timeOffset ||
			time >= node.params.timeOffset + node.params.duration)
	) {
		return [];
	}
	const childTime =
		node instanceof ParallaxSceneNode
			? roundMediaTime({
					time: mapParallaxParentTimeToSourceTime({
						time,
						timeOffset: node.params.timeOffset,
						duration: node.params.duration,
						sourceDuration: node.params.sourceDuration,
					}),
				})
			: time;

	return node.children.flatMap((child) =>
		collectVideoFrameRequestsAtTime({ node: child, time: childTime }),
	);
}

async function encodeCanvasBlob({
	canvas,
	mimeType,
	maxBytes,
}: {
	canvas: HTMLCanvasElement;
	mimeType: "image/png" | "image/jpeg";
	maxBytes?: number;
}): Promise<Blob | null> {
	const qualities: Array<number | undefined> =
		mimeType === "image/jpeg" ? [0.72, 0.56, 0.42, 0.3, 0.2] : [undefined];
	for (const quality of qualities) {
		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((result) => resolve(result), mimeType, quality);
		});
		if (blob && (maxBytes === undefined || blob.size <= maxBytes)) {
			return blob;
		}
	}
	return null;
}
