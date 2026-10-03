import {
	transcriptionService,
	assertBrowserTranscriptionAvailable,
} from "@/services/transcription/service";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
	TranscriptionResult,
} from "./types";

/** Web Audio decodes/resamples locally; no audio is sent to an HTTP endpoint. */
export async function transcribeTimelineAudioBlob({
	audioBlob,
	language,
	signal,
	onProgress,
}: {
	audioBlob: Blob;
	language: TranscriptionLanguage;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<TranscriptionResult> {
	assertBrowserTranscriptionAvailable();
	signal?.throwIfAborted();
	const account = window.__opencutAccountId;
	const context = new OfflineAudioContext(1, 1, 16000);
	const decoded = await context.decodeAudioData(await audioBlob.arrayBuffer());
	signal?.throwIfAborted();
	if (window.__opencutAccountId !== account)
		throw new DOMException("Account changed", "AbortError");
	const mono = new Float32Array(decoded.length);
	for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
		const samples = decoded.getChannelData(channel);
		for (let i = 0; i < mono.length; i++)
			mono[i] += samples[i] / decoded.numberOfChannels;
	}
	return transcriptionService.transcribe({
		audioData: mono,
		language,
		signal,
		onProgress,
	});
}
