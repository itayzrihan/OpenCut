import { buildStreamingSourceWaveformSummary } from "./streaming";
import {
	buildSourceWaveformSummaryFromChannels,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";

export type WaveformWorkerMessage =
	| {
			type: "build-stream-summary";
			sourceKey: string;
			sourceFile?: File;
			audioUrl?: string;
	  }
	| {
			type: "build-summary";
			sourceKey: string;
			channelData: Float32Array[];
			sampleRate: number;
			totalSamples: number;
			bucketSize?: number;
	  };

export type WaveformWorkerResponse =
	| { type: "build-summary-complete"; summary: SourceWaveformSummary }
	| { type: "build-summary-error"; error: string };

self.onmessage = async (event: MessageEvent<WaveformWorkerMessage>) => {
	const message = event.data;

	if (
		message.type !== "build-summary" &&
		message.type !== "build-stream-summary"
	) {
		return;
	}

	try {
		const summary =
			message.type === "build-stream-summary"
				? await buildStreamingSourceWaveformSummary(message)
				: buildSourceWaveformSummaryFromChannels({
						sourceKey: message.sourceKey,
						channelData: message.channelData,
						sampleRate: message.sampleRate,
						totalSamples: message.totalSamples,
						bucketSize: message.bucketSize,
					});
		const transfer =
			summary.amplitudes.buffer instanceof ArrayBuffer
				? [summary.amplitudes.buffer]
				: [];

		self.postMessage(
			{
				type: "build-summary-complete",
				summary,
			} satisfies WaveformWorkerResponse,
			{ transfer },
		);
	} catch (error) {
		self.postMessage({
			type: "build-summary-error",
			error: error instanceof Error ? error.message : String(error),
		} satisfies WaveformWorkerResponse);
	}
};
