import { Input, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { createMediaSource } from "./source";
import { layoutTimedAudioChunks } from "./audio-chunk-layout";

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	url,
	channelMix = "average",
	signal,
}: {
	audioBlob?: Blob;
	url?: string;
	sampleRate?: number;
	/** Preserve activity in any channel for conservative silence analysis. */
	channelMix?: "average" | "max-magnitude";
	signal?: AbortSignal;
}): Promise<DecodedAudio> {
	signal?.throwIfAborted();
	const input = new Input({
		source: createMediaSource({ file: audioBlob, url }),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("Media does not contain an audio track");
		const sink = new AudioBufferSink(track);
		const chunks: Float32Array[] = [];
		const timedChunks: Array<{
			timestampSeconds: number;
			durationSeconds: number;
			sampleLength: number;
		}> = [];
		let totalLength = 0;
		let nativeSampleRate = 0;
		for await (const { buffer, timestamp } of sink.buffers(0)) {
			signal?.throwIfAborted();
			if (
				channelMix === "max-magnitude" &&
				nativeSampleRate &&
				nativeSampleRate !== buffer.sampleRate
			) {
				throw new Error(
					"The source audio changes sample rate and cannot be safely analyzed.",
				);
			}
			nativeSampleRate = buffer.sampleRate;
			const mono = new Float32Array(buffer.length);
			const channels = Array.from(
				{ length: buffer.numberOfChannels },
				(_, index) => buffer.getChannelData(index),
			);
			for (let i = 0; i < buffer.length; i++) {
				let sum = 0;
				let strongest = 0;
				for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
					const sample = channels[channel][i];
					sum += sample;
					if (!Number.isFinite(sample)) strongest = Number.NaN;
					if (Math.abs(sample) > Math.abs(strongest)) strongest = sample;
				}
				mono[i] =
					channelMix === "max-magnitude"
						? strongest
						: sum / Math.max(1, buffer.numberOfChannels);
			}
			chunks.push(mono);
			timedChunks.push({
				timestampSeconds: timestamp,
				durationSeconds: buffer.duration,
				sampleLength: mono.length,
			});
			totalLength += mono.length;
		}
		if (channelMix === "max-magnitude") {
			const layout = layoutTimedAudioChunks({
				chunks: timedChunks,
				sampleRate: nativeSampleRate,
			});
			// Missing decode regions must never masquerade as silence. NaN features
			// make the Rust analyzer retain the clip when coverage is uncertain.
			const samples = new Float32Array(layout.totalSamples).fill(Number.NaN);
			for (const placement of layout.placements) {
				samples.set(
					chunks[placement.chunkIndex].subarray(
						placement.sourceStartSample,
						placement.sourceStartSample + placement.sampleCount,
					),
					placement.outputStartSample,
				);
			}
			return { samples, sampleRate: nativeSampleRate };
		}
		const samples = new Float32Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			samples.set(chunk, offset);
			offset += chunk.length;
		}
		return { samples, sampleRate: nativeSampleRate };
	} finally {
		input.dispose();
	}
}
