import type { PodcastSyncSettings } from "./engine";
import { readEnergyEnvelope } from "./energy-reader";
import type { BrowserMediaSource } from "@/media/source";
type Request =
	| { type: "read"; asset: BrowserMediaSource & { name: string } }
	| { type: "align"; envelopes: Float32Array[]; maxLagSeconds: number }
	| {
			type: "route";
			envelopes: Float32Array[];
			channelIds: string[];
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
