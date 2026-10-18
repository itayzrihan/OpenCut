import { openAudioWindowReader } from "@/media/audio-window";
import { transcribeAudioWindows } from "./windows";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
	TranscriptionResult,
} from "./types";

/** Decode bounded ranges of the Blob; never materialize its complete PCM or bytes. */
export async function transcribeTimelineAudioBlob({
	audioBlob,
	language,
	signal = new AbortController().signal,
	onProgress,
}: {
	audioBlob: Blob;
	language: TranscriptionLanguage;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<TranscriptionResult> {
	const reader = await openAudioWindowReader({
		asset: { file: audioBlob },
		signal,
	});
	try {
		return await transcribeAudioWindows({
			duration: await reader.duration(),
			language,
			signal,
			onProgress,
			load: (range) => reader.read(range),
		});
	} finally {
		reader.close();
	}
}
