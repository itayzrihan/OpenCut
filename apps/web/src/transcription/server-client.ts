import { z } from "zod";
import type { TranscriptionLanguage, TranscriptionResult } from "./types";

const TRANSCRIPTION_FETCH_RETRY_COUNT = 1;
const TRANSCRIPTION_FETCH_RETRY_DELAY_MS = 750;

const transcriptionResultSchema = z.object({
	text: z.string(),
	segments: z.array(
		z.object({
			text: z.string(),
			start: z.number(),
			end: z.number(),
		}),
	),
	words: z
		.array(
			z.object({
				text: z.string(),
				start: z.number(),
				end: z.number(),
			}),
		)
		.optional(),
	language: z.string(),
});

function isFetchNetworkError({ error }: { error: unknown }): boolean {
	return (
		error instanceof TypeError &&
		/(failed to fetch|networkerror|load failed|fetch)/i.test(error.message)
	);
}

function sleep({ delayMs }: { delayMs: number }): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

export async function transcribeTimelineAudioBlob({
	audioBlob,
	language,
	signal,
}: {
	audioBlob: Blob;
	language: TranscriptionLanguage;
	signal?: AbortSignal;
}): Promise<TranscriptionResult> {
	const formData = new FormData();
	formData.append("audio", audioBlob, "timeline.webm");
	formData.append("language", language === "auto" ? "he" : language);

	let lastError: unknown = null;
	for (
		let attempt = 0;
		attempt <= TRANSCRIPTION_FETCH_RETRY_COUNT;
		attempt += 1
	) {
		try {
			const response = await fetch("/api/transcription/whisper-cpp", {
				method: "POST",
				body: formData,
				signal,
			});
			if (!response.ok) {
				const error = await response.json().catch(() => null);
				throw new Error(
					error?.error || `Transcription failed: ${response.status}`,
				);
			}
			return transcriptionResultSchema.parse(await response.json());
		} catch (error) {
			lastError = error;
			if (
				signal?.aborted ||
				!isFetchNetworkError({ error }) ||
				attempt >= TRANSCRIPTION_FETCH_RETRY_COUNT
			) {
				break;
			}
			await sleep({ delayMs: TRANSCRIPTION_FETCH_RETRY_DELAY_MS });
		}
	}

	if (signal?.aborted) {
		throw new DOMException("Transcription cancelled", "AbortError");
	}
	if (
		lastError instanceof Error &&
		!isFetchNetworkError({ error: lastError })
	) {
		throw lastError;
	}
	throw new Error(
		"Could not reach the local transcription service. The dev server may have reloaded while transcription was running; try again.",
		{ cause: lastError },
	);
}
