import type { EditorCore } from "@/core";
import { extractTimelineAudio } from "@/media/mediabunny";
import {
	DEFAULT_CAPTION_LAYOUT,
	buildCaptionChunksFromSegments,
	buildCaptionChunksFromWords,
	normalizeCaptionLayoutSettings,
	type CaptionLayoutSettings,
} from "@/subtitles/caption-layout";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { transcribeTimelineAudioBlob } from "@/transcription/server-client";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionResult,
} from "@/transcription/types";
import { generateUUID } from "@/utils/id";
import * as OpenCutWasm from "opencut-wasm";
import type { AgentTaskEvent, AgentTaskState } from "opencut-wasm";

const CAPTION_LAYER_COUNT = 2;

export interface TranscriptionTaskState {
	task: AgentTaskState;
	language?: TranscriptionLanguage;
	sceneId?: string;
	insertedTrackIds: string[];
}

export interface TranscriptionManagerDependencies {
	extractAudio: typeof extractTimelineAudio;
	transcribe: typeof transcribeTimelineAudioBlob;
	insertCaptions: typeof insertCaptionChunksAsTextTrack;
	generateId: () => string;
	transitionTask: typeof OpenCutWasm.transitionAgentTask;
}

const DEFAULT_DEPENDENCIES: TranscriptionManagerDependencies = {
	extractAudio: extractTimelineAudio,
	transcribe: transcribeTimelineAudioBlob,
	insertCaptions: insertCaptionChunksAsTextTrack,
	generateId: generateUUID,
	transitionTask: OpenCutWasm.transitionAgentTask,
};

const IDLE_AGENT_TASK: AgentTaskState = {
	taskId: undefined,
	kind: undefined,
	status: "idle",
	progressBasisPoints: 0,
	phase: undefined,
	error: undefined,
};

export class TranscriptionManager {
	private listeners = new Set<() => void>();
	private abortController: AbortController | null = null;
	private readonly editor: EditorCore;
	private readonly dependencies: TranscriptionManagerDependencies;
	private state: TranscriptionTaskState = {
		task: IDLE_AGENT_TASK,
		insertedTrackIds: [],
	};

	constructor({
		editor,
		dependencies = DEFAULT_DEPENDENCIES,
	}: {
		editor: EditorCore;
		dependencies?: TranscriptionManagerDependencies;
	}) {
		this.editor = editor;
		this.dependencies = dependencies;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getState(): TranscriptionTaskState {
		return this.state;
	}

	async start({
		language = "auto",
		settings = DEFAULT_CAPTION_LAYOUT,
	}: {
		language?: TranscriptionLanguage;
		settings?: CaptionLayoutSettings;
	} = {}): Promise<TranscriptionTaskState> {
		if (
			this.state.task.status === "running" ||
			this.state.task.status === "cancelling"
		) {
			throw new Error("A transcription task is already running");
		}

		const scene = this.editor.scenes.getActiveScene();
		const taskId = this.dependencies.generateId();
		const normalizedSettings = normalizeCaptionLayoutSettings({ settings });
		this.transition({
			type: "start",
			taskId,
			kind: "transcription",
			phase: "extracting_audio",
		});
		this.state = {
			...this.state,
			language,
			sceneId: scene.id,
			insertedTrackIds: [],
		};
		this.notify();

		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const audioBlob = await this.dependencies.extractAudio({
				tracks: scene.tracks,
				mediaAssets: this.editor.media.getAssets(),
				totalDuration: this.editor.timeline.getTotalDuration(),
			});
			this.throwIfCancelled();
			this.updateProgress({
				taskId,
				progressBasisPoints: 1_500,
				phase: "transcribing",
			});

			const result = await this.dependencies.transcribe({
				audioBlob,
				language,
				signal: abortController.signal,
			});
			this.throwIfCancelled();
			this.updateProgress({
				taskId,
				progressBasisPoints: 8_500,
				phase: "generating_captions",
			});

			if (this.editor.scenes.getActiveSceneOrNull()?.id !== scene.id) {
				throw new Error(
					"The active scene changed while transcription was running; captions were not inserted",
				);
			}
			const captionChunks = buildCaptionChunks({
				result,
				settings: normalizedSettings,
			});
			const insertedTrackIds = this.dependencies.insertCaptions({
				editor: this.editor,
				captions: captionChunks,
				captionSource: result.words?.length
					? { words: result.words, settings: normalizedSettings }
					: undefined,
				settings: normalizedSettings,
				layerCount: result.words?.length ? CAPTION_LAYER_COUNT : 1,
			});
			if (insertedTrackIds.length === 0) {
				throw new Error("No captions were generated");
			}

			this.state = { ...this.state, insertedTrackIds };
			this.transition({ type: "complete", taskId, phase: "complete" });
		} catch (error) {
			if (isAbortError({ error }) || this.state.task.status === "cancelling") {
				this.transition({ type: "cancel", taskId });
			} else {
				this.transition({
					type: "fail",
					taskId,
					error: getErrorMessage({ error }),
				});
			}
		} finally {
			if (this.abortController === abortController) {
				this.abortController = null;
			}
		}

		return this.state;
	}

	cancel(): TranscriptionTaskState {
		if (this.state.task.status === "cancelling") return this.state;
		if (this.state.task.status !== "running" || !this.state.task.taskId) {
			return this.state;
		}
		this.transition({
			type: "request_cancel",
			taskId: this.state.task.taskId,
		});
		this.abortController?.abort();
		return this.state;
	}

	clear(): TranscriptionTaskState {
		if (
			this.state.task.status === "running" ||
			this.state.task.status === "cancelling"
		) {
			return this.state;
		}
		this.transition({ type: "clear" });
		this.state = { task: this.state.task, insertedTrackIds: [] };
		this.notify();
		return this.state;
	}

	private updateProgress({
		taskId,
		progressBasisPoints,
		phase,
	}: {
		taskId: string;
		progressBasisPoints: number;
		phase: string;
	}) {
		this.transition({
			type: "progress",
			taskId,
			progressBasisPoints,
			phase,
		});
	}

	private throwIfCancelled() {
		if (
			this.state.task.status === "cancelling" ||
			this.abortController?.signal.aborted
		) {
			throw new DOMException("Transcription cancelled", "AbortError");
		}
	}

	private transition(event: AgentTaskEvent) {
		const decision = this.dependencies.transitionTask({
			state: this.state.task,
			event,
		});
		if (!decision.allowed) throw new Error(decision.reason);
		this.state = { ...this.state, task: decision.state };
		this.notify();
	}

	private notify() {
		for (const listener of this.listeners) listener();
	}
}

function buildCaptionChunks({
	result,
	settings,
}: {
	result: TranscriptionResult;
	settings: CaptionLayoutSettings;
}): CaptionChunk[] {
	return result.words?.length
		? buildCaptionChunksFromWords({ words: result.words, settings })
		: buildCaptionChunksFromSegments({ segments: result.segments, settings });
}

function isAbortError({ error }: { error: unknown }): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function getErrorMessage({ error }: { error: unknown }): string {
	return error instanceof Error
		? error.message
		: "An unexpected error occurred";
}
