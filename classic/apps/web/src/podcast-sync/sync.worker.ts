import {
	AudioLandmarks,
	buildLandmarkIndex,
	rankLandmarkOffsets,
} from "./audio-landmarks";
import { readNativeSyncAudio } from "./native-audio";
import { ALL_FORMATS, Input } from "mediabunny";
import { createMediaSource } from "@/media/source";
import type { PodcastGroupAlignment } from "opencut-wasm";
import type { PodcastSyncSettings } from "./engine";
import { readPcm16Envelope } from "./pcm16-envelope";
import { readEnergyEnvelope } from "./energy-reader";
import type { BrowserMediaSource } from "@/media/source";
type Segment = {
	asset: BrowserMediaSource & { name: string };
	start: number;
	duration: number;
};

type Request =
	| {
			type: "fingerprint";
			asset: BrowserMediaSource & { name: string };
			start: number;
			length: number;
			full?: boolean;
	  }
	| {
			type: "rank-landmarks";
			reference: Float32Array;
			probes: { at: number; landmarks: Float32Array }[];
	  }
	| { type: "capture-time"; asset: BrowserMediaSource }
	| {
			type: "independent-probes";
			reference: Float32Array;
			probes: { at: number; samples: Float32Array }[];
			origin: number;
			full?: boolean;
	  }
	| { type: "color"; asset: BrowserMediaSource; duration: number }
	| {
			type: "read";
			asset: BrowserMediaSource & { name: string };
			range?: { startSeconds: number; durationSeconds: number };
			preferPcm?: boolean;
	  }
	| {
			type: "precision";
			referenceSegments?: Segment[];
			targetSegments?: Segment[];
			reference: BrowserMediaSource & { name: string };
			target: BrowserMediaSource & { name: string };
			window: import("opencut-wasm").PodcastPrecisionWindow;
	  }
	| {
			type: "align" | "align-to-reference";
			envelopes: Float32Array[];
			maxLagSeconds: number;
	  }
	| {
			type: "route";
			advanced?: import("opencut-wasm").AdvancedPodcastRouting;
			envelopes: Float32Array[];
			channelIds: string[];
			masterMicrophoneId?: string;
			cameraWindows: import("opencut-wasm").PodcastCameraWindow[];
			duration: number;
			settings: PodcastSyncSettings;
	  };
self.onmessage = async (event: MessageEvent<Request>) => {
	try {
		const message = event.data;
		if (message.type === "fingerprint") {
			const { asset, start, length, full } = message;
			const native = await readNativeSyncAudio({
				asset,
				fingerprint: true,
				startSeconds: start,
				durationSeconds: full ? undefined : length,
			});
			const builder = native ? null : new AudioLandmarks();
			if (builder) {
				for (let at = 0; at < length; at += 60) {
					const pcm = await readEnergyEnvelope({
						asset,
						startSeconds: start + at,
						durationSeconds: Math.min(60, length - at),
						windowSeconds: 1 / 16000,
						sampleMode: "waveform",
					});
					for (const sample of pcm) builder.push(sample);
				}
			}
			const result = native ?? builder!.finish();
			self.postMessage({ result }, { transfer: [result.buffer] });
		} else if (message.type === "rank-landmarks") {
			self.postMessage({
				result: rankLandmarkOffsets({
					index: buildLandmarkIndex(message.reference),
					probes: message.probes,
				}),
			});
		} else if (message.type === "capture-time") {
			const input = new Input({
				formats: ALL_FORMATS,
				source: createMediaSource(message.asset),
			});
			try {
				const time = (await input.getMetadataTags()).date?.getTime();
				self.postMessage({ result: Number.isFinite(time) ? time : null });
			} finally {
				input.dispose();
			}
		} else if (message.type === "independent-probes") {
			const { estimatePodcastAlignment } = await import("opencut-wasm");
			const reference = Array.from(message.reference);
			const result = message.probes.map(({ at, samples }) => {
				const estimate = estimatePodcastAlignment({
					reference,
					target: Array.from(samples),
					resolutionSeconds: 0.01,
					maxLagSeconds: reference.length / 100,
				});
				return {
					at,
					offset: message.origin + estimate.offsetSeconds - at,
					confidence:
						message.full || estimate.overlapSeconds >= samples.length * 0.006
							? estimate.confidence
							: 0,
				};
			});
			self.postMessage({ result });
		} else if (message.type === "read") {
			const { asset, range, preferPcm } = message;
			const pcm =
				preferPcm && asset.file && range
					? await readPcm16Envelope({ file: asset.file, ...range })
					: null;
			const result =
				pcm ??
				(await readEnergyEnvelope({
					asset,
					...range,
					windowSeconds: 0.01,
				}));
			self.postMessage({ result }, { transfer: [result.buffer] });
		} else if (message.type === "color") {
			const { readPodcastColor } = await import("./order-timeline-color");
			self.postMessage({ result: await readPodcastColor(message) });
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
		} else if (message.type === "align-to-reference") {
			const { estimatePodcastAlignment } = await import("opencut-wasm");
			const [first, ...targets] = message.envelopes;
			const reference = Array.from(first!);
			const result: PodcastGroupAlignment = {
				offsets: [0],
				confidence: [1],
				parents: [undefined],
				referenceIndex: 0,
			};
			for (const target of targets) {
				const estimate = estimatePodcastAlignment({
					reference,
					target: Array.from(target),
					resolutionSeconds: 0.01,
					maxLagSeconds: message.maxLagSeconds,
				});
				// Preserve the shared-clock search when a camera needs an indirect match.
				if (estimate.confidence < 0.65) {
					self.postMessage({ result: null });
					return;
				}
				result.offsets.push(estimate.offsetSeconds);
				result.confidence.push(estimate.confidence);
				result.parents.push(0);
			}
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
