import type { PodcastSyncSettings } from "./engine";
import { readEnergyEnvelope } from "./energy-reader";
import type { BrowserMediaSource } from "@/media/source";
type Request =
	| { type: "read"; asset: BrowserMediaSource & { name: string } }
	| {
			type: "precision";
			reference: BrowserMediaSource & { name: string };
			target: BrowserMediaSource & { name: string };
			window: import("opencut-wasm").PodcastPrecisionWindow;
	  }
	| { type: "align"; envelopes: Float32Array[]; maxLagSeconds: number }
	| {
			type: "route";
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
			const read = (
				asset: BrowserMediaSource & { name: string },
				startSeconds: number,
			) =>
				readEnergyEnvelope({
					asset,
					startSeconds,
					durationSeconds: message.window.durationSeconds,
					windowSeconds: 1 / 16000,
					sampleMode: "waveform",
				});
			const [reference, target] = await Promise.all([
				read(message.reference, message.window.referenceStart),
				read(message.target, message.window.targetStart),
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
