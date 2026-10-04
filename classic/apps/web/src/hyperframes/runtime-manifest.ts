/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The pinned page protocol is untrusted input; the canonical registry validates the returned manifest before use. */
import type { CaptureSession } from "@hyperframes/engine";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import { HYPERFRAMES_RUNTIME_VERSION } from "./preview-document";
import type {
	HyperframesRuntimeLayer,
	HyperframesRuntimeManifest,
	HyperframesSource,
} from "./types";

export async function readHyperframesRuntimeManifest({
	page,
	source,
	fingerprint,
	durationSeconds,
	runtime,
}: {
	page: CaptureSession["page"];
	source: HyperframesSource;
	fingerprint: string;
	durationSeconds: number;
	runtime: CanonicalEditorRuntime;
}): Promise<HyperframesRuntimeManifest> {
	await page.waitForFunction(
		() => !!(window as unknown as { __clipManifest?: unknown }).__clipManifest,
		{ timeout: 30_000 },
	);
	const observed = await page.evaluate(collectRuntimeLayers, {
		entryFile: source.entryFile,
		files: Object.keys(source.files),
		resources: Object.keys(source.resourceAssetIds),
	});
	const manifest: HyperframesRuntimeManifest = {
		sourceFingerprint: fingerprint,
		runtimeVersion: HYPERFRAMES_RUNTIME_VERSION,
		durationSeconds,
		...observed,
	};
	const result = runtime.invokeSync(
		"hyperframes.manifest.validate",
		{ source, manifest },
		undefined,
	) as { result: { data: HyperframesRuntimeManifest } };
	return result.result.data;
}

/** Runs inside the isolated renderer. Read official resolved timing and DOM
 * identity; do not infer timing from HTML or flatten compositions into clips. */
function collectRuntimeLayers({
	entryFile,
	files,
	resources,
}: {
	entryFile: string;
	files: string[];
	resources: string[];
}): Pick<HyperframesRuntimeManifest, "layers" | "diagnostics"> {
	const payload = (
		window as unknown as {
			__clipManifest: {
				clips: Array<{
					id: string | null;
					label: string;
					kind: HyperframesRuntimeLayer["kind"];
					start: number;
					duration: number;
					track: number;
					assetUrl: string | null;
					playbackStart: number;
					playbackRate: number;
					compositionAncestors: string[];
				}>;
			};
		}
	).__clipManifest;
	if (!Array.isArray(payload?.clips) || payload.clips.length > 20_000)
		throw new Error(
			"HyperFrames returned an invalid or oversized runtime layer list",
		);
	const diagnostics: string[] = [];
	const warn = (message: string) => {
		if (diagnostics.length < 256 && !diagnostics.includes(message))
			diagnostics.push(message);
	};
	const packageFiles = new Set([...files, ...resources]);
	const packagePath = (reference: string | null): string | null => {
		if (!reference) return null;
		try {
			const url = new URL(reference, document.baseURI);
			if (url.origin !== new URL(document.URL).origin) return null;
			const path = decodeURIComponent(url.pathname.slice(1));
			return packageFiles.has(path) ? path : null;
		} catch {
			return null;
		}
	};
	const byId = new Map<string, Element[]>();
	const byCompositionId = new Map<string, Element[]>();
	for (const element of document.querySelectorAll(
		"[id], [data-hf-id], [data-composition-id]",
	)) {
		const compositionId = element.getAttribute("data-composition-id");
		if (compositionId)
			byCompositionId.set(compositionId, [
				...(byCompositionId.get(compositionId) ?? []),
				element,
			]);
		const id = element.id || element.getAttribute("data-hf-id");
		if (!id) continue;
		const entries = byId.get(id) ?? [];
		entries.push(element);
		byId.set(id, entries);
	}
	const ancestors = (element: Element): string[] => {
		const ids = [];
		for (
			let parent = element.parentElement;
			parent;
			parent = parent.parentElement
		) {
			const id = parent.getAttribute("data-composition-id");
			if (id) ids.push(id);
		}
		return ids.reverse();
	};
	const used = new Set<Element>();
	const nodes = new Map<Element, string>();
	const entries = payload.clips.map((clip, index) => {
		const candidates = [
			...new Set(
				clip.id
					? [
							...(byId.get(clip.id) ?? []),
							...(clip.kind === "composition"
								? (byCompositionId.get(clip.id) ?? [])
								: []),
						]
					: [],
			),
		].filter(
			(element) =>
				!used.has(element) &&
				JSON.stringify(ancestors(element)) ===
					JSON.stringify(clip.compositionAncestors),
		);
		// Resolve repeated author IDs by host ancestry. If that is still ambiguous,
		// keep the observed layer without guessing which source node it edits.
		const element = candidates.length === 1 ? candidates[0] : undefined;
		let key = `manifest/${index}`;
		let file: string | null = null;
		if (element) {
			used.add(element);
			const path: number[] = [];
			for (
				let node: Element | null = element;
				node?.parentElement;
				node = node.parentElement
			)
				path.unshift(Array.from(node.parentElement.children).indexOf(node));
			key = `dom/${path.join("/")}`;
			nodes.set(element, key);
			const host = element.parentElement?.closest(
				"[data-composition-file], [data-composition-src]",
			);
			const reference =
				host?.getAttribute("data-composition-file") ??
				host?.getAttribute("data-composition-src") ??
				null;
			const resolved = packagePath(reference);
			file = host
				? resolved && files.includes(resolved)
					? resolved
					: null
				: entryFile;
		} else {
			warn(
				"Some runtime layers have no addressable DOM node; their source identity is unavailable.",
			);
		}
		const resourcePath = packagePath(clip.assetUrl);
		if (clip.assetUrl && !resourcePath)
			warn("Some runtime media references are outside the imported package.");
		const mediaElement = element instanceof HTMLMediaElement ? element : null;
		const mediaAttributes = new Set([
			"data-start",
			"data-end",
			"data-duration",
			"data-media-start",
			"data-playback-start",
			"data-playback-rate",
			"data-volume",
			"data-fade-in",
			"data-fade-out",
			"data-automation",
			"data-fx-chain",
			"data-audio-group",
			"data-hidden",
			"data-has-audio",
			"data-hf-media-start-basis",
			"data-hf-authored-duration",
			"data-hf-authored-end",
		]);
		const layer: HyperframesRuntimeLayer = {
			key,
			parentKey: null,
			file,
			elementId: element?.getAttribute("data-hf-authored-id") ?? clip.id,
			label: clip.label,
			kind: clip.kind,
			startSeconds: clip.start,
			durationSeconds: clip.duration,
			trackIndex: clip.track,
			resourcePath,
			playbackStartSeconds: clip.playbackStart,
			playbackRate: clip.playbackRate,
			media: mediaElement
				? {
						sourceDurationSeconds:
							Number.isFinite(mediaElement.duration) &&
							mediaElement.duration > 0
								? mediaElement.duration
								: null,
						muted: mediaElement.defaultMuted,
						looping: mediaElement.loop,
						attributes: Object.fromEntries(
							Array.from(mediaElement.attributes)
								.filter((attribute) => mediaAttributes.has(attribute.name))
								.map((attribute) => [attribute.name, attribute.value]),
						),
					}
				: null,
		};
		return { element, layer };
	});
	for (const { element, layer } of entries) {
		for (
			let parent = element?.parentElement;
			parent;
			parent = parent.parentElement
		) {
			const parentKey = nodes.get(parent);
			if (parentKey) {
				layer.parentKey = parentKey;
				break;
			}
		}
	}
	return { layers: entries.map(({ layer }) => layer), diagnostics };
}
