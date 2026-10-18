/** Shared host adapter for the complete Auto Texts sequence. Errors stop the recipe. */
import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/commands";
import {
	findCaptionSourceTrack,
	rebuildCaptionTracksWithSource,
} from "./caption-tracks";
import {
	normalizeCaptionLayoutSettings,
	type CaptionLayoutSettings,
} from "./caption-layout";
import {
	requestTranscriptCorrection,
	applyTranscriptCorrections,
	requestCaptionRowRearrangement,
	applyCaptionRowRearrangement,
} from "./caption-ai";
import { applyAndArrangeAllTextTransitions } from "@/transitions";
import type { TranscriptionLanguage } from "@/transcription/types";

type CaptionRecipeOptions = {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
	settings: CaptionLayoutSettings;
	language: TranscriptionLanguage;
	/** Reuse a saved transcript when resuming preparation. */
	resumeTranscript?: boolean;
};

export async function runAutoTexts(options: CaptionRecipeOptions) {
	return runCaptionRecipe({ ...options, transcriptOnly: false });
}

/** Shared Generate Transcript → Codex Correct adapter, without row or transition edits. */
export async function generateCorrectedTranscript(
	options: CaptionRecipeOptions,
) {
	return runCaptionRecipe({ ...options, transcriptOnly: true });
}

async function runCaptionRecipe({
	editor,
	signal,
	onProgress,
	settings,
	language,
	resumeTranscript = false,
	transcriptOnly,
}: CaptionRecipeOptions & { transcriptOnly: boolean }) {
	signal.throwIfAborted();
	const projectId = editor.project.getActive().metadata.id;
	const sceneId = editor.scenes.getActiveScene().id;
	const account =
		typeof window === "undefined" ? undefined : window.__opencutAccountId;
	const assertScope = () => {
		signal.throwIfAborted();
		if (
			editor.project.getActive().metadata.id !== projectId ||
			editor.scenes.getActiveScene().id !== sceneId ||
			(typeof window !== "undefined" && window.__opencutAccountId !== account)
		)
			throw new Error(
				"The project or account changed during transcript preparation",
			);
	};
	const cancel = () => editor.transcription.cancel();
	try {
		const savedSource = resumeTranscript
			? findCaptionSourceTrack({
					tracks: editor.scenes.getActiveScene().tracks,
				})?.captionSource
			: undefined;
		if (
			!editor.project
				.getActive()
				.transcriptionJobs?.some(
					(j) =>
						j.sceneId === sceneId &&
						(j.status === "running" || j.status === "paused"),
				) &&
			savedSource?.words.some((word) => word.source?.type !== "text-layer")
		) {
			onProgress("Continuing from the saved transcript…");
		} else {
			onProgress("Transcribing speech…");
			assertScope();
			const unsubscribe = editor.transcription.subscribe(() => {
				const { task } = editor.transcription.getState();
				if (task.status === "running" && task.phase) onProgress(task.phase);
			});
			signal.addEventListener("abort", cancel, { once: true });
			const state = await editor.transcription
				.start({ language, settings })
				.finally(() => {
					unsubscribe();
					signal.removeEventListener("abort", cancel);
				});
			signal.throwIfAborted();
			if (state.task.status !== "succeeded")
				throw new Error(state.task.error || "Transcription did not complete");
		}

		const operations = transcriptOnly
			? (["correct"] as const)
			: (["correct", "rearrange"] as const);
		for (const operation of operations) {
			assertScope();
			const scene = editor.scenes.getActiveScene();
			const projectId = editor.project.getActive().metadata.id;
			const source = findCaptionSourceTrack({
				tracks: scene.tracks,
			})?.captionSource;
			if (!source) throw new Error("No timed transcript was generated");
			const words = source.words.flatMap((w, sourceIndex) =>
				w.source?.type === "text-layer" ? [] : [{ ...w, sourceIndex }],
			);
			if (!words.length) throw new Error("No generated transcript words");
			const before = scene.tracks;
			let nextWords = source.words;
			let nextSettings = normalizeCaptionLayoutSettings({
				settings: source.settings,
			});
			if (operation === "correct") {
				onProgress("Codex correcting transcript…");
				const result = await requestTranscriptCorrection({ words, signal });
				nextWords = applyTranscriptCorrections({
					words: source.words,
					changes: result.changes,
				}).words;
			} else if (words.length > 1) {
				onProgress("Codex rearranging rows…");
				const result = await requestCaptionRowRearrangement({
					words,
					wordsPerRow: nextSettings.wordsPerRow,
					rows: nextSettings.rows,
					signal,
				});
				nextSettings = {
					...nextSettings,
					rowBreaks: applyCaptionRowRearrangement({
						words,
						rowEndPositions: result.rowEndPositions,
						wordsPerRow: nextSettings.wordsPerRow,
					}),
				};
			}
			assertScope();
			const current = editor.scenes.getActiveScene();
			if (
				editor.project.getActive().metadata.id !== projectId ||
				current.id !== scene.id ||
				current.tracks !== before
			)
				throw new Error(
					"Timeline changed during Auto Texts; no stale result was applied",
				);
			const after = rebuildCaptionTracksWithSource({
				tracks: before,
				words: nextWords,
				settings: nextSettings,
				canvasSize: editor.project.getActive().settings.canvasSize,
				layerCount: source.layerCount,
				preserveEditedElements: false,
			});
			if (!after) throw new Error("Could not rebuild captions");
			editor.command.execute({
				command: new TracksSnapshotCommand({ before, after }),
			});
		}
		assertScope();
		if (transcriptOnly) return;
		onProgress("Apply & Arrange All Text with transitions…");
		applyAndArrangeAllTextTransitions({ editor });
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
