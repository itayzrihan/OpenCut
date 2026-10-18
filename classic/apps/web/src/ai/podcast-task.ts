/** Browser inference/decoding task. Only the canonical registry creates output scenes. */
import type { EditorCore } from "@/core";
import type { PodcastOptions } from "./podcast-types";
import { requestPodcastPlan } from "./podcast-plan";
import { consumePodcastEditorialDraft } from "./podcast-editorial";
import {
	podcastPlanCacheKey,
	readPodcastPlan,
	savePodcastPlan,
} from "./podcast-plan-cache";
import { toast } from "sonner";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { IndexedAudioCheckpoints } from "@/timeline/smart-takes/audio-checkpoints";
const tasks = new WeakMap<EditorCore, PodcastTask>();
type Status = {
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
		for (const l of this.listeners) l();
	}
	cancel = () => {
		this.controller?.abort();
	};
	async start(options: PodcastOptions) {
		if (this.controller) throw new Error("Podcast analysis is already running");
		const editor = this.editor;
		const projectId = editor.project.getActive().metadata.id;
		const sceneId = editor.scenes.getActiveScene().id;
		const account = window.__opencutAccountId;
		if (!account) throw new Error("Sign in first");
		if (editor.project.getSessionReadOnlyReason())
			throw new Error("Take ownership before extracting clips");
		if (editor.scenes.getActiveScene().takeAssembly)
			throw new Error("Select the original episode scene first");
		const controller = new AbortController();
		this.controller = controller;
		const abort = () => controller.abort();
		window.addEventListener("pagehide", abort, { once: true });
		this.state = {
			status: "running",
			mode: options.mode,
			stage: "Preparing episode",
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
			if (
				editor.project
					.getActive()
					.transcriptionJobs?.some(
						(j) =>
							j.sceneId === sceneId &&
							(j.status === "running" || j.status === "paused"),
					) ||
				!editor.scenes
					.getActiveScene()
					.tracks.overlay.some((t) => t.type === "text" && t.captionSource)
			) {
				this.update({ stage: "Transcribing the full episode…" });
				const cancel = () => editor.transcription.cancel();
				controller.signal.addEventListener("abort", cancel, { once: true });
				const unsubscribe = editor.transcription.subscribe(() => {
					const { task } = editor.transcription.getState();
					if (task.phase) this.update({ stage: task.phase });
				});
				try {
					const result = await editor.transcription.start({ language: "auto" });
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
			const ids = editor.scenes
				.getActiveScene()
				.tracks.main.elements.filter((e) => e.type === "video")
				.map((e) => e.id);
			const source = editor.command.preparePodcast(ids);
			const cacheKey = await podcastPlanCacheKey({
				account,
				projectId,
				sceneId,
				options,
				words: source.words,
				sourceFingerprint: source.sourceFingerprint,
			});
			check();
			// Teasers resume the canonical editorial journal, including critique;
			// an old structurally valid final short cannot bypass narrative review.
			let videos =
				options.mode === "teaser"
					? null
					: readPodcastPlan(localStorage, cacheKey);
			if (videos) {
				source.review({ options, videos });
				this.update({ stage: "Resuming saved clip selection…" });
			} else {
				videos = await requestPodcastPlan({
					source,
					options,
					signal: controller.signal,
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
				check();
				source.review({ options, videos });
				savePodcastPlan(localStorage, cacheKey, videos);
			}
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
			if (options.mode === "teaser")
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
