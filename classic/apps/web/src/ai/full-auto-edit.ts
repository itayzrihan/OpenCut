/** Single-project host orchestration. Rust owns the recipe and document transforms. */
import { compileFullAutoEdit, fullAutoEditStages } from "opencut-wasm";
import type { EditorCore } from "@/core";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "./timeline-document-v2";
import { updateSceneInArray } from "@/timeline/scenes";
import { runLocalSubjectFraming } from "./subject-framing";
import { runAutoTexts } from "@/subtitles/auto-texts";
import { DEFAULT_CAPTION_LAYOUT } from "@/subtitles/caption-layout";
import { runAutomaticMusic } from "./automatic-music";
import { runAutomaticZoom } from "./automatic-zoom";
import { runAutomaticTextTransitions } from "./automatic-text-transitions";
import { runAutomaticWordAnimation } from "./automatic-word-animation";
import { loadProjectFont, isProjectFontLoaded } from "@/fonts/custom-fonts";

export interface FullAutoOptions {
	zoom: boolean;
	transitions: boolean;
	wordAnimation: boolean;
	music: boolean;
}

export interface FullAutoStepProgress {
	completedStages: number;
	totalStages: number;
	stage: string;
	message: string;
}

export async function runFullAutoEdit({
	editor,
	signal,
	onProgress,
	onStep,
	options,
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
	onStep?: (progress: FullAutoStepProgress) => void;
	options: FullAutoOptions;
}) {
	const projectId = editor.project.getActive().metadata.id;
	const sceneId = editor.scenes.getActiveScene().id;
	let fontFamily = "";
	const notes: string[] = [];
	const steps = fullAutoEditStages(options);
	const assertContext = () => {
		signal.throwIfAborted();
		if (
			editor.project.getActive().metadata.id !== projectId ||
			editor.scenes.getActiveScene().id !== sceneId
		)
			throw new Error("Project or scene changed; Full Auto Edit stopped");
	};
	const compileAndApply = async ({
		stage,
		framing = [],
	}: {
		stage: string;
		framing?: unknown;
	}) => {
		assertContext();
		const project = editor.project.getActive();
		const scene = editor.scenes.getActiveScene();
		const before = buildTimelineDocumentV2({ project, scene });
		const result = compileFullAutoEdit({
			sourceJson: before.formattedText,
			stage,
			framingJson: JSON.stringify(framing),
			fontFamily,
		});
		if (!result.valid) throw new Error(result.error);
		const parsed = parseTimelineDocumentV2({ text: result.sourceJson });
		const value = parsed.value;
		if (!parsed.valid || !value)
			throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
		editor.command.executeTransaction({
			execute: () => {
				// updateSettings executes synchronously; its Promise is only the public adapter signature.
				void editor.project.updateSettings({ settings: value.projectSettings });
				editor.scenes.setScenes({
					scenes: updateSceneInArray({
						scenes: editor.scenes.getScenes(),
						sceneId,
						updates: { tracks: value.tracks, bookmarks: value.bookmarks },
					}),
					activeSceneId: sceneId,
				});
				editor.save.markDirty();
			},
		});
	};
	for (const [index, stage] of steps.entries()) {
		assertContext();
		const progress = (message: string) => {
			onProgress(`${index + 1}/${steps.length} · ${message}`);
			onStep?.({
				completedStages: index,
				totalStages: steps.length,
				stage,
				message,
			});
		};
		progress(`Starting ${stage}…`);
		try {
			switch (stage) {
				case "preflight": {
					progress(
						"Checking imported video, custom font, AI and Hebrew model…",
					);
					const scene = editor.scenes.getActiveScene();
					if (
						!scene.tracks.main.elements.length ||
						scene.tracks.overlay.some((t) => t.elements.length > 0) ||
						scene.tracks.audio.some((t) => t.elements.length > 0)
					)
						throw new Error(
							"Full Auto Edit starts with imported main-track video. This scene already contains edits; use a fresh project to avoid replacing them.",
						);
					const font =
						editor.project
							.getActive()
							.customFonts?.find((f) =>
								/^assistant[ _-]*bold$/i.test(f.family),
							) ??
						editor.project
							.getActive()
							.customFonts?.find((f) =>
								/^assistant[ _-]*extra[ _-]*bold$/i.test(f.family),
							);
					if (!font)
						throw new Error(
							"Import Assistant Bold or Assistant ExtraBold into Custom Fonts first",
						);
					await loadProjectFont({ font });
					if (!isProjectFontLoaded({ family: font.family }))
						throw new Error("The custom Assistant font file is unavailable");
					fontFamily = font.family;
					const response = await fetch("/api/transcription/whisper-cpp", {
						signal,
					});
					const model = await response.json();
					if (!response.ok || !model.ivritLargeV3)
						throw new Error(
							"Full Auto Edit requires the configured ivrit-ai Whisper large-v3 model",
						);
					break;
				}
				case "framing": {
					await runLocalSubjectFraming({
						editor,
						signal,
						onProgress: progress,
						mode: "framing",
					});
					break;
				}
				case "silence": {
					progress("Remove Silences · 0.3 seconds…");
					const scene = editor.scenes.getActiveScene();
					const previous = editor.selection.getSnapshot();
					editor.selection.setSelectedElements({
						elements: scene.tracks.main.elements.map((e) => ({
							trackId: scene.tracks.main.id,
							elementId: e.id,
						})),
					});
					try {
						await editor.timeline.removeAllSilence({
							mode: "audio",
							minSilenceSeconds: 0.3,
							signal,
						});
					} finally {
						editor.selection.restoreSnapshot({ snapshot: previous });
					}
					break;
				}
				case "auto-texts":
					await runAutoTexts({
						editor,
						signal,
						onProgress: progress,
						language: "he",
						settings: {
							...DEFAULT_CAPTION_LAYOUT,
							rows: 1,
							wordsPerRow: 4,
							hidePunctuation: true,
							bottomFadeOutPercent: 60,
						},
					});
					break;
				case "finish":
					progress(
						"Assistant bold · centered captions · 60% / 25% fade · black edge feather…",
					);
					await compileAndApply({ stage: "finish" });
					break;
				case "zoom":
					await runAutomaticZoom({ editor, signal, onProgress: progress });
					break;
				case "transitions":
					await runAutomaticTextTransitions({
						editor,
						signal,
						onProgress: progress,
					});
					break;
				case "word-animation":
					await runAutomaticWordAnimation({
						editor,
						signal,
						onProgress: progress,
					});
					break;
				case "music": {
					const result = await runAutomaticMusic({
						editor,
						signal,
						onProgress: progress,
					});
					notes.push(result.message);
					break;
				}
				case "save":
					progress("Saving for your review…");
					await editor.save.flush();
					break;
			}
			onStep?.({
				completedStages: index + 1,
				totalStages: steps.length,
				stage: steps[index + 1] ?? "",
				message: `Completed ${stage}`,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Unknown error";
			throw new Error(
				`${stage}: ${signal.aborted ? "Cancelled" : detail}. Completed stages remain in the timeline and can be undone; nothing was exported.`,
			);
		}
	}
	return notes;
}
