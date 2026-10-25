import type { PodcastSyncSettings } from "./engine";
import { readEnergyEnvelope } from "./energy-reader";
import type { BrowserMediaSource } from "@/media/source";
type Segment = {
	asset: BrowserMediaSource & { name: string };
	start: number;
	duration: number;
};
type Request =
	| { type: "read"; asset: BrowserMediaSource & { name: string } }
	| {
			type: "precision";
			referenceSegments?: Segment[];
			targetSegments?: Segment[];
			reference: BrowserMediaSource & { name: string };
			target: BrowserMediaSource & { name: string };
			window: import("opencut-wasm").PodcastPrecisionWindow;
	  }
	| { type: "align"; envelopes: Float32Array[]; maxLagSeconds: number }
	| {
			type: "route";
			advanced?: import("opencut-wasm").AdvancedPodcastRouting;
			envelopes: Float32Array[];
			channelIds: string[];
			cameraWindows: import("opencut-wasm").PodcastCameraWindow[];
			duration: number;
			settings: PodcastSyncSettings;
	  };
self.onmessage = async (event: MessageEvent<Request>) => {
	try {
		const message = event.data;
		if (message.type === "read") {
			const result = await readEnergyEnvelope({
				asset: message.asset,
				windowSeconds: 0.01,
			});
			self.postMessage({ result }, { transfer: [result.buffer] });
		} else if (message.type === "precision") {
			const { estimatePodcastPrecision } = await import("opencut-wasm");
			const read = async ({
				asset,
				startSeconds,
				segments,
			}: {
				asset: BrowserMediaSource & { name: string };
				startSeconds: number;
				segments?: Segment[];
			}) => {
				if (segments) {
					const out = new Float32Array(
						Math.round(message.window.durationSeconds * 16000),
					);
					for (const segment of segments) {
						const begin = Math.max(startSeconds, segment.start);
						const end = Math.min(
							startSeconds + message.window.durationSeconds,
							segment.start + segment.duration,
						);
						if (end <= begin) continue;
						const samples = await readEnergyEnvelope({
							asset: segment.asset,
							startSeconds: begin - segment.start,
							durationSeconds: end - begin,
							windowSeconds: 1 / 16000,
							sampleMode: "waveform",
						});
						const at = Math.round((begin - startSeconds) * 16000);
						out.set(
							samples.subarray(0, Math.min(samples.length, out.length - at)),
							at,
						);
					}
					return out;
				}
				return readEnergyEnvelope({
					asset,
					startSeconds,
					durationSeconds: message.window.durationSeconds,
					windowSeconds: 1 / 16000,
					sampleMode: "waveform",
				});
			};
			const [reference, target] = await Promise.all([
				read({
					asset: message.reference,
					startSeconds: message.window.referenceStart,
					segments: message.referenceSegments,
				}),
				read({
					asset: message.target,
					startSeconds: message.window.targetStart,
					segments: message.targetSegments,
				}),
			]);
			self.postMessage({
				result: estimatePodcastPrecision({
					reference: Array.from(reference),
					target: Array.from(target),
					sampleRate: 16000,
				}),
			});
		} else if (message.type === "route") {
			const { analyzePodcastMulticam } = await import("opencut-wasm");
			const result = analyzePodcastMulticam({
				...message,
				envelopes: message.envelopes.map((e) => Array.from(e)),
			});
			self.postMessage({ result });
		} else {
			const { alignPodcastSources } = await import("opencut-wasm");
			const result = alignPodcastSources({
				envelopes: message.envelopes.map((e) => Array.from(e)),
				resolutionSeconds: 0.01,
				maxLagSeconds: message.maxLagSeconds,
			});
			self.postMessage({ result });
		}
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
