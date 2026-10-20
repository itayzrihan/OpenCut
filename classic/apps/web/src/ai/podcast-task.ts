/** Browser inference/decoding task. Only the canonical registry creates output scenes. */
import type { EditorCore } from "@/core";
import type { PodcastOptions } from "./podcast-types";
import { requestPodcastPlan } from "./podcast-plan";
import { consumePodcastEditorialDraft } from "./podcast-editorial";
import { podcastPlanCacheKey, savePodcastPlan } from "./podcast-plan-cache";
import { toast } from "sonner";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { IndexedAudioCheckpoints } from "@/timeline/smart-takes/audio-checkpoints";
const tasks = new WeakMap<EditorCore, PodcastTask>();
export type Status = {
	reusedTranscript?: boolean;
	resumedAnalysis?: boolean;
	analysisRequests?: number;
	requestId?: string;
	projectId?: string;
	sceneId?: string;
	status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
	stage?: string;
	error?: string;
	outputCount?: number;
	mode?: PodcastOptions["mode"];
};
export function getPodcastTask(editor: EditorCore) {
	let task = tasks.get(editor);
	if (!task) {
		task = new PodcastTask(editor);
		tasks.set(editor, task);
	}
	return task;
}
class PodcastTask {
	private state: Status = { status: "idle" };
	private listeners = new Set<() => void>();
	private controller: AbortController | null = null;
	private remoteRequests = new Map<string, { input: string; status: Status }>();
	private activeRemote: string | null = null;
	constructor(private editor: EditorCore) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getSnapshot = () => this.state;
	private update(value: Partial<Status>) {
		this.state = { ...this.state, ...value };
		if (this.activeRemote) {
			const receipt = this.remoteRequests.get(this.activeRemote);
			if (receipt) receipt.status = this.state;
		}
		for (const l of this.listeners) l();
	}
	cancel = () => {
		this.controller?.abort();
	};
	startRemote(
		input: PodcastOptions & {
			sceneId: string;
			elementIds: string[];
			requestId: string;
		},
	) {
		const { sceneId, elementIds, requestId, ...options } = input;
		const projectId = this.editor.project.getActive().metadata.id;
		const key = JSON.stringify([
			window.__opencutAccountId,
			projectId,
			requestId,
		]);
		const signature = JSON.stringify([
			sceneId,
			[...elementIds].sort(),
			options,
		]);
		const prior = this.remoteRequests.get(key);
		if (prior) {
			if (prior.input !== signature)
				throw new Error("Podcast requestId was reused with different inputs");
			return prior.status;
		}
		if (this.controller) throw new Error("Podcast analysis is already running");
		if (this.editor.scenes.getActiveScene().id !== sceneId)
			throw new Error("Activate the explicit podcast source scene first");
		// UI and MCP use the same task and canonical transaction. This receipt is IO-only.
		this.activeRemote = key;
		this.remoteRequests.set(key, {
			input: signature,
			status: { status: "running", requestId, projectId, sceneId },
		});
		while (this.remoteRequests.size > 16)
			this.remoteRequests.delete(this.remoteRequests.keys().next().value!);
		void this.start({ ...options, reference: { elementIds, requestId } }).catch(
			(error: unknown) => {
				this.update({
					status: "failed",
					requestId,
					projectId,
					sceneId,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
		return this.remoteRequests.get(key)!.status;
	}
	async start({
		reference: remote,
		...options
	}: PodcastOptions & {
		reference?: { elementIds: string[]; requestId: string };
	}) {
		if (this.controller) throw new Error("Podcast analysis is already running");
		if (!remote) this.activeRemote = null;
		const editor = this.editor;
		const projectId = editor.project.getActive().metadata.id;
		const sceneId = editor.scenes.getActiveScene().id;
		const account = window.__opencutAccountId;
		if (!account) throw new Error("Sign in first");
		if (editor.project.getSessionReadOnlyReason())
			throw new Error("Take ownership before extracting clips");
		// Capture the user's explicit reference before transcription changes selection.
		const elementIds =
			remote?.elementIds.slice() ??
			editor.selection.getSelectedElements().map((e) => e.elementId);
		const reference = editor.command.podcastScope(elementIds);
		const controller = new AbortController();
		this.controller = controller;
		const abort = () => controller.abort();
		window.addEventListener("pagehide", abort, { once: true });
		this.state = {
			status: "running",
			requestId: remote?.requestId,
			projectId,
			sceneId,
			mode: options.mode,
			stage: "Preparing episode",
			reusedTranscript: reference.hasTranscript,
			resumedAnalysis: false,
			analysisRequests: 0,
		};
		this.update({});
		const check = () => {
			controller.signal.throwIfAborted();
			if (
				window.__opencutAccountId !== account ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				editor.scenes.getActiveSceneOrNull()?.id !== sceneId
			)
				throw new Error(
					"The active episode changed. No extracts were applied.",
				);
		};
		try {
			check();
			if (!reference.hasTranscript) {
				this.update({
					stage: elementIds.length
						? "Transcribing selected timeline clips…"
						: "Transcribing the timeline…",
				});
				const cancel = () => editor.transcription.cancel();
				controller.signal.addEventListener("abort", cancel, { once: true });
				const unsubscribe = editor.transcription.subscribe(() => {
					const { task } = editor.transcription.getState();
					if (task.phase) this.update({ stage: task.phase });
				});
				try {
					const result = await editor.transcription.start({
						language: "auto",
						referenceElementIds: elementIds,
						resumeJob: reference.resumeJobId
							? editor.project
									.getActive()
									.transcriptionJobs?.find(
										(j) => j.id === reference.resumeJobId,
									)
							: undefined,
					});
					check();
					if (result.task.status !== "succeeded")
						throw new Error(
							result.task.error || "Episode transcription failed",
						);
				} finally {
					unsubscribe();
					controller.signal.removeEventListener("abort", cancel);
				}
			}
			check();
			if (
				JSON.stringify(
					editor.command.podcastScope(elementIds).referenceRegions,
				) !== JSON.stringify(reference.referenceRegions)
			)
				throw new Error(
					"The selected timeline ranges changed. No extracts were applied.",
				);
			const source = editor.command.preparePodcast(elementIds);
			const cacheKey = await podcastPlanCacheKey({
				account,
				projectId,
				sceneId,
				options,
				words: source.words,
				sourceFingerprint: source.sourceFingerprint,
			});
			check();
			// Every mode resumes the reviewed canonical journal; cached final proposals cannot bypass critique.
			const videos = await requestPodcastPlan({
				source,
				options,
				signal: controller.signal,
				onResume: () => this.update({ resumedAnalysis: true }),
				onProviderRequest: () =>
					this.update({
						analysisRequests: (this.state.analysisRequests ?? 0) + 1,
					}),
				onStage: (stage) => {
					check();
					this.update({ stage });
				},
				review: source.review,
				planRetry: (failure) =>
					editor.command.planEditingProviderRetry(failure),
				assertScope: () => {
					check();
					if (editor.command.getCanonicalRevision() !== source.revision)
						throw new Error(
							"The source changed during analysis. Analyze the episode again.",
						);
				},
				cache: { key: cacheKey, storage: localStorage },
			});
			source.review({ options, videos });
			savePodcastPlan(localStorage, cacheKey, videos);
			check();
			this.update({ stage: "Protecting word boundaries with source audio…" });
			const audioEvidence = await source.analyzeAudio(
				controller.signal,
				(seconds, total) => {
					check();
					this.update({
						stage: `Protecting word boundaries · ${Math.min(100, Math.floor((seconds / total) * 100))}%`,
					});
				},
				{ key: cacheKey, store: new IndexedAudioCheckpoints() },
			);
			check();
			this.update({ stage: "Creating editable sequences…" });
			source.apply({ options, videos, audioEvidence });
			this.update({ stage: "Saving editable sequences…" });
			await editor.save.flush();
			await editor.command.flushHistory();
			if (
				window.__opencutAccountId !== account ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId
			)
				throw new Error(
					"The active project changed while sequences were saved",
				);
			localStorage.removeItem(cacheKey);
			consumePodcastEditorialDraft({ storage: localStorage, key: cacheKey });
			editor.playback.pause();
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
			this.update({
				status: "succeeded",
				outputCount: videos.length,
				stage: `${videos.length} sequences created`,
			});
			toast.success(`${videos.length} podcast sequences created`, {
				description:
					"The full episode is preserved. Open sequences from Media; right-click a clip for available alternatives.",
				action: { label: "Undo", onClick: () => editor.command.undo() },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.update({
				status: controller.signal.aborted ? "cancelled" : "failed",
				error: message,
			});
			if (!controller.signal.aborted)
				toast.error("Could not create podcast clips", {
					description: message,
					duration: Infinity,
					closeButton: true,
				});
		} finally {
			this.controller = null;
			window.removeEventListener("pagehide", abort);
		}
	}
}
