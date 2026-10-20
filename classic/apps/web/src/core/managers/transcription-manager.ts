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
import { transcribeTimelineAudioBlob } from "@/transcription/browser-client";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionResult,
} from "@/transcription/types";
import { generateUUID } from "@/utils/id";
import * as OpenCutWasm from "opencut-wasm";
import type { AgentTaskEvent, AgentTaskState } from "opencut-wasm";

import { DEFAULTS } from "@/timeline/defaults";
import type { TranscriptionJob } from "@/transcription/job";
const CAPTION_LAYER_COUNT = 2;

export interface TranscriptionTaskState {
	task: AgentTaskState;
	language?: TranscriptionLanguage;
	sceneId?: string;
	jobId?: string;
	insertedTrackIds: string[];
}

export interface TranscriptionManagerDependencies {
	extractAudio: typeof extractTimelineAudio;
	transcribeTimeline?: typeof import("@/transcription/timeline-stream").transcribeTimelineStream;
	transcribe: typeof transcribeTimelineAudioBlob;
	insertCaptions: typeof insertCaptionChunksAsTextTrack;
	generateId: () => string;
	transitionTask: typeof OpenCutWasm.transitionAgentTask;
}

const DEFAULT_DEPENDENCIES: TranscriptionManagerDependencies = {
	extractAudio: extractTimelineAudio,
	transcribeTimeline: async (input) =>
		(await import("@/transcription/timeline-stream")).transcribeTimelineStream(
			input,
		),
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
	private pausePromise: Promise<void> | null = null;
	private runningPromise: Promise<TranscriptionTaskState> | null = null;
	private runningReference: string | null = null;
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

	start(
		input: Parameters<TranscriptionManager["run"]>[0] = {},
	): Promise<TranscriptionTaskState> {
		const referenceKey = JSON.stringify(
			[
				...(input.resumeJob
					? (input.resumeJob.referenceElementIds ?? [])
					: (input.referenceElementIds ?? [])),
			].sort(),
		);
		if (this.runningPromise) {
			if (this.runningReference !== referenceKey)
				throw new Error(
					"A different timeline reference is being transcribed. Pause it before starting the selected clips.",
				);
			return this.runningPromise;
		}
		this.runningReference = referenceKey;
		const promise = this.run(input).finally(() => {
			if (this.runningPromise === promise) {
				this.runningPromise = null;
				this.runningReference = null;
			}
		});
		this.runningPromise = promise;
		return promise;
	}

	private async run({
		language = "auto",
		settings = DEFAULT_CAPTION_LAYOUT,
		resumeJob,
		referenceElementIds,
	}: {
		language?: TranscriptionLanguage;
		settings?: CaptionLayoutSettings;
		resumeJob?: TranscriptionJob;
		referenceElementIds?: string[];
	} = {}): Promise<TranscriptionTaskState> {
		if (
			this.state.task.status === "running" ||
			this.state.task.status === "cancelling"
		) {
			throw new Error("A transcription task is already running");
		}

		if (this.pausePromise) await this.pausePromise;
		const scene = this.editor.scenes.getActiveScene();
		const projectId = this.editor.project.getActive().metadata.id;
		const account =
			typeof window === "undefined" ? null : window.__opencutAccountId;
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
			jobId: undefined,
			insertedTrackIds: [],
		};
		this.notify();

		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const request = {
				language,
				signal: abortController.signal,
				onProgress: (
					progress: import("@/transcription/types").TranscriptionProgress,
				) => {
					if (abortController.signal.aborted) return;
					this.updateProgress({
						taskId,
						// Newly discovered download files can lower the byte percentage;
						// the canonical Rust task requires monotonic overall progress.
						progressBasisPoints: Math.max(
							this.state.task.progressBasisPoints,
							progress.status === "loading-model"
								? 1500 +
										Math.round(
											Math.max(0, Math.min(100, progress.progress || 0)) * 25,
										)
								: 4000 +
										Math.round(
											Math.max(0, Math.min(100, progress.progress || 0)) * 40,
										),
						),
						phase: progress.message || progress.status,
					});
				},
			};
			let job: TranscriptionJob | undefined;
			const engine =
				resumeJob?.engine ??
				this.editor.project.getActive().transcriptionEngine ??
				"local";
			if (this.dependencies.transcribeTimeline) {
				job =
					resumeJob ??
					this.editor.project
						.getActive()
						.transcriptionJobs?.find(
							(j) =>
								j.sceneId === scene.id &&
								JSON.stringify([...(j.referenceElementIds ?? [])].sort()) ===
									JSON.stringify([...(referenceElementIds ?? [])].sort()) &&
								j.language === language &&
								(j.engine ?? "local") === engine &&
								(j.status === "running" || j.status === "paused"),
						);
				let jobId = job?.id ?? taskId;
				let externalConfiguration = job?.externalConfiguration ?? undefined;
				if (engine === "external") {
					const { getExternalSettings } =
						await import("@/transcription/external-client");
					const config = await getExternalSettings({
						signal: abortController.signal,
					});
					if (!config.configured || !config.id)
						throw new Error(
							"Configure the transcription API in Captions first",
						);
					if (externalConfiguration && externalConfiguration !== config.id) {
						if (resumeJob)
							throw new Error(
								"The transcription API settings changed. Open the original scene and generate a new transcript, or restore the previous API settings to resume.",
							);
						job = undefined;
						jobId = taskId;
					}
					externalConfiguration = config.id;
				}
				await this.editor.command.waitForTranscriptionPublication(
					abortController.signal,
				);
				this.throwIfCancelled();
				if (
					typeof window !== "undefined" &&
					window.__opencutAccountId !== account
				)
					throw new DOMException("Transcription account changed", "AbortError");
				this.editor.command.editTranscription({
					projectId,
					jobId,
					change: job
						? { type: "resume" }
						: {
								type: "start",
								referenceElementIds,
								engine,
								externalConfiguration,
								sceneId: scene.id,
								language,
								settings: normalizedSettings,
								defaults: DEFAULTS.text,
								totalDuration: this.editor.timeline.getTotalDuration(),
							},
				});
				job = structuredClone(
					this.editor.project
						.getActive()
						.transcriptionJobs!.find((j) => j.id === jobId)!,
				);
				this.state = { ...this.state, jobId, sceneId: job.sceneId };
				await this.editor.project.saveCurrentProject();
			}
			const timeline = {
				tracks: job?.sourceTracks ?? scene.tracks,
				mediaAssets: this.editor.media.getAssets(),
				totalDuration:
					job?.totalDuration ?? this.editor.timeline.getTotalDuration(),
			};
			let result: TranscriptionResult;
			if (this.dependencies.transcribeTimeline) {
				result = await this.dependencies.transcribeTimeline({
					...timeline,
					...request,
					engine,
					externalConfiguration: job?.externalConfiguration,
					completedChunks: job?.chunks,
					onChunk: async ({ index, words }) => {
						this.throwIfCancelled();
						if (
							this.editor.project.getActiveOrNull()?.metadata.id !==
								projectId ||
							(typeof window !== "undefined" &&
								window.__opencutAccountId !== account)
						)
							throw new DOMException(
								"Transcription project/account changed",
								"AbortError",
							);
						await this.editor.command.waitForTranscriptionPublication(
							abortController.signal,
						);
						this.throwIfCancelled();
						if (
							typeof window !== "undefined" &&
							window.__opencutAccountId !== account
						)
							throw new DOMException(
								"Transcription account changed",
								"AbortError",
							);
						let current = this.editor.project
							.getActive()
							.transcriptionJobs?.find((j) => j.id === job!.id);
						if (current?.status === "superseded")
							throw new DOMException(
								"Transcript replaced by imported subtitles",
								"AbortError",
							);
						// Undo can remove the job or an earlier section while inference is
						// active. Reconcile completed work against the current document.
						let published = false;
						if (!current) {
							published = true;
							this.editor.command.editTranscription({
								projectId,
								jobId: job!.id,
								change: { type: "restore", snapshot: job! },
							});
						}
						job!.chunks[index] = words.map(({ text, start, end }) => ({
							text,
							start,
							end,
						}));
						for (const [section, completed] of Object.entries(job!.chunks)) {
							current = this.editor.project
								.getActive()
								.transcriptionJobs?.find((j) => j.id === job!.id);
							if (!current?.chunks[section]) {
								published = true;
								this.editor.command.editTranscription({
									projectId,
									jobId: job!.id,
									change: {
										type: "append",
										index: Number(section),
										words: completed,
									},
								});
							}
						}
						// Saved windows still reconcile Undo, but must not serialize the
						// entire history again when the durable section is already present.
						if (!published) return;
						this.state = {
							...this.state,
							insertedTrackIds:
								this.editor.project
									.getActive()
									.scenes.find((s) => s.id === job!.sceneId)
									?.tracks.overlay.filter(
										(t) =>
											t.type === "text" &&
											t.captionSource?.sourceId === job!.id,
									)
									.map((t) => t.id) ?? [],
						};
						this.notify();
						// Await the fenced project save before accepting the next section.
						await this.editor.project.saveCurrentProject();
					},
				});
			} else {
				if (referenceElementIds?.length)
					throw new Error(
						"Reload OpenCut to transcribe the selected timeline reference safely",
					);
				const audioBlob = await this.dependencies.extractAudio(timeline);
				this.throwIfCancelled();
				result = await this.dependencies.transcribe({ audioBlob, ...request });
			}
			this.throwIfCancelled();
			this.updateProgress({
				taskId,
				progressBasisPoints: 8_500,
				phase: "generating_captions",
			});

			if (job) {
				this.transition({ type: "complete", taskId, phase: "complete" });
				return this.state;
			}
			if (
				this.editor.scenes.getActiveSceneOrNull()?.id !== scene.id ||
				this.editor.project.getActive().metadata.id !== projectId
			)
				throw new Error(
					"The transcription target project or scene is no longer open",
				);
			// Share Rust's cut-time normalization with fresh provider results before
			// both cue generation and the canonical transcript insertion.
			const normalizedResult = {
				...result,
				words: result.words
					? OpenCutWasm.removeCaptionWordTimeRanges({
							words: result.words,
							ranges: [],
						}).map(({ text, start, end }) => ({ text, start, end }))
					: undefined,
			};
			const captionChunks = buildCaptionChunks({
				result: normalizedResult,
				settings: normalizedSettings,
			});
			const insertedTrackIds = this.dependencies.insertCaptions({
				editor: this.editor,
				captions: captionChunks,
				captionSource: normalizedResult.words?.length
					? { words: normalizedResult.words, settings: normalizedSettings }
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
				console.error(
					"Transcription failed",
					JSON.stringify({
						phase: this.state.task.phase,
						detail:
							error instanceof Error
								? (error.stack ?? error.message)
								: String(error),
					}),
				);
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

	async setEngine(
		engine: import("@/transcription/job").TranscriptionEngine,
	): Promise<void> {
		if (this.runningPromise)
			throw new Error(
				"Finish or cancel the running transcript before changing engines",
			);
		const projectId = this.editor.project.getActive().metadata.id;
		const account =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		await this.editor.command.waitForTranscriptionPublication(
			new AbortController().signal,
		);
		if (
			this.editor.project.getActive().metadata.id !== projectId ||
			(typeof window !== "undefined" && window.__opencutAccountId !== account)
		)
			throw new Error(
				"The transcription target project/account is no longer open",
			);
		this.editor.command.editTranscription({
			projectId,
			jobId: "preferences",
			change: { type: "setEngine", engine },
		});
		await this.editor.project.saveCurrentProject();
	}
	async importSrt({
		file,
		settings = DEFAULT_CAPTION_LAYOUT,
	}: {
		file: File;
		settings?: CaptionLayoutSettings;
	}): Promise<void> {
		const projectId = this.editor.project.getActive().metadata.id,
			sceneId = this.editor.scenes.getActiveScene().id;
		const account =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		if (file.size > 5_000_000) throw new Error("SRT file exceeds 5 MB");
		const text = await file.text();
		if (this.runningPromise) {
			this.cancel();
			await this.runningPromise;
			await this.pausePromise;
		}
		await this.editor.command.waitForTranscriptionPublication(
			new AbortController().signal,
		);
		if (
			this.editor.project.getActive().metadata.id !== projectId ||
			(typeof window !== "undefined" && window.__opencutAccountId !== account)
		)
			throw new Error("The SRT target project/account is no longer open");
		this.editor.command.editTranscription({
			projectId,
			jobId: this.dependencies.generateId(),
			change: {
				type: "importSrt",
				sceneId,
				text,
				settings: normalizeCaptionLayoutSettings({ settings }),
				defaults: DEFAULTS.text,
			},
		});
		await this.editor.project.saveCurrentProject();
		this.clear();
	}

	/** Resume a persisted running job after a renderer restart; an explicit user
	 * cancellation sets paused and never restarts itself. */
	async resumePending(): Promise<void> {
		if (this.abortController || this.editor.project.getSessionReadOnlyReason())
			return;
		const job = this.editor.project
			.getActiveOrNull()
			?.transcriptionJobs?.find((j) => j.status === "running");
		if (job)
			await this.start({
				language: job.language,
				settings: job.settings,
				resumeJob: job,
			});
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
		const projectId = this.state.jobId
			? this.editor.project.getActiveOrNull()?.metadata.id
			: undefined;
		if (projectId && this.state.jobId) {
			const jobId = this.state.jobId;
			this.pausePromise = (async () => {
				await this.editor.command.waitForTranscriptionPublication(
					new AbortController().signal,
				);
				if (
					this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
					!this.editor.project
						.getActive()
						.transcriptionJobs?.some((j) => j.id === jobId)
				)
					return;
				this.editor.command.editTranscription({
					projectId,
					jobId,
					change: { type: "pause" },
				});
				await this.editor.project.saveCurrentProject();
			})().catch((error) =>
				console.error("Could not persist transcription pause", error),
			);
		}
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
