/* eslint-disable opencut/prefer-object-params -- Worker session callbacks receive separate transcribe and abort arguments. */
import { transcriptionService } from "@/services/transcription/service";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
	TranscriptionResult,
	TranscriptionWord,
} from "./types";
export const TRANSCRIPTION_WINDOW_SECONDS = 60;
const CONTEXT_SECONDS = 5;
export interface TranscriptionWindow {
	index: number;
	words: TranscriptionWord[];
}
export async function transcribeAudioWindows({
	duration,
	signal,
	language,
	onProgress,
	load,
	cache,
	onChunk,
	completedChunks,
	externalTranscribe,
	prefetch = true,
	externalConcurrency = 2,
}: {
	externalTranscribe?: (input: {
		signal?: AbortSignal;
		load: () => Promise<Float32Array>;
		language: TranscriptionLanguage;
		onProgress?: (progress: TranscriptionProgress) => void;
	}) => Promise<TranscriptionResult>;
	onChunk?: (chunk: TranscriptionWindow) => Promise<void>;
	completedChunks?: Record<string, TranscriptionWord[]>;
	duration: number;
	signal: AbortSignal;
	language: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
	load: (range: {
		start: number;
		end: number;
		signal: AbortSignal;
	}) => Promise<Float32Array>;
	cache?: {
		read: (index: number) => Promise<TranscriptionResult | undefined>;
		write: (
			index: number,
			result: TranscriptionResult,
		) => Promise<boolean | void>;
	};
	prefetch?: boolean;
	externalConcurrency?: 1 | 2;
}): Promise<TranscriptionResult> {
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("The timeline has no audio duration");
	const count = Math.ceil(duration / TRANSCRIPTION_WINDOW_SECONDS);
	// The service callback uses the worker session signature.
	const run: Parameters<
		typeof transcriptionService.withChunkSession<TranscriptionResult>
	>[0]["run"] = async (transcribe, sessionSignal) => {
		const controller = new AbortController();
		const activeSignal = AbortSignal.any([sessionSignal, controller.signal]);
		const words: TranscriptionWord[] = [];
		const width = externalTranscribe ? externalConcurrency : 1;
		let decodeTail: Promise<unknown> = Promise.resolve();
		const prepared = new Map<
			number,
			Promise<TranscriptionResult | Float32Array>
		>();
		const jobs = new Map<
			number,
			Promise<{ words: TranscriptionWord[]; saved: boolean }>
		>();
		const range = (index: number) => ({
			start: Math.max(
				0,
				index * TRANSCRIPTION_WINDOW_SECONDS - CONTEXT_SECONDS,
			),
			end: Math.min(
				duration,
				(index + 1) * TRANSCRIPTION_WINDOW_SECONDS + CONTEXT_SECONDS,
			),
			signal: activeSignal,
		});
		const decode = (index: number) => {
			const next = decodeTail.then(() => {
				activeSignal.throwIfAborted();
				return load(range(index));
			});
			decodeTail = next.catch(() => {});
			return next;
		};
		const prepare = (index: number) => {
			if (index >= count || completedChunks?.[index] || prepared.has(index))
				return;
			const pending = (async () => {
				activeSignal.throwIfAborted();
				return (await cache?.read(index)) ?? (await decode(index));
			})();
			// A speculative decode may fail before its consumer reaches it.
			void pending.catch(() => {});
			prepared.set(index, pending);
		};
		const launch = (index: number) => {
			if (index >= count || jobs.has(index)) return;
			const pending = (async () => {
				activeSignal.throwIfAborted();
				const existing = completedChunks?.[index];
				if (existing) return { words: existing, saved: true };
				prepare(index);
				let input = await prepared.get(index)!;
				prepared.delete(index);
				if (prefetch) prepare(index + width);
				let result: TranscriptionResult;
				let saved = true;
				if (input instanceof Float32Array) {
					let firstLoad = true;
					result = await (externalTranscribe ?? transcribe)({
						...(externalTranscribe ? { signal: activeSignal } : {}),
						// Reload on retry: worker transfer detaches the first PCM buffer.
						load: async () => {
							if (!firstLoad) return decode(index);
							firstLoad = false;
							const samples = input as Float32Array;
							input = undefined as unknown as Float32Array;
							return samples;
						},
						language,
						onProgress: (p) =>
							onProgress?.({
								...p,
								progress: (index / count) * 100,
								message: `Section ${index + 1}/${count} · ${p.message ?? "Transcribing"}`,
							}),
					});
					activeSignal.throwIfAborted();
					saved = (await cache?.write(index, result)) === true;
				} else result = input;
				const start = range(index).start;
				const owned = (result.words ?? [])
					.filter((word) => {
						const midpoint = start + (word.start + word.end) / 2;
						return (
							midpoint >= index * TRANSCRIPTION_WINDOW_SECONDS &&
							midpoint <
								Math.min(duration, (index + 1) * TRANSCRIPTION_WINDOW_SECONDS)
						);
					})
					.map((word) => ({
						...word,
						start: start + word.start,
						end: Math.min(duration, start + word.end),
					}));
				return { words: owned, saved };
			})();
			void pending.catch(() => {});
			jobs.set(index, pending);
		};
		try {
			for (let i = 0; i < width; i++) launch(i);
			for (let index = 0; index < count; index++) {
				activeSignal.throwIfAborted();
				const result = await jobs.get(index)!;
				activeSignal.throwIfAborted();
				await onChunk?.({ index, words: result.words });
				activeSignal.throwIfAborted();
				words.push(...result.words);
				jobs.delete(index);
				onProgress?.({
					status: "transcribing",
					progress: ((index + 1) / count) * 100,
					message: `Transcribed ${index + 1}/${count} sections${result.saved ? " · progress saved" : ""}`,
				});
				activeSignal.throwIfAborted();
				launch(index + width);
			}
		} finally {
			controller.abort();
			await Promise.allSettled([
				...jobs.values(),
				...prepared.values(),
				decodeTail,
			]);
			prepared.clear();
		}

		return {
			text: words.map((w) => w.text).join(" "),
			words,
			segments: words,
			language: language === "auto" ? "he" : language,
		};
	};
	return externalTranscribe
		? run(externalTranscribe, signal)
		: transcriptionService.withChunkSession({ signal, run });
}
