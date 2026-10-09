/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Runs only inside the isolated HyperFrames page; Rust validates all observations. */
import { assignMediaRenderIds } from "@hyperframes/core";
import { probeElementVolumeKeyframes } from "@hyperframes/core/media-volume-envelope";
import { isMemberGroupHidden } from "@hyperframes/core/audio-groups";
import { isAudibleVideoElement } from "@hyperframes/core/audible-video";
import type { HyperframesRuntimeManifest } from "./types";

/** Build with scripts/build-hyperframes-audio-probe.ts. Always run in a
 * disposable page: probing GSAP may materialize future visual state. */
function probeAudio({
	manifest,
	fps,
}: {
	manifest: HyperframesRuntimeManifest;
	fps: number;
}) {
	if (manifest.durationSeconds > 1800)
		throw new Error("HyperFrames audio supports compositions up to 30 minutes");
	const clone = document.cloneNode(true) as Document;
	const originals = Array.from(document.querySelectorAll("audio,video"));
	if (originals.length > 32)
		throw new Error("HyperFrames audio supports up to 32 media tracks");
	const copies = Array.from(clone.querySelectorAll("audio,video"));
	for (const element of clone.querySelectorAll("[data-hf-render-id]"))
		element.removeAttribute("data-hf-render-id");
	for (const element of clone.querySelectorAll("[data-hf-group-render-id]"))
		element.removeAttribute("data-hf-group-render-id");
	assignMediaRenderIds(clone);
	const layers = new Map(manifest.layers.map((layer) => [layer.key, layer]));
	const timelines = (
		window as unknown as {
			__timelines?: Record<
				string,
				{
					totalTime?: (time: number, suppressEvents: boolean) => void;
					seek?: (time: number, suppressEvents: boolean) => void;
				}
			>;
		}
	).__timelines;
	const root = document
		.querySelector("[data-composition-id]")
		?.getAttribute("data-composition-id");
	const timeline = root ? timelines?.[root] : undefined;
	const seek = (time: number) => {
		if (timeline?.totalTime) timeline.totalTime(time, true);
		else timeline?.seek?.(time, true);
	};
	const envelopes = new Map<string, Array<{ time: number; volume: number }>>();
	const looping: string[] = [];
	let envelopeSamples = 0;
	for (const [index, node] of originals.entries()) {
		const media = node as HTMLMediaElement;
		const copy = copies[index];
		// Native muted is an authored mute; capture's .muted property is always
		// forced on and must never suppress an otherwise audible track.
		if (media.defaultMuted) copy.setAttribute("data-hidden", "true");
		if (node.tagName === "VIDEO") {
			if (!isAudibleVideoElement(node)) continue;
			// The host probes actual stream presence. Missing metadata must not
			// silently discard the audio of an otherwise audible video.
			copy.setAttribute("data-has-audio", "true");
		}
		if (copy.closest("[data-hidden]") || isMemberGroupHidden(clone, copy))
			continue;
		const path: number[] = [];
		for (
			let element: Element | null = node;
			element?.parentElement;
			element = element.parentElement
		)
			path.unshift(Array.from(element.parentElement.children).indexOf(element));
		const layer = layers.get(`dom/${path.join("/")}`);
		if (!layer?.resourcePath || !layer.media)
			throw new Error(
				"HyperFrames audio needs an addressable layer and an imported media resource",
			);
		const id = copy.getAttribute("data-hf-render-id")!;
		const audioId = node.tagName === "VIDEO" ? `${id}-audio` : id;
		if (media.loop) looping.push(audioId);
		if (!copy.id) copy.id = id;
		copy.setAttribute("src", layer.resourcePath);
		copy.querySelectorAll("source").forEach((source) => source.remove());
		copy.setAttribute("data-start", String(layer.startSeconds));
		copy.setAttribute(
			"data-end",
			String(layer.startSeconds + layer.durationSeconds),
		);
		copy.setAttribute("data-duration", String(layer.durationSeconds));
		copy.setAttribute("data-media-start", String(layer.playbackStartSeconds));
		if (timeline) {
			seek(0);
			const frames = probeElementVolumeKeyframes(
				media,
				seek,
				manifest.durationSeconds,
				fps,
			);
			if (frames) {
				envelopeSamples += frames.length;
				if (envelopeSamples > 100_000)
					throw new Error(
						"HyperFrames volume automation exceeds 100000 samples",
					);
				envelopes.set(audioId, frames);
			}
		}
	}
	// The engine needs hierarchy and attributes for group membership and mute.
	// Scripts, style sheets and embedded documents are irrelevant to its parser.
	clone
		.querySelectorAll("script,style,link,iframe,object,embed")
		.forEach((node) => node.remove());
	const html = clone.documentElement.outerHTML;
	if (html.length > 4 * 1024 * 1024)
		throw new Error("HyperFrames audio document exceeds 4 MiB");
	return { html, envelopes: Object.fromEntries(envelopes), looping };
}

(
	window as unknown as { __opencutProbeAudio: typeof probeAudio }
).__opencutProbeAudio = probeAudio;
