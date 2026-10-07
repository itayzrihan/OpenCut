/** Platform adapter only: local audio decoding, transcription and guarded commit.
 * Rust owns gap membership, deduplication, caption construction and style reuse. */
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { resolveAudioBufferForAsset } from "@/media/audio";
import { resolveUnifiedAnglesAudioAsset } from "@/media/unified-angles";
import { transcriptionService } from "@/services/transcription/service";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "@/ai/timeline-document-v2";
import { restoreSilenceCaptions } from "opencut-wasm";
import { updateSceneInArray } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import type { SilenceRestoration } from "./restore-silence";
import type { TranscriptionWord } from "@/transcription/types";

const SAMPLE_RATE = 16_000;
const TICKS = 120_000;
const CONTEXT_SECONDS = 1;

export interface RestoreCaptionDependencies {
	decode: (options: {
		asset: MediaAsset;
		signal: AbortSignal;
	}) => Promise<AudioBuffer>;
	transcribe: typeof transcriptionService.transcribe;
	compile: typeof restoreSilenceCaptions;
	id: () => string;
}
const dependencies: RestoreCaptionDependencies = {
	async decode({ asset, signal }) {
		signal.throwIfAborted();
		const context = new AudioContext({ sampleRate: SAMPLE_RATE });
		try {
			const buffer = await resolveAudioBufferForAsset({
				asset,
				audioContext: context,
			});
			signal.throwIfAborted();
			if (!buffer) throw new Error("לא נמצא אודיו זמין בקליפ ששוחזר");
			return buffer;
		} finally {
			await context.close();
		}
	},
	transcribe: (options) => transcriptionService.transcribe(options),
	compile: restoreSilenceCaptions,
	id: generateUUID,
};

export function canFillRestoredCaptions(editor: EditorCore): boolean {
	return editor.scenes
		.getActiveScene()
		.tracks.overlay.some(
			(track) =>
				track.type === "text" &&
				track.captionSource &&
				track.elements.length > 0 &&
				!("locked" in track && track.locked) &&
				!track.hidden,
		);
}

export async function fillRestoredSilenceCaptions({
	editor,
	restoration,
	signal,
	onProgress,
	adapters = dependencies,
}: {
	editor: EditorCore;
	restoration: SilenceRestoration;
	signal: AbortSignal;
	onProgress?: (message: string) => void;
	adapters?: RestoreCaptionDependencies;
}) {
	const assertCurrent = () => {
		signal.throwIfAborted();
		const project = editor.project.getActive();
		const scene = editor.scenes.getActiveScene();
		if (
			project.metadata.id !== restoration.projectId ||
			scene.id !== restoration.sceneId ||
			buildTimelineDocumentV2({ project, scene }).baseRevision !==
				restoration.restoredRevision
		) {
			throw new Error(
				"הטיימליין השתנה מאז השחזור. הכתוביות הקיימות נשמרו ולא נוספו כתוביות חדשות.",
			);
		}
		return { project, scene };
	};
	assertCurrent();
	await editor.command.enableCanonical();
	const { project, scene } = assertCurrent();
	const source = buildTimelineDocumentV2({ project, scene });
	if (!source.valid)
		throw new Error("לא ניתן לקרוא את הטיימליין לצורך השלמת הכתוביות");
	const media = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const decoded = new Map<string, AudioBuffer>();
	const transcripts: { intervalIndex: number; words: TranscriptionWord[] }[] =
		[];
	for (const [intervalIndex, gap] of restoration.restoredIntervals.entries()) {
		assertCurrent();
		const sourceStart = gap.audioSourceStart ?? gap.sourceStart;
		const sourceEnd = gap.audioSourceEnd ?? gap.sourceEnd;
		if (sourceEnd <= sourceStart) {
			transcripts.push({ intervalIndex, words: [] });
			continue;
		}
		onProgress?.(
			`משלימים מלל בקטע ${intervalIndex + 1} מתוך ${restoration.restoredIntervals.length}…`,
		);
		const original = media.get(gap.mediaId);
		const asset =
			original &&
			resolveUnifiedAnglesAudioAsset({ asset: original, mediaMap: media });
		if (!asset) throw new Error("קובץ המקור של הקטע המשוחזר אינו זמין");
		let buffer = decoded.get(asset.id);
		if (!buffer) {
			buffer = await adapters.decode({ asset, signal });
			decoded.set(asset.id, buffer);
		}
		assertCurrent();
		if (buffer.sampleRate !== SAMPLE_RATE)
			throw new Error("Audio decoder returned an unexpected sample rate");
		if (sourceEnd / TICKS > buffer.duration + 1 / SAMPLE_RATE)
			throw new Error("קובץ המקור אינו מכיל את כל טווח האודיו ששוחזר");
		const startSample = Math.max(
			0,
			Math.floor((sourceStart / TICKS - CONTEXT_SECONDS) * SAMPLE_RATE),
		);
		const endSample = Math.min(
			buffer.length,
			Math.ceil((sourceEnd / TICKS + CONTEXT_SECONDS) * SAMPLE_RATE),
		);
		if (endSample <= startSample)
			throw new Error("טווח האודיו המשוחזר חורג מקובץ המקור");
		// Select a real channel: averaging opposite-polarity stereo can erase speech,
		// while switching channel at every sample distorts the transcription input.
		let bestChannel = 0;
		let bestEnergy = -1;
		for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
			const data = buffer.getChannelData(channel);
			let energy = 0;
			for (let i = startSample; i < endSample; i++) energy += data[i] * data[i];
			if (energy > bestEnergy) {
				bestEnergy = energy;
				bestChannel = channel;
			}
		}
		const samples = buffer
			.getChannelData(bestChannel)
			.slice(startSample, endSample);
		const result = await adapters.transcribe({
			audioData: samples,
			language: editor.transcription.getState().language ?? "auto",
			signal,
			onProgress: (progress) => {
				if (!signal.aborted && progress.message) onProgress?.(progress.message);
			},
		});
		assertCurrent();
		if (!result.words?.length && result.text.trim()) {
			throw new Error(
				"התמלול חזר ללא זמני מילים. הכתוביות הקיימות נשמרו; נסו שוב.",
			);
		}
		transcripts.push({
			intervalIndex,
			words: (result.words ?? []).map((word) => ({
				...word,
				start: word.start + startSample / SAMPLE_RATE,
				end: word.end + startSample / SAMPLE_RATE,
			})),
		});
	}
	const result = adapters.compile({
		sourceJson: source.formattedText,
		intervalsJson: JSON.stringify(restoration.restoredIntervals),
		transcriptsJson: JSON.stringify(transcripts),
		idPrefix: `restore-caption-${adapters.id()}`,
	});
	if (!result.valid) throw new Error(result.error);
	assertCurrent();
	if (result.insertedWordCount === 0) return result;
	const parsed = parseTimelineDocumentV2({ text: result.sourceJson });
	const value = parsed.value;
	if (!parsed.valid || !value)
		throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
	editor.command.executeSilenceTransaction({
		operation: "repair-captions",
		execute: () => {
			assertCurrent();
			editor.scenes.setScenes({
				scenes: updateSceneInArray({
					scenes: editor.scenes.getScenes(),
					sceneId: scene.id,
					updates: { tracks: value.tracks, bookmarks: value.bookmarks },
				}),
				activeSceneId: scene.id,
			});
			editor.save.markDirty();
		},
	});
	return result;
}
