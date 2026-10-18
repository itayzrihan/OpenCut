/* eslint-disable opencut/prefer-object-params -- Internal bounded IO callbacks and the shared readSource(start, end) contract. */
import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { collectAudioClips, type AudioClipSource } from "@/media/audio";
import { createMediaSource } from "@/media/source";
import {
	applyAudioMasteringToBuffer,
	getAudioBufferPeak,
} from "@/media/audio-mastering";
import {
	hasAudioProcessing,
	noiseReductionAmount,
	renderNoiseReducedWindow,
} from "@/media/noise-reduction";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import {
	hasVariableAudioGain,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { ExportScratch, checkExportDiskSpace } from "./scratch";
import { PcmFile } from "./pcm-file";
import { streamPitchPreserved } from "./pitch-stream";
import { exportSourceWindows } from "./audio-source-windows";

export const EXPORT_AUDIO_RATE = 44100;
export const EXPORT_AUDIO_WINDOW = 2;
const WINDOW_FRAMES = EXPORT_AUDIO_RATE * EXPORT_AUDIO_WINDOW;

export interface ExportAudioStream {
	sampleRate: number;
	numberOfChannels: number;
	buffers: AsyncIterable<AudioBuffer>;
}

/** At most two decode/DSP jobs; disk backpressure is awaited in every job. */
async function inPairs<T>(
	items: T[],
	run: (item: T, index: number) => Promise<void>,
	onFailure: (error: unknown) => void,
): Promise<void> {
	let next = 0;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(2, items.length) }, async () => {
			while (next < items.length && !failure) {
				const index = next++;
				try {
					await run(items[index], index);
				} catch (error) {
					failure ??= error;
					onFailure(error);
				}
			}
		}),
	);
	if (failure) throw failure;
}

/** Classic host adapter. Uses canonical clip timing/gain/DSP; the temporary
 * PCM files are disposable media, never an alternative project/history store. */
export async function prepareExportAudio({
	tracks,
	mediaAssets,
	duration,
	additionalClips,
	scratch,
	signal: parentSignal,
	onProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	additionalClips: AudioClipSource[];
	scratch: ExportScratch;
	signal: AbortSignal;
	onProgress: (progress: number, phase: string) => void;
}): Promise<ExportAudioStream | undefined> {
	const jobs = new AbortController();
	const signal = AbortSignal.any([parentSignal, jobs.signal]);
	const stopJobs = (error: unknown) => jobs.abort(error);
	const clips = (
		await collectAudioClips({
			tracks,
			mediaAssets,
			additionalClips: Promise.resolve(additionalClips),
		})
	).filter(
		(clip) =>
			!clip.muted &&
			clip.duration > 0 &&
			clip.startTime < duration / TICKS_PER_SECOND &&
			clip.startTime + clip.duration > 0,
	);
	if (!clips.length) return undefined;
	signal.throwIfAborted();
	// A small OfflineAudioContext is just a buffer factory. Never allocate an
	// OfflineAudioContext whose length is the duration of the complete episode.
	const context = new OfflineAudioContext(2, 1, EXPORT_AUDIO_RATE);
	const sources = [
		...new Map(clips.map((clip) => [clip.sourceKey, clip])).values(),
	];
	const seconds = duration / TICKS_PER_SECOND;
	const windows = new Map(
		sources.map((source) => [
			source.sourceKey,
			exportSourceWindows(
				clips.filter((clip) => clip.sourceKey === source.sourceKey),
			),
		]),
	);
	const estimate =
		sources.reduce(
			(n, clip) =>
				n +
				windows
					.get(clip.sourceKey)!
					.reduce((sum, window) => sum + window.end - window.start, 0) *
					48000 *
					2 *
					4,
			0,
		) +
		clips.reduce(
			(n, clip) => n + clip.duration * EXPORT_AUDIO_RATE * 2 * 4,
			0,
		) +
		seconds * EXPORT_AUDIO_RATE * 2 * 4;
	await checkExportDiskSpace(estimate + 64 * 1024 ** 2);
	const sourcePcm = new Map<
		string,
		Array<{ pcm: PcmFile; origin: number; end: number }>
	>();
	const temporary = new Set<string>();
	const sourceProgress = sources.map(() => 0);
	const clipProgress = clips.map(() => 0);
	let lastReport = 0;
	const report = (progress: number, phase: string, force = false) => {
		if (force || performance.now() - lastReport >= 250) {
			lastReport = performance.now();
			onProgress(progress, phase);
		}
	};
	const sourceReport = (index: number, progress: number, force = false) => {
		sourceProgress[index] = progress;
		report(
			(0.35 * sourceProgress.reduce((n, p) => n + p, 0)) / sources.length,
			"Reading audio to disk",
			force,
		);
	};
	const clipReport = (index: number, progress: number, force = false) => {
		clipProgress[index] = progress;
		report(
			0.35 + (0.4 * clipProgress.reduce((n, p) => n + p, 0)) / clips.length,
			"Processing audio",
			force,
		);
	};
	try {
		await inPairs(
			sources,
			async (clip, index) => {
				signal.throwIfAborted();
				const input = new Input({
					formats: ALL_FORMATS,
					source: createMediaSource({
						...clip,
						urlOptions: { maxCacheSize: 8 * 1024 ** 2 },
					}),
				});
				const abort = () => input.dispose();
				signal.addEventListener("abort", abort, { once: true });
				let pcm: PcmFile | undefined;
				try {
					const track = await input.getPrimaryAudioTrack();
					if (!track)
						throw new Error(`No audio track in ${clip.timelineElement.name}`);
					const ranges = windows.get(clip.sourceKey)!;
					const totalSeconds = ranges.reduce(
						(sum, range) => sum + range.end - range.start,
						0,
					);
					let completedSeconds = 0;
					const decoded: Array<{ pcm: PcmFile; origin: number; end: number }> =
						[];
					for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
						const range = ranges[rangeIndex];
						const name = `source-${index}-${rangeIndex}.pcm`;
						temporary.add(name);
						pcm = new PcmFile(
							await scratch.file(name),
							track.sampleRate,
							Math.min(2, track.numberOfChannels),
						);
						await pcm.open();
						// Each interval uses a continuous decoder with AAC priming handles.
						// PCM is stored relative to its source origin, without giant holes.
						const origin = Math.floor(range.start * pcm.sampleRate);
						for await (const chunk of new AudioBufferSink(track).buffers(
							origin / pcm.sampleRate,
							range.end,
						)) {
							signal.throwIfAborted();
							if (chunk.buffer.sampleRate !== pcm.sampleRate)
								throw new Error("Audio sample rate changed during export");
							const first =
								Math.round(chunk.timestamp * pcm.sampleRate) - origin;
							const skip = Math.max(0, -first);
							if (skip < chunk.buffer.length)
								await pcm.write(chunk.buffer, Math.max(0, first), skip);
							sourceReport(
								index,
								Math.min(
									1,
									(completedSeconds +
										Math.max(
											0,
											chunk.timestamp + chunk.buffer.duration - range.start,
										)) /
										totalSeconds,
								),
							);
						}
						await pcm.seal();
						decoded.push({ pcm, origin, end: range.end });
						completedSeconds += range.end - range.start;
					}
					sourcePcm.set(clip.sourceKey, decoded);
					sourceReport(index, 1, true);
				} catch (error) {
					await pcm?.abort();
					throw error;
				} finally {
					signal.removeEventListener("abort", abort);
					input.dispose();
				}
			},
			stopJobs,
		);

		const rendered = new Map<AudioClipSource, PcmFile>();
		await inPairs(
			clips,
			async (clip, index) => {
				const intervals = sourcePcm.get(clip.sourceKey)!;
				const name = `clip-${index}.pcm`;
				temporary.add(name);
				const pcm = new PcmFile(await scratch.file(name), EXPORT_AUDIO_RATE, 2);
				await pcm.open();
				const readSource = async (start: number, end: number) => {
					signal.throwIfAborted();
					const interval = intervals.find(
						({ pcm, origin, end: rangeEnd }) =>
							start >= origin / pcm.sampleRate - 1e-6 && start <= rangeEnd,
					);
					if (!interval) throw new Error("Export audio range was not prepared");
					const source = interval.pcm;
					// Filter handles and a globally anchored resampling clock avoid seams
					// when the source and export sample rates differ.
					let first = Math.max(
						0,
						Math.floor((start - 0.05) * source.sampleRate),
					);
					// Align both integer sample clocks. Web Audio rounds fractional
					// source.start offsets; that would shift each resampled window.
					let a = source.sampleRate,
						b = EXPORT_AUDIO_RATE;
					while (b) [a, b] = [b, a % b];
					const alignment = source.sampleRate / a;
					first = Math.floor(first / alignment) * alignment;
					const last = Math.max(
						first + 1,
						Math.ceil((end + 0.05) * source.sampleRate),
					);
					const native = await source.read(
						context,
						first - interval.origin,
						last - first,
					);
					if (source.sampleRate === EXPORT_AUDIO_RATE)
						return {
							buffer: native,
							trimStart: start - first / source.sampleRate,
						};
					const targetFirst = Math.round(
						(first * EXPORT_AUDIO_RATE) / source.sampleRate,
					);
					const targetStart = targetFirst / EXPORT_AUDIO_RATE;
					const resampler = new OfflineAudioContext(
						2,
						Math.max(
							1,
							Math.ceil(
								(last / source.sampleRate - targetStart) * EXPORT_AUDIO_RATE,
							),
						),
						EXPORT_AUDIO_RATE,
					);
					const node = resampler.createBufferSource();
					node.buffer = native;
					node.connect(resampler.destination);
					node.start(0);
					return {
						buffer: await resampler.startRendering(),
						trimStart: start - targetStart,
					};
				};
				try {
					const length = Math.ceil(clip.duration * EXPORT_AUDIO_RATE);
					if (
						!hasAudioProcessing(clip.timelineElement.params) &&
						clip.retime?.maintainPitch &&
						Math.abs(clip.retime.rate - 1) > 1e-6
					) {
						let first = 0;
						for await (const buffer of streamPitchPreserved({
							context,
							trimStart: clip.trimStart,
							duration: clip.duration,
							rate: clip.retime.rate,
							readSource,
							signal,
						})) {
							await pcm.write(buffer, first);
							first += buffer.length;
							clipReport(index, first / length);
						}
					} else
						for (let first = 0; first < length; first += WINDOW_FRAMES) {
							signal.throwIfAborted();
							const count = Math.min(WINDOW_FRAMES, length - first);
							const offset = first / EXPORT_AUDIO_RATE;
							let buffer: AudioBuffer | null;
							if (hasAudioProcessing(clip.timelineElement.params)) {
								buffer = await renderNoiseReducedWindow({
									audioContext: context,
									clip,
									offset,
									duration: Math.min(
										EXPORT_AUDIO_WINDOW,
										clip.duration - offset,
									),
									amount: noiseReductionAmount(clip.timelineElement.params),
									readSource,
									signal,
								});
							} else {
								const start =
									clip.trimStart +
									getSourceTimeAtClipTime({
										clipTime: offset,
										retime: clip.retime,
									});
								const end =
									clip.trimStart +
									getSourceTimeAtClipTime({
										clipTime: offset + count / EXPORT_AUDIO_RATE,
										retime: clip.retime,
									});
								const decoded = await readSource(start, end);
								const stretched = await renderRetimedBuffer({
									audioContext: context,
									sourceBuffer: decoded.buffer,
									trimStart: decoded.trimStart,
									clipDuration: count / EXPORT_AUDIO_RATE,
									retime: clip.retime,
									maintainPitch: clip.retime?.maintainPitch,
								});
								buffer = context.createBuffer(2, count, EXPORT_AUDIO_RATE);
								for (let ch = 0; ch < 2; ch++)
									buffer.copyToChannel(
										stretched
											.getChannelData(
												Math.min(ch, stretched.numberOfChannels - 1),
											)
											.subarray(0, count),
										ch,
									);
							}
							if (!buffer)
								throw new Error(
									`Could not process ${clip.timelineElement.name}`,
								);
							await pcm.write(buffer, first, 0, Math.min(count, buffer.length));
							clipReport(index, (first + count) / length);
						}
					await pcm.seal(length);
					rendered.set(clip, pcm);
					clipReport(index, 1, true);
				} catch (error) {
					await pcm.abort();
					throw error;
				}
			},
			stopJobs,
		);
		for (const name of temporary)
			if (name.startsWith("source-")) await scratch.remove(name);
		sourcePcm.clear();

		const mix = new PcmFile(
			await scratch.file("mix.pcm"),
			EXPORT_AUDIO_RATE,
			2,
		);
		await mix.open();
		let peak = 0;
		const total = Math.ceil(seconds * EXPORT_AUDIO_RATE);
		try {
			for (let first = 0; first < total; first += WINDOW_FRAMES) {
				signal.throwIfAborted();
				const count = Math.min(WINDOW_FRAMES, total - first);
				const buffer = context.createBuffer(2, count, EXPORT_AUDIO_RATE);
				for (const clip of clips) {
					const clipStart = Math.floor(clip.startTime * EXPORT_AUDIO_RATE);
					const pcm = rendered.get(clip)!;
					const start = Math.max(first, clipStart);
					const end = Math.min(first + count, clipStart + pcm.frames);
					if (end <= start) continue;
					const samples = await pcm.read(
						context,
						start - clipStart,
						end - start,
					);
					const baked = clip.timelineElement.params.hardLimiterEnabled === true;
					const variable =
						!baked && hasVariableAudioGain({ element: clip.timelineElement });
					const constant = baked ? 1 : clip.volume;
					const gains = variable
						? Float32Array.from({ length: end - start }, (_, i) =>
								resolveEffectiveAudioGain({
									element: clip.timelineElement,
									localTime: (start - clipStart + i) / EXPORT_AUDIO_RATE,
								}),
							)
						: undefined;
					for (let ch = 0; ch < 2; ch++) {
						const src = samples.getChannelData(ch),
							dst = buffer.getChannelData(ch);
						for (let i = 0; i < end - start; i++)
							dst[start - first + i] += src[i] * (gains?.[i] ?? constant);
					}
				}
				peak = Math.max(peak, getAudioBufferPeak({ audioBuffer: buffer }));
				await mix.write(buffer, first);
				report(
					0.75 + (0.25 * (first + count)) / total,
					"Mixing audio",
					first + count === total,
				);
			}
			await mix.seal();
		} catch (error) {
			await mix.abort();
			throw error;
		}
		// Preserve the whole-timeline mastering decision, rather than toggling the
		// compressor on/off independently for loud and quiet windows.
		return {
			sampleRate: EXPORT_AUDIO_RATE,
			numberOfChannels: 2,
			buffers: (async function* () {
				for (let first = 0; first < total; first += WINDOW_FRAMES) {
					signal.throwIfAborted();
					const count = Math.min(WINDOW_FRAMES, total - first);
					if (peak <= 0.98) {
						yield await mix.read(context, first, count);
						continue;
					}
					const warm = Math.min(first, 2 * EXPORT_AUDIO_RATE);
					const input = await mix.read(
						context,
						first - warm,
						warm +
							count +
							Math.min(EXPORT_AUDIO_RATE / 10, total - first - count),
					);
					const mastered = await applyAudioMasteringToBuffer({
						audioBuffer: input,
						force: true,
					});
					const output = context.createBuffer(2, count, EXPORT_AUDIO_RATE);
					for (let ch = 0; ch < 2; ch++)
						output.copyToChannel(
							mastered.getChannelData(ch).subarray(warm, warm + count),
							ch,
						);
					yield output;
				}
			})(),
		};
	} finally {
		for (const name of temporary) await scratch.remove(name);
	}
}
