/* eslint-disable opencut/prefer-object-params -- Checkpoint adapter implements the indexed cache interface. */
/** Browser IO for long recordings: bounded audio windows and disposable text checkpoints. */
import { collectAudioClips } from "@/media/audio";
import {
	openAudioWindowReader,
	SPEECH_SAMPLE_RATE,
} from "@/media/audio-window";
import { hasAudioProcessing } from "@/media/noise-reduction";
import { hasVariableAudioGain } from "@/timeline/audio-state";
import {
	BROWSER_WHISPER_REVISION,
	BROWSER_WHISPER_CPU_REVISION,
} from "./models";
import { reuseAudioContext } from "./overlap-reader";
import { transcribeAudioWindows } from "./windows";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
	TranscriptionResult,
} from "./types";

type TimelineInput = {
	engine?: import("./job").TranscriptionEngine;
	externalConfiguration?: string | null;
	onChunk?: (chunk: import("./windows").TranscriptionWindow) => Promise<void>;
	completedChunks?: Record<string, import("./types").TranscriptionWord[]>;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDuration: number;
	signal: AbortSignal;
	language: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
};

async function openTimelineReader(input: TimelineInput) {
	const { tracks, mediaAssets, totalDuration, signal, onProgress } = input;
	const clips = (await collectAudioClips({ tracks, mediaAssets })).filter(
		(c) => !c.muted && c.duration > 0,
	);
	if (!clips.length) throw new Error("There is no audible audio to transcribe");
	const clip = clips[0];
	// The common unprocessed podcast avoids whole-episode mixing and disk staging.
	if (
		clips.length === 1 &&
		(!clip.retime || clip.retime.rate === 1) &&
		!hasAudioProcessing(clip.timelineElement.params) &&
		!hasVariableAudioGain({ element: clip.timelineElement })
	) {
		const reader = await openAudioWindowReader({ asset: clip, signal });
		return {
			close: async () => reader.close(),
			read: async ({ start, end }: { start: number; end: number }) => {
				const result = new Float32Array(
					Math.ceil((end - start) * SPEECH_SAMPLE_RATE),
				);
				const first = Math.max(start, clip.startTime),
					last = Math.min(end, clip.startTime + clip.duration);
				if (last > first) {
					const samples = await reader.read({
						start: clip.trimStart + first - clip.startTime,
						end: clip.trimStart + last - clip.startTime,
					});
					const offset = Math.round((first - start) * SPEECH_SAMPLE_RATE);
					for (let i = 0; i < samples.length && offset + i < result.length; i++)
						result[offset + i] = samples[i] * clip.volume;
				}
				return result;
			},
		};
	}
	// Edited mixes retain the shared canonical gain, timing, pitch and DSP path.
	// It spills PCM to disk and processes two-second buffers, never an episode-sized ArrayBuffer.
	const [{ prepareExportAudio }, { ExportScratch }, { PcmFile }] =
		await Promise.all([
			import("@/export/audio-stream"),
			import("@/export/scratch"),
			import("@/export/pcm-file"),
		]);
	const scratch = await ExportScratch.create();
	try {
		const stream = await prepareExportAudio({
			tracks,
			mediaAssets,
			duration: totalDuration,
			additionalClips: [],
			scratch,
			signal,
			onProgress: (progress, message) =>
				onProgress?.({
					status: "transcribing",
					progress: 0,
					message: `${message} · ${Math.round(progress * 100)}%`,
				}),
		});
		if (!stream) throw new Error("There is no audible audio to transcribe");
		const pcm = new PcmFile(
			await scratch.file("speech.pcm"),
			SPEECH_SAMPLE_RATE,
			1,
		);
		await pcm.open();
		let at = 0;
		try {
			for await (const buffer of stream.buffers) {
				signal.throwIfAborted();
				const context = new OfflineAudioContext(
					1,
					Math.round(buffer.duration * SPEECH_SAMPLE_RATE),
					SPEECH_SAMPLE_RATE,
				);
				const node = context.createBufferSource();
				node.buffer = buffer;
				node.connect(context.destination);
				node.start();
				const mono = await context.startRendering();
				await pcm.write(mono, at);
				at += mono.length;
			}
			await pcm.seal();
		} catch (error) {
			await pcm.abort();
			throw error;
		}
		const context = new OfflineAudioContext(1, 1, SPEECH_SAMPLE_RATE);
		return {
			close: () => scratch.dispose(),
			read: async ({ start, end }: { start: number; end: number }) => {
				signal.throwIfAborted();
				return (
					await pcm.read(
						context,
						Math.round(start * SPEECH_SAMPLE_RATE),
						Math.ceil((end - start) * SPEECH_SAMPLE_RATE),
					)
				).getChannelData(0);
			},
		};
	} catch (error) {
		await scratch.dispose();
		throw error;
	}
}

/** Checkpoints contain provider output only. Canonical insertion still validates the
 * captured scene/revision. Account + complete timeline/media fingerprint prevents stale reuse. */
async function checkpointStore(input: TimelineInput) {
	if (!globalThis.caches || !globalThis.crypto?.subtle) return undefined;
	const account = window.__opencutAccountId;
	if (!account) return undefined;
	const identity = JSON.stringify({
		version: 2,
		engine: input.engine ?? "local",
		externalConfiguration: input.externalConfiguration,
		models: [BROWSER_WHISPER_REVISION, BROWSER_WHISPER_CPU_REVISION],
		account,
		language: input.language,
		tracks: input.tracks,
		duration: input.totalDuration,
		assets: input.mediaAssets.map((a) => ({
			id: a.id,
			size: a.file?.size ?? a.size,
			modified: a.file?.lastModified ?? a.lastModified,
			url: a.url?.startsWith("blob:") ? undefined : a.url,
			sourcePath: a.sourcePath,
			bindingRevision: a.bindingRevision,
			unifiedAngles: a.unifiedAngles,
			duration: a.duration,
		})),
	});
	const hash = Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
		),
		(n) => n.toString(16).padStart(2, "0"),
	).join("");
	try {
		const cache = await caches.open(`opencut-transcription-${account}`);
		const keys = await cache.keys();
		for (const old of keys.slice(0, Math.max(0, keys.length - 1800)))
			await cache.delete(old);
		const key = (index: number) =>
			new URL(`/__transcription_checkpoint__/${hash}/${index}`, location.origin)
				.href;
		return {
			read: async (index: number): Promise<TranscriptionResult | undefined> => {
				try {
					const response = await cache.match(key(index));
					if (!response) return undefined;
					if (
						Date.now() - Number(response.headers.get("X-Created")) >
						7 * 86400000
					) {
						await cache.delete(key(index));
						return undefined;
					}
					const result: TranscriptionResult = await response.json();
					return Array.isArray(result.words) &&
						result.words.length <= 10000 &&
						result.words.every(
							(w) =>
								typeof w.text === "string" &&
								Number.isFinite(w.start) &&
								Number.isFinite(w.end) &&
								w.start >= 0 &&
								w.end >= w.start &&
								w.end <= 90,
						)
						? result
						: undefined;
				} catch {
					return undefined;
				}
			},
			write: async (index: number, result: TranscriptionResult) => {
				if (window.__opencutAccountId !== account) return false;
				try {
					await cache.put(
						key(index),
						Response.json(result, {
							headers: { "X-Created": String(Date.now()) },
						}),
					);
					return true;
				} catch {
					/* A full cache must not discard an otherwise successful transcript. */
					return false;
				}
			},
		};
	} catch {
		return undefined;
	}
}

export async function transcribeTimelineStream(
	input: TimelineInput,
): Promise<TranscriptionResult> {
	const account = window.__opencutAccountId;
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setInterval(() => {
		if (window.__opencutAccountId !== account) abort();
	}, 250);
	window.addEventListener("pagehide", abort);
	input = {
		...input,
		signal: AbortSignal.any([input.signal, controller.signal]),
	};
	let reader: Awaited<ReturnType<typeof openTimelineReader>> | undefined;
	let read: ReturnType<typeof reuseAudioContext> | undefined;
	try {
		const cache = await checkpointStore(input);
		return await transcribeAudioWindows({
			...input,
			duration: input.totalDuration / 120000,
			cache,
			externalTranscribe:
				input.engine === "external"
					? async ({ load, language, onProgress, signal }) => {
							if (!account || !input.externalConfiguration)
								throw new Error("Configure the transcription API first");
							const { transcribeExternalWindow } =
								await import("./external-client");
							const samples = await load();
							onProgress?.({
								status: "transcribing",
								progress: 0,
								message: "Transcribing with external API…",
							});
							return transcribeExternalWindow({
								samples,
								language,
								signal: signal ?? input.signal,
								configuration: input.externalConfiguration,
								account,
							});
						}
					: undefined,
			load: async ({ start, end, signal }) => {
				reader ??= await openTimelineReader({ ...input, signal });
				read ??= reuseAudioContext({ read: reader.read });
				return read({ start, end });
			},
		});
	} finally {
		clearInterval(timer);
		window.removeEventListener("pagehide", abort);
		await reader?.close();
	}
}
