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

export async function runAutoTexts({
	editor,
	signal,
	onProgress,
	settings,
	language,
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
	settings: CaptionLayoutSettings;
	language: TranscriptionLanguage;
}) {
	signal.throwIfAborted();
	const cancel = () => editor.transcription.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		onProgress("Transcribing speech…");
		const state = await editor.transcription.start({ language, settings });
		signal.throwIfAborted();
		if (state.task.status !== "succeeded")
			throw new Error(state.task.error || "Transcription did not complete");
		for (const operation of ["correct", "rearrange"] as const) {
			signal.throwIfAborted();
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
			signal.throwIfAborted();
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
		signal.throwIfAborted();
		onProgress("Apply & Arrange All Text with transitions…");
		applyAndArrangeAllTextTransitions({ editor });
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
