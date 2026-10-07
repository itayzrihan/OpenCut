/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Rust validates the live registry contracts before returning these JSON projections. */
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type {
	EditingAgentCommand,
	EditingAgentProviderRequest,
	EditingAgentProviderRound,
	EditingAgentReviewPlan,
	EditingAgentReviewResult,
	EditingAgentReviewRequest,
	EditingAgentSnapshot,
} from "@/core/agent-protocol";
import type { MediaAsset } from "@/media/types";
import type { SerializedProjectHistorySnapshot } from "@/services/storage/types";
import type {
	HyperframesSource,
	HyperframesRuntimeManifest,
} from "@/hyperframes/types";

export interface CanonicalClassicSnapshot {
	document: SerializedProjectHistorySnapshot;
	mediaAssets: Array<Omit<MediaAsset, "file" | "url" | "thumbnailUrl">>;
}

export type CanonicalSilenceOperation =
	| "smart-remove"
	| "restore"
	| "repair-captions";

export interface ClassicTransitionApplication {
	trackId: string;
	elementId: string;
	presetId: string;
	side: "in" | "out";
	percent?: number;
	duration?: import("@/wasm").MediaTime;
}

export type ClassicTrackChange =
	| { type: "set"; name?: string; muted?: boolean; hidden?: boolean }
	| { type: "toggleMute" }
	| { type: "toggleVisibility" }
	| {
			type: "parallax";
			direction?: import("@/timeline/types").ParallaxTrackDirection;
			speedPercent?: number;
	  };

export interface ClassicSourceAudioChange {
	trackId: string;
	elementId: string;
	action: "extract" | "recover" | "toggle";
}

export type ClassicElementControlChange =
	| { type: "setHidden" | "setMuted"; value: boolean }
	| { type: "toggleVisibility" | "toggleMute" };

export type ClassicMaskChange =
	| {
			type: "create";
			maskType: string;
			params?: Record<string, unknown>;
			elementSize?: { width: number; height: number };
	  }
	| { type: "update"; params: Record<string, unknown> }
	| { type: "remove" }
	| { type: "toggleInverted" }
	| { type: "setInverted"; inverted: boolean }
	| { type: "deletePoints"; pointIds: string[] }
	| {
			type: "insertPoint";
			segmentIndex: number;
			canvasPoint: { x: number; y: number };
			bounds: import("@/preview/element-bounds").ElementBounds;
	  };

export interface ClassicKeyframeEdit {
	trackId: string;
	elementId: string;
	propertyPath: string;
	keyframeId: string;
	change:
		| { type: "retime"; time: number }
		| {
				type: "curve";
				componentKey: string;
				patch: import("@/animation/types").ScalarCurveKeyframePatch;
		  };
}

export interface ClassicKeyframeRemoval {
	trackId: string;
	elementId: string;
	propertyPath: string;
	keyframeId: string;
}

export interface ClassicKeyframeUpsert {
	trackId: string;
	elementId: string;
	propertyPath: string;
	time: number;
	value: import("@/params").ParamValue;
	interpolation?: import("@/animation/types").AnimationInterpolation;
	keyframeId?: string;
}

export type ClassicEffectChange =
	| {
			type: "add";
			effectType: string;
			params?: Partial<import("@/params").ParamValues>;
			allowCustomFallback?: boolean;
	  }
	| {
			type: "update";
			effectId: string;
			params: Partial<import("@/params").ParamValues>;
	  }
	| { type: "toggle" | "remove"; effectId: string }
	| { type: "setEnabled"; effectId: string; enabled: boolean }
	| { type: "reorder"; fromIndex: number; toIndex: number };

export type ClassicSceneChange =
	| {
			type: "create";
			sceneId: string;
			mainTrackId: string;
			name: string;
			isMain: boolean;
	  }
	| { type: "rename"; sceneId: string; name: string }
	| { type: "select"; sceneId: string }
	| { type: "delete"; sceneId: string };

export type ClassicBookmarkChange =
	| { type: "toggle" | "remove"; time: number }
	| { type: "move"; fromTime: number; toTime: number }
	| {
			type: "update";
			time: number;
			updates: Partial<Omit<import("@/timeline/types").Bookmark, "time">> & {
				clear?: Array<"note" | "color" | "duration" | "groupId">;
			};
	  }
	| { type: "replace"; bookmarks: import("@/timeline/types").Bookmark[] };

export type ClassicTrackLayoutChange =
	| {
			type: "add";
			trackId: string;
			trackType: import("@/timeline/types").TrackType;
			name?: string;
			index?: number;
	  }
	| { type: "reorder"; trackId: string; toIndex: number };

export type ClassicRemoval =
	| {
			type: "elements";
			elements: Array<{ trackId: string; elementId: string }>;
	  }
	| { type: "track"; trackId: string };

export interface CanonicalHistoryBoundary {
	label: string;
	classic: CanonicalClassicSnapshot;
	hostContext: Record<string, unknown>;
}

/** Opaque persisted protocol; only Rust resolves source references in this archive. */
export interface CanonicalHistoryArchive {
	schemaVersion: number;
	projectId: string;
	revision: number;
	classic: unknown;
	undoStack: unknown[];
	redoStack: unknown[];
	sources: Record<string, HyperframesSource>;
}

interface SessionStatus {
	projectId: string;
	revision: number;
	canUndo: boolean;
	canRedo: boolean;
	undoContext: Record<string, unknown> | null;
	redoContext: Record<string, unknown> | null;
}

export interface CanonicalHistoryAction {
	revision: number;
	canUndo: boolean;
	canRedo: boolean;
	hostContext: Record<string, unknown>;
}

/** Browser adapter only. Documents, validation, history and source ownership stay in Rust. */
export class CanonicalClassicSession {
	private readonly runtime: CanonicalEditorRuntime;
	readonly projectId: string;
	constructor({
		runtime,
		projectId,
	}: {
		runtime: CanonicalEditorRuntime;
		projectId: string;
	}) {
		this.runtime = runtime;
		this.projectId = projectId;
	}

	attach({
		classic,
		undoStack = [],
		redoStack = [],
	}: {
		classic: CanonicalClassicSnapshot;
		undoStack?: CanonicalHistoryBoundary[];
		redoStack?: CanonicalHistoryBoundary[];
	}): void {
		this.call({
			capability: "project.classic.session.attach",
			input: {
				projectId: this.projectId,
				expectedRevision: 0,
				classic,
				undoStack,
				redoStack,
			},
		});
	}

	restore(archive: CanonicalHistoryArchive): void {
		this.call({
			capability: "project.classic.session.restore",
			input: {
				projectId: this.projectId,
				expectedRevision: 0,
				archive,
			},
		});
	}

	read(): CanonicalClassicSnapshot {
		const state = this.runtime.snapshot() as {
			project: { id: string; classic: CanonicalClassicSnapshot };
		};
		if (state.project.id !== this.projectId) {
			throw new Error("The canonical Classic project changed");
		}
		return state.project.classic;
	}

	providerRetryPlan(
		failure: import("@/editor-agent/transport").ProviderFailureInput,
	): import("@/editor-agent/transport").ProviderRetryPlan {
		return this.runtime.providerRetryPlan(
			failure,
		) as import("@/editor-agent/transport").ProviderRetryPlan;
	}

	setEffectCatalog(definitions: unknown): void {
		this.runtime.setEffectCatalog(definitions);
	}

	setAnimationCatalog(definitions: unknown): void {
		this.runtime.setAnimationCatalog(definitions);
	}

	upsertKeyframes(input: {
		sceneId: string;
		keyframes: ClassicKeyframeUpsert[];
	}): void {
		if (!input.keyframes.length) return;
		const first = input.keyframes[0];
		const revision = this.status().revision;
		const catalog = this.call<{ catalogRevision: string }>({
			capability: "animation.classic.targets.read",
			input: {
				projectId: this.projectId,
				sceneId: input.sceneId,
				trackId: first.trackId,
				elementId: first.elementId,
				expectedRevision: revision,
				limit: 1,
			},
		});
		this.call({
			capability: "timeline.classic.keyframes.upsert",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: revision,
				catalogRevision: catalog.catalogRevision,
			},
		});
	}

	removeKeyframes(input: {
		sceneId: string;
		keyframes: ClassicKeyframeRemoval[];
		playheadTime: number;
		preserveAtPlayhead: boolean;
	}): void {
		if (!input.keyframes.length) return;
		const first = input.keyframes[0];
		const revision = this.status().revision;
		const catalog = this.call<{ catalogRevision: string }>({
			capability: "animation.classic.targets.read",
			input: {
				projectId: this.projectId,
				sceneId: input.sceneId,
				trackId: first.trackId,
				elementId: first.elementId,
				expectedRevision: revision,
				limit: 1,
			},
		});
		this.call({
			capability: "timeline.classic.keyframes.remove",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: revision,
				catalogRevision: catalog.catalogRevision,
			},
		});
	}

	copyKeyframes(input: {
		sceneId: string;
		trackId: string;
		elementId: string;
		keyframes: Array<{ propertyPath: string; keyframeId: string }>;
	}): {
		items: import("@/clipboard").KeyframeClipboardItem[];
		skipped: Array<{ index: number; reason: string }>;
	} {
		return this.call({
			capability: "animation.classic.keyframes.copy",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	pasteKeyframes(input: {
		sceneId: string;
		trackId: string;
		elementId: string;
		time: number;
		items: import("@/clipboard").KeyframeClipboardItem[];
	}): {
		keyframes: Array<{
			keyframeId: string;
			propertyPath: string;
			time: number;
		}>;
		skipped: Array<{ index: number; reason: string }>;
		skippedCurves: Array<{ index: number; reason: string }>;
	} {
		const revision = this.status().revision;
		const catalog = this.call<{ catalogRevision: string }>({
			capability: "animation.classic.targets.read",
			input: {
				projectId: this.projectId,
				sceneId: input.sceneId,
				trackId: input.trackId,
				elementId: input.elementId,
				expectedRevision: revision,
				limit: 1,
			},
		});
		return this.call({
			capability: "timeline.classic.keyframes.paste",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: revision,
				catalogRevision: catalog.catalogRevision,
			},
		});
	}

	editKeyframes(input: {
		sceneId: string;
		edits: ClassicKeyframeEdit[];
	}): void {
		this.call({
			capability: "timeline.classic.keyframes.edit",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	editMask(input: {
		sceneId: string;
		trackId: string;
		elementId: string;
		maskId?: string;
		change: ClassicMaskChange;
		expectedRevision?: number;
		catalogRevision?: string;
		dryRun?: boolean;
	}): {
		insertedPointId: string | null;
		removedPointIds: string[];
		masks: import("@/masks/types").Mask[];
	} {
		const { dryRun = false, ...request } = input;
		return this.call({
			capability: "timeline.classic.masks.edit",
			input: {
				...request,
				projectId: this.projectId,
				expectedRevision: input.expectedRevision ?? this.status().revision,
				catalogRevision: input.catalogRevision ?? this.maskCatalogRevision(),
			},
			context: { dryRun },
		});
	}

	setMaskCatalog(definitions: unknown): void {
		this.runtime.setMaskCatalog(definitions);
	}
	maskCatalogRevision(): string {
		return this.call<{ catalogRevision: string }>({
			capability: "masks.classic.catalog.read",
			input: { projectId: this.projectId },
		}).catalogRevision;
	}

	editEffects(input: {
		sceneId: string;
		trackId: string;
		elementId: string;
		change: ClassicEffectChange;
		historyGroup?: string;
	}): { effectId: string | null } {
		const catalog = this.call<{ catalogRevision: string }>({
			capability: "effects.classic.catalog.read",
			input: { projectId: this.projectId },
		});
		return this.call({
			capability: "timeline.classic.effects.edit",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				catalogRevision: catalog.catalogRevision,
			},
		});
	}

	status(): SessionStatus {
		return this.call({
			capability: "project.classic.session.status",
			input: {
				projectId: this.projectId,
			},
		});
	}

	startAgent({
		accountId,
		runId,
		request,
	}: {
		accountId: string;
		runId: string;
		request: string;
	}): EditingAgentSnapshot {
		return this.runtime.agentStart(
			accountId,
			runId,
			request,
		) as EditingAgentSnapshot;
	}

	captureAgentCheckpoint(): string | null {
		return this.runtime.agentCheckpoint();
	}
	restoreAgentCheckpoint({
		accountId,
		checkpoint,
	}: {
		accountId: string;
		checkpoint: string;
	}): EditingAgentSnapshot {
		return this.runtime.agentRestoreCheckpoint(accountId, checkpoint);
	}

	agentCommand(command: EditingAgentCommand): unknown {
		return this.runtime.agentCommand(command);
	}

	agentProviderRequest(model: string): EditingAgentProviderRequest {
		return this.runtime.agentProviderRequest(
			model,
		) as EditingAgentProviderRequest;
	}
	loadAgentKnowledge({
		accountId,
		context,
	}: {
		accountId: string;
		context: unknown;
	}): void {
		this.runtime.agentKnowledge(accountId, this.projectId, context);
	}

	agentPendingHost(): import("./agent-protocol").EditingAgentHostEffect | null {
		return this.runtime.agentPendingHost();
	}
	agentSettleHost({
		accountId,
		effectId,
		result,
	}: {
		accountId: string;
		effectId: number;
		result: import("./agent-protocol").EditingAgentHostResult;
	}): EditingAgentProviderRound {
		return this.runtime.agentSettleHost(
			accountId,
			this.projectId,
			effectId,
			result,
		);
	}

	agentReviewPlan(): EditingAgentReviewPlan {
		return this.runtime.agentReviewPlan() as EditingAgentReviewPlan;
	}
	agentReviewRequest({
		model,
		epoch,
		revision,
		frames,
	}: EditingAgentReviewRequest): EditingAgentProviderRequest {
		return this.runtime.agentReviewRequest(
			model,
			epoch,
			revision,
			frames,
		) as EditingAgentProviderRequest;
	}
	agentReviewResponse({
		epoch,
		response,
	}: {
		epoch: number;
		response: unknown;
	}): EditingAgentReviewResult {
		return this.runtime.agentReviewResponse(
			epoch,
			response,
		) as EditingAgentReviewResult;
	}

	storeAgentFrame(bytes: Uint8Array): { id: string } {
		const artifact = this.runtime.storeArtifact(
			bytes,
			"image/jpeg",
			undefined,
			undefined,
			undefined,
		) as { id: string };
		this.runtime.pinArtifact(artifact.id);
		return this.runtime.artifactMetadata(artifact.id) as { id: string };
	}
	storeAgentRender({
		bytes,
		mimeType,
	}: {
		bytes: Uint8Array;
		mimeType: string;
	}): { id: string } {
		const artifact = this.runtime.storeArtifact(
			bytes,
			mimeType,
			undefined,
			undefined,
			undefined,
		) as { id: string };
		this.runtime.pinArtifact(artifact.id);
		return this.runtime.artifactMetadata(artifact.id) as { id: string };
	}
	storeAgentImage({
		bytes,
		width,
		height,
	}: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}): unknown {
		const artifact = this.runtime.storeArtifact(
			bytes,
			"image/png",
			width,
			height,
			undefined,
		) as { id: string };
		this.runtime.pinArtifact(artifact.id);
		// Pinning changes the stored expiry. Return the live reference so strict
		// host contracts compare exactly with ArtifactStore, including after reload.
		return this.runtime.artifactMetadata(artifact.id);
	}
	storeAgentScreenshot({
		bytes,
		width,
		height,
	}: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}): unknown {
		const artifact = this.runtime.storeArtifact(
			bytes,
			"image/jpeg",
			width,
			height,
			undefined,
		) as { id: string };
		this.runtime.pinArtifact(artifact.id);
		return this.runtime.artifactMetadata(artifact.id);
	}

	agentProviderResponse({
		epoch,
		response,
	}: {
		epoch: number;
		response: unknown;
	}): EditingAgentProviderRound {
		return this.runtime.agentProviderResponse(
			epoch,
			response,
		) as EditingAgentProviderRound;
	}

	agentModelSchema(): unknown {
		return this.runtime.agentModelSchema();
	}

	agentModelAction({
		epoch,
		callId,
		action,
	}: {
		epoch: number;
		callId: string;
		action: unknown;
	}): unknown {
		return this.runtime.agentModelAction(epoch, callId, action);
	}

	agentSnapshot(): EditingAgentSnapshot | null {
		return this.runtime.agentSnapshot() as EditingAgentSnapshot | null;
	}

	verifyAgent({
		epoch,
		revision,
		issues,
	}: {
		epoch: number;
		revision: number;
		issues: string[];
	}): void {
		this.runtime.agentVerify(epoch, revision, issues);
	}

	synchronize({
		classic,
		dryRun = false,
	}: {
		classic: CanonicalClassicSnapshot;
		dryRun?: boolean;
	}): void {
		this.call({
			capability: "project.classic.synchronize",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				classic,
			},
			context: { dryRun },
		});
	}

	begin(): void {
		this.runtime.beginTransaction(this.projectId, this.status().revision);
	}

	invokeControl(
		action: import("./canonical-control").CanonicalControlAction,
	): unknown {
		if ("projectId" in action.input || "expectedRevision" in action.input)
			throw new Error("Control scope is supplied by the editor host");
		return this.call({
			capability: action.capabilityId,
			input: {
				...action.input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	editScene(change: ClassicSceneChange): void {
		const target = {
			projectId: this.projectId,
			expectedRevision: this.status().revision,
		};
		if (change.type === "delete") {
			this.call({
				capability: "project.classic.scene.delete",
				input: { ...target, sceneId: change.sceneId },
			});
		} else {
			this.call({
				capability: "project.classic.scenes.edit",
				input: { ...target, change },
			});
		}
	}

	updateSettings(input: {
		settings: Partial<import("@/project/types").TProjectSettings>;
		historyGroup?: string;
	}): void {
		this.call({
			capability: "project.classic.settings.update",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	editBookmarks({
		sceneId,
		change,
	}: {
		sceneId: string;
		change: ClassicBookmarkChange;
	}): void {
		this.call({
			capability: "timeline.classic.bookmarks.edit",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				sceneId,
				change,
			},
		});
	}

	updateTrack({
		sceneId,
		trackId,
		change,
	}: {
		sceneId: string;
		trackId: string;
		change: ClassicTrackChange;
	}): void {
		this.call({
			capability: "timeline.classic.track.update",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				sceneId,
				trackId,
				change,
			},
		});
	}

	editSourceAudio(input: ClassicSourceAudioChange & { sceneId: string }): void {
		this.call({
			capability: "timeline.classic.audio.source.edit",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	editTrackLayout({
		sceneId,
		change,
	}: {
		sceneId: string;
		change: ClassicTrackLayoutChange;
	}): void {
		this.call({
			capability: "timeline.classic.tracks.layout",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				sceneId,
				change,
			},
		});
	}
	setInputAttachments({
		accountId,
		attachments,
	}: {
		accountId: string;
		attachments: import("./agent-protocol").EditingInputAttachment[];
	}): void {
		this.runtime.agentInputAttachments(accountId, this.projectId, attachments);
	}
	storeInputAttachment({
		filename,
		bytes,
		mimeType,
	}: {
		filename: string;
		bytes: Uint8Array;
		mimeType: string;
	}): import("./agent-protocol").EditingInputAttachment {
		return this.runtime.storeInputAttachment(
			this.projectId,
			filename,
			bytes,
			mimeType,
		) as import("./agent-protocol").EditingInputAttachment;
	}
	captureConversationArtifacts(
		accountId: string,
	): import("./agent-protocol").EditingArtifactArchive {
		return this.runtime.conversationArtifacts(
			accountId,
			this.projectId,
		) as import("./agent-protocol").EditingArtifactArchive;
	}
	restoreConversationArtifacts({
		accountId,
		archive,
	}: {
		accountId: string;
		archive: import("./agent-protocol").EditingArtifactArchive;
	}): void {
		this.runtime.restoreConversationArtifacts(
			accountId,
			this.projectId,
			archive,
		);
	}
	readConversationArtifact(id: string): {
		bytes: Uint8Array;
		mimeType: string;
	} {
		const metadata = this.runtime.artifactMetadata(id) as { mimeType: string };
		return {
			bytes: this.runtime.readArtifact(id),
			mimeType: metadata.mimeType,
		};
	}
	readConversation(
		accountId: string,
	): import("./agent-protocol").EditingConversationArchive | null {
		return this.runtime.conversationRead(accountId, this.projectId) as
			| import("./agent-protocol").EditingConversationArchive
			| null;
	}
	applyConversation({
		accountId,
		event,
	}: {
		accountId: string;
		event: import("./agent-protocol").EditingConversationEvent;
	}): import("./agent-protocol").EditingConversationArchive {
		return this.runtime.conversationApply(
			accountId,
			this.projectId,
			event,
		) as import("./agent-protocol").EditingConversationArchive;
	}
	restoreConversation({
		accountId,
		archive,
	}: {
		accountId: string;
		archive: import("./agent-protocol").EditingConversationArchive;
	}): void {
		this.runtime.conversationRestore(accountId, this.projectId, archive);
	}
	editElementControls(input: {
		sceneId: string;
		elements: Array<{ trackId: string; elementId: string }>;
		change: ClassicElementControlChange;
	}): void {
		this.call({
			capability: "timeline.classic.elements.controls",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	removeTimelineContent({
		sceneId,
		removal,
	}: {
		sceneId: string;
		removal: ClassicRemoval;
	}): void {
		this.call({
			capability: "timeline.classic.remove",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				sceneId,
				removal,
			},
		});
	}

	removeMedia({
		mediaIds,
		cascade,
	}: {
		mediaIds: string[];
		cascade: boolean;
	}): void {
		this.call({
			capability: "media.classic.remove",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				mediaIds,
				cascade,
			},
		});
	}

	registerMedia({
		assets,
		expectedRevision,
		dryRun = false,
	}: {
		assets: CanonicalClassicSnapshot["mediaAssets"];
		expectedRevision: number;
		dryRun?: boolean;
	}): void {
		this.call({
			capability: "media.classic.register",
			input: { projectId: this.projectId, expectedRevision, assets },
			context: { dryRun },
		});
	}

	duplicateTimelineElements({
		sceneId,
		elements,
	}: {
		sceneId: string;
		elements: Array<{ trackId: string; elementId: string }>;
	}): Array<{ trackId: string; elementId: string }> {
		return this.call<{
			elements: Array<{ trackId: string; elementId: string }>;
		}>({
			capability: "timeline.classic.elements.duplicate",
			input: {
				projectId: this.projectId,
				sceneId,
				expectedRevision: this.status().revision,
				elements,
			},
		}).elements;
	}

	mergeTextElements(input: {
		sceneId: string;
		elements: Array<{ trackId: string; elementId: string }>;
		mode?: "single-line" | "multiline";
	}): { trackId: string; elementId: string } {
		return this.call<{ target: { trackId: string; elementId: string } }>({
			capability: "timeline.classic.text.merge",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		}).target;
	}

	applyRipple(input: {
		sceneId: string;
		beforeTracks: Array<{
			id: string;
			elements: Array<{ id: string; startTime: number; duration: number }>;
		}>;
	}): boolean {
		const request = {
			...input,
			projectId: this.projectId,
			expectedRevision: this.status().revision,
		};
		const plan = this.call<{ adjustments: unknown[] }>({
			capability: "timeline.classic.ripple.plan",
			input: request,
		});
		if (plan.adjustments.length === 0) return false;
		this.call({ capability: "timeline.classic.ripple.apply", input: request });
		return true;
	}

	copyTimelineElements(input: {
		sceneId: string;
		elements: Array<{ trackId: string; elementId: string }>;
	}): {
		sourceProjectId: string;
		items: import("@/clipboard").ElementClipboardItem[];
	} {
		return this.call({
			capability: "clipboard.classic.elements.copy",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	pasteTimelineElements(input: {
		sceneId: string;
		sourceProjectId: string;
		items: import("@/clipboard").ElementClipboardItem[];
		time: import("@/wasm").MediaTime;
	}): Array<{ trackId: string; elementId: string }> {
		return this.call<{
			elements: Array<{ trackId: string; elementId: string }>;
		}>({
			capability: "timeline.classic.elements.paste",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		}).elements;
	}

	splitTimelineElements(input: {
		sceneId: string;
		elements: Array<{ trackId: string; elementId: string }>;
		splitTime: import("@/wasm").MediaTime;
		retainSide: "both" | "left" | "right";
	}): Array<{ trackId: string; elementId: string }> {
		return this.call<{
			rightElements: Array<{ trackId: string; elementId: string }>;
		}>({
			capability: "timeline.classic.elements.split",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		}).rightElements;
	}

	setBackgroundRemoval(input: {
		sceneId: string;
		trackId: string;
		elementId: string;
		settings: import("@/background-removal").BackgroundRemovalSettings;
		duplicate: boolean;
	}): { trackId: string; elementId: string } {
		return this.call<{ target: { trackId: string; elementId: string } }>({
			capability: "timeline.classic.background_removal.set",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		}).target;
	}

	applyTransitions(input: {
		sceneId: string;
		applications: ClassicTransitionApplication[];
		managedTextSfx?: boolean;
	}): void {
		this.call({
			capability: "timeline.classic.transitions.apply",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	updateTimelineElements(input: {
		sceneId: string;
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<import("@/timeline").TimelineElement>;
		}>;
		historyGroup?: string;
		managedTypingSfx?: boolean;
	}): void {
		const updates = input.updates.map((update) => ({
			...update,
			patch: Object.fromEntries(
				Object.entries(update.patch).map(([key, value]) => [
					key,
					value === undefined ? null : value,
				]),
			),
		}));
		this.call({
			capability: "timeline.classic.elements.update",
			input: {
				...input,
				updates,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}
	moveTimelineElements({
		sceneId,
		moves,
		createTracks = [],
	}: {
		sceneId: string;
		moves: import("@/timeline/group-move").PlannedElementMove[];
		createTracks?: import("@/timeline/group-move").PlannedTrackCreation[];
	}): Array<{ trackId: string; elementId: string }> {
		return this.call<{
			elements: Array<{ trackId: string; elementId: string }>;
		}>({
			capability: "timeline.classic.elements.move",
			input: {
				projectId: this.projectId,
				sceneId,
				expectedRevision: this.status().revision,
				moves,
				createTracks,
			},
		}).elements;
	}

	insertTimelineElements({
		sceneId,
		clips,
	}: {
		sceneId: string;
		clips: import("@/commands/timeline/element/insert-element").InsertElementParams[];
	}): Array<{ trackId: string; elementId: string }> {
		const revision = this.status().revision;
		const catalog = clips.some((clip) => clip.element.type === "graphic")
			? this.call<{ catalogRevision: string }>({
					capability: "timeline.classic.elements.catalog",
					input: { projectId: this.projectId, expectedRevision: revision },
				})
			: undefined;
		const serializable = clips.map(({ element, placement }) => {
			if (element.type !== "audio") return { element, placement };
			const { buffer: _buffer, ...value } = element;
			return { element: value, placement };
		});
		return this.call<{
			elements: Array<{ trackId: string; elementId: string }>;
		}>({
			capability: "timeline.classic.elements.insert",
			input: {
				projectId: this.projectId,
				sceneId,
				expectedRevision: revision,
				catalogRevision: catalog?.catalogRevision,
				clips: serializable,
			},
		}).elements;
	}

	commitSilence({
		classic,
		sceneId,
		operation,
		idempotencyKey,
	}: {
		classic: CanonicalClassicSnapshot;
		sceneId: string;
		operation: CanonicalSilenceOperation;
		idempotencyKey: string;
	}): void {
		this.call({
			capability: "timeline.silence.commit",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				sceneId,
				operation,
				classic,
			},
			context: { metadata: { "opencut/idempotencyKey": idempotencyKey } },
		});
	}

	commit({
		label,
		hostContext,
	}: {
		label: string;
		hostContext: Record<string, unknown>;
	}): void {
		this.runtime.commitTransaction(label, hostContext);
	}

	rollback(): void {
		this.runtime.rollbackTransaction();
	}

	undo(): CanonicalHistoryAction {
		return this.moveHistory({ capability: "history.undo" });
	}
	redo(hostContext?: Record<string, unknown>): CanonicalHistoryAction {
		return this.moveHistory({ capability: "history.redo", hostContext });
	}

	archive(): CanonicalHistoryArchive {
		return this.call({
			capability: "project.classic.session.archive",
			input: {
				projectId: this.projectId,
				persistableOnly: true,
			},
		});
	}

	importHyperframes(input: {
		name: string;
		importId?: string;
		source: HyperframesSource;
		startSeconds?: number;
		trackId?: string;
		resolvedDurationSeconds?: number;
		runtimeManifest?: HyperframesRuntimeManifest;
		classicResourceAssets?: CanonicalClassicSnapshot["mediaAssets"];
	}): { assetId: string; itemId: string; trackId: string } {
		return this.call({
			capability: "timeline.hyperframes.import",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	previewHyperframesImport(
		input: Parameters<CanonicalClassicSession["importHyperframes"]>[0],
	): { assetId: string; itemId: string; trackId: string } {
		return this.call({
			capability: "timeline.hyperframes.import",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
			context: { dryRun: true },
		});
	}

	setHyperframesLayerOpacity(input: {
		sceneId: string;
		elementId: string;
		layerKey: string;
		opacity: number;
	}): void {
		this.call({
			capability: "hyperframes.layer.opacity.set",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	prepareHyperframesVariables(input: {
		source: HyperframesSource;
		values: Record<string, unknown>;
	}): HyperframesSource {
		return this.call({ capability: "hyperframes.variables.prepare", input });
	}

	setHyperframesVariables(input: {
		sceneId: string;
		elementId: string;
		values: Record<string, unknown>;
		manifest: HyperframesRuntimeManifest;
		expectedRevision: number;
	}): void {
		this.call({
			capability: "hyperframes.variables.set",
			input: { ...input, projectId: this.projectId },
		});
	}

	prepareHyperframesSource(input: {
		source: HyperframesSource;
		changes: Record<string, string | null>;
	}): { source: HyperframesSource; sourceFingerprint: string } {
		return this.call({ capability: "hyperframes.source.prepare", input });
	}

	planHyperframesLayerMove(input: {
		source: HyperframesSource;
		manifest: HyperframesRuntimeManifest;
		layerKey: string;
		startSeconds: number;
		strategy?: import("@/hyperframes/types").HyperframesLayerMoveStrategy;
	}): import("@/hyperframes/types").HyperframesLayerMovePlan {
		return this.call({ capability: "hyperframes.layer.move.plan", input });
	}

	prepareHyperframesLayerMove(input: {
		source: HyperframesSource;
		manifest: HyperframesRuntimeManifest;
		layerKey: string;
		startSeconds: number;
		strategy?: import("@/hyperframes/types").HyperframesLayerMoveStrategy;
		scripts: Record<string, string>;
	}): HyperframesSource {
		return this.call({ capability: "hyperframes.layer.move.prepare", input });
	}

	moveHyperframesLayer(input: {
		sceneId: string;
		elementId: string;
		expectedRevision: number;
		sourceFingerprint: string;
		layerKey: string;
		startSeconds: number;
		strategy?: import("@/hyperframes/types").HyperframesLayerMoveStrategy;
		scripts: Record<string, string>;
		manifest: HyperframesRuntimeManifest;
	}): void {
		this.call({
			capability: "hyperframes.layer.move",
			input: { ...input, projectId: this.projectId },
		});
	}

	setHyperframesSource(input: {
		sceneId: string;
		elementId: string;
		changes: Record<string, string | null>;
		sourceFingerprint: string;
		manifest: HyperframesRuntimeManifest;
		expectedRevision: number;
	}): void {
		this.call({
			capability: "hyperframes.source.set",
			input: { ...input, projectId: this.projectId },
		});
	}

	setHyperframesManifest(input: {
		assetId: string;
		manifest: HyperframesRuntimeManifest;
	}): void {
		this.call({
			capability: "hyperframes.manifest.set",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	readHyperframesLibrary(): {
		revision: number;
		items: import("@/hyperframes/types").HyperframesLibraryItem[];
	} {
		return this.call({
			capability: "hyperframes.library.read",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	searchHyperframesExamples(input: {
		query: string;
		embedding?: import("@/hyperframes/example-types").ExampleQueryEmbedding;
		kind?: "block" | "component" | "example";
		verifiedOnly?: boolean;
		offset?: number;
		limit?: number;
	}): import("@/hyperframes/example-types").ExampleSearch {
		return this.call({ capability: "hyperframes.examples.search", input });
	}

	async embedHyperframesQuery({
		query,
		host,
	}: {
		query: string;
		host: (
			effect: import("./agent-protocol").EditingAgentHostEffect,
		) => Promise<import("./agent-protocol").EditingAgentHostResult>;
	}): Promise<import("@/hyperframes/example-types").ExampleQueryEmbedding> {
		const receipt = (await this.runtime.invokeReadWithHost(
			"hyperframes.examples.embed",
			{
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				query,
			},
			host,
		)) as {
			result: {
				data: import("@/hyperframes/example-types").ExampleQueryEmbedding;
			};
		};
		return receipt.result.data;
	}

	readHyperframesExample(input: {
		id: string;
		upstreamCommit: string;
	}): import("@/hyperframes/example-types").ExampleManifest {
		return this.call({ capability: "hyperframes.examples.read", input });
	}

	async readHyperframesExampleSource({
		input,
		host,
	}: {
		input: {
			id: string;
			upstreamCommit: string;
			filePath: string;
			expectedSha256?: string;
			offset?: number;
			limit?: number;
		};
		host: (
			effect: import("./agent-protocol").EditingAgentHostEffect,
		) => Promise<import("./agent-protocol").EditingAgentHostResult>;
	}): Promise<import("@/hyperframes/example-types").ExampleSourcePage> {
		const receipt = (await this.runtime.invokeReadWithHost(
			"hyperframes.examples.source.read",
			{
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
			host,
		)) as {
			result: { data: import("@/hyperframes/example-types").ExampleSourcePage };
		};
		return receipt.result.data;
	}

	insertHyperframes(input: {
		sceneId: string;
		assetId: string;
		name: string;
		startSeconds?: number;
		trackId?: string;
	}): { assetId: string; itemId: string; trackId: string } {
		return this.call({
			capability: "timeline.hyperframes.insert",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	readHyperframesAudioClips({ sceneId }: { sceneId: string }): {
		revision: number;
		clips: Array<{
			compositionId: string;
			element: import("@/timeline").AudioElement;
		}>;
	} {
		return this.call({
			capability: "hyperframes.audio.clips.read",
			input: {
				projectId: this.projectId,
				sceneId,
				expectedRevision: this.status().revision,
			},
		});
	}

	readHyperframesLayerRows(input: { sceneId: string; elementId: string }): {
		revision: number;
		clip: import("@/hyperframes/types").HyperframesTimelineClip;
	} {
		return this.call({
			capability: "hyperframes.layers.timeline.read",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	dispose(): void {
		this.runtime.free();
	}

	clearHistory(): void {
		// Portable runtime restoration retains the document and resets history.
		this.runtime.restore(this.runtime.serialize());
	}

	private moveHistory({
		capability,
		hostContext,
	}: {
		capability: "history.undo" | "history.redo";
		hostContext?: Record<string, unknown>;
	}): CanonicalHistoryAction {
		return this.call({
			capability,
			input: {},
			context: {
				metadata: {
					"opencut/projectId": this.projectId,
					"opencut/expectedRevision": this.status().revision,
					...(hostContext && { "opencut/historyContext": hostContext }),
				},
			},
		});
	}

	private call<T>({
		capability,
		input,
		context,
	}: {
		capability: string;
		input: unknown;
		context?: unknown;
	}): T {
		const receipt = this.runtime.invokeSync(capability, input, context) as {
			result: { data: T };
		};
		return receipt.result.data;
	}
}

/** Browser handles remain in MediaManager; only durable metadata crosses WASM. */
export function canonicalMediaBindings(
	assets: MediaAsset[],
): CanonicalClassicSnapshot["mediaAssets"] {
	return assets.map(
		({ file, url: _url, thumbnailUrl: _thumbnailUrl, ...asset }) => ({
			...asset,
			size: asset.size ?? file?.size ?? 0,
			lastModified: asset.lastModified ?? file?.lastModified ?? 0,
		}),
	);
}
