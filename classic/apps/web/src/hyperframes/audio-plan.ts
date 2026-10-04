/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The canonical registry validates browser observations before returning the derived plan. */
import {
	parseAudioElements,
	type AudioElement,
	type CaptureSession,
} from "@hyperframes/engine";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import { HYPERFRAMES_AUDIO_PROBE } from "./audio-probe.generated";
import type { HyperframesRuntimeManifest, HyperframesSource } from "./types";

export interface HyperframesAudioPlan {
	sourceFingerprint: string;
	runtimeVersion: string;
	durationSeconds: number;
	elements: Array<AudioElement & { looping?: boolean }>;
}

/** Caller must discard this page after probing; seeking volume automation can
 * materialize future GSAP visual state even after seeking back to zero. */
export async function readHyperframesAudioPlan({
	page,
	source,
	manifest,
	fps,
	runtime,
}: {
	page: CaptureSession["page"];
	source: HyperframesSource;
	manifest: HyperframesRuntimeManifest;
	fps: number;
	runtime: CanonicalEditorRuntime;
}): Promise<HyperframesAudioPlan> {
	const identity = {
		sourceFingerprint: manifest.sourceFingerprint,
		runtimeVersion: manifest.runtimeVersion,
		durationSeconds: manifest.durationSeconds,
	};
	// Check unsupported nested windows before sampling a page whose media
	// runtime may be unable to settle that window.
	runtime.invokeSync(
		"hyperframes.audio.prepare",
		{
			source,
			manifest,
			plan: { ...identity, elements: [] },
		},
		undefined,
	);
	await page.evaluate(HYPERFRAMES_AUDIO_PROBE);
	const response = await page.evaluate(
		(input) => {
			try {
				const observed = (
					window as unknown as {
						__opencutProbeAudio: (input: unknown) => {
							html: string;
							envelopes: Record<
								string,
								Array<{ time: number; volume: number }>
							>;
							looping: string[];
						};
					}
				).__opencutProbeAudio(input);
				return { observed, error: null };
			} catch (error) {
				return { observed: null, error: String(error).slice(0, 2048) };
			}
		},
		{ manifest, fps },
	);
	if (response.error) throw new Error(response.error);
	const observed = response.observed;
	if (
		!observed ||
		typeof observed.html !== "string" ||
		Buffer.byteLength(observed.html) > 4 * 1024 * 1024 ||
		!observed.envelopes ||
		typeof observed.envelopes !== "object" ||
		!Array.isArray(observed.looping) ||
		observed.looping.length > 32 ||
		Buffer.byteLength(JSON.stringify(observed)) > 8 * 1024 * 1024
	)
		throw new Error(
			"HyperFrames returned invalid or oversized audio observations",
		);
	const elements = parseAudioElements(observed.html).map((element) => ({
		...element,
		playbackRate: element.playbackRate ?? 1,
		volume: element.volume ?? 1,
		...(observed.looping.includes(element.id) ? { looping: true } : {}),
		...(Object.hasOwn(observed.envelopes, element.id)
			? { volumeKeyframes: observed.envelopes[element.id] }
			: {}),
	}));
	const result = runtime.invokeSync(
		"hyperframes.audio.prepare",
		{
			source,
			manifest,
			plan: {
				...identity,
				elements,
			},
		},
		undefined,
	) as { result: { data: HyperframesAudioPlan } };
	return result.result.data;
}
