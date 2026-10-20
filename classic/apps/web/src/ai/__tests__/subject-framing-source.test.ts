import { afterAll, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
let sampled: unknown;
let failDecode = false;
const urls: string[] = [];
mock.module("opencut-wasm", () => ({
	fullAutoFramingSampleTimes: ({ clipsJson }: { clipsJson: string }) => {
		sampled = JSON.parse(clipsJson);
		return [1, 2, 3, 4, 5];
	},
	resolveLocalSubjectFraming: () => ({
		valid: false,
		acceptedFrames: 0,
		bodyFrames: 0,
	}),
	compileFullAutoEdit: () => {
		throw new Error("This test only decodes sources");
	},
}));
mock.module("@/media/unified-angles", () => ({
	resolveUnifiedAnglesVideoTiming: ({ asset }: { asset: { id: string } }) => {
		expect(asset.id).toBe("compound");
		return {
			asset: {
				id: "camera",
				name: "Camera",
				url: "camera-url",
				width: 1920,
				height: 1080,
			},
			trimStart: 120000,
			trimEnd: 0,
		};
	},
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: () => {},
	parseTimelineDocumentV2: () => {},
}));
mock.module("@/timeline/scenes", () => ({ updateSceneInArray: () => {} }));
mock.module("@/ai/subject-detector-client", () => ({
	requestSubjectDetections: async () => ({
		available: false,
		error: "No face",
	}),
}));
const previous = globalThis.document;
class Video extends EventTarget {
	duration = 100;
	videoWidth = 1920;
	videoHeight = 1080;
	time = 0;
	set src(value: string) {
		urls.push(value);
		queueMicrotask(() =>
			this.dispatchEvent(new Event(failDecode ? "error" : "loadeddata")),
		);
	}
	get currentTime() {
		return this.time;
	}
	set currentTime(value: number) {
		this.time = value;
		queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
	}
	pause() {}
	load() {}
	removeAttribute() {}
}
// A deterministic media host: no decoder, network or face model runs in unit tests.
Object.defineProperty(globalThis, "document", {
	configurable: true,
	value: {
		createElement: (kind: string) =>
			kind === "video"
				? new Video()
				: {
						width: 0,
						height: 0,
						getContext: () => ({ drawImage() {} }),
						toDataURL: () => "data:image/jpeg;base64,AA==",
					},
	},
});
afterAll(() =>
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: previous,
	}),
);
const editor = {
	scenes: {
		getActiveScene: () => ({
			tracks: {
				main: {
					elements: [
						{
							id: "cut",
							type: "video",
							mediaId: "compound",
							trimStart: 0,
							duration: 1200000,
						},
					],
				},
			},
		}),
	},
	media: {
		getAssets: () => [
			{ id: "compound", url: "not-a-video", unifiedAngles: {} },
			{ id: "camera", url: "camera-url", width: 1920, height: 1080 },
		],
	},
} as unknown as EditorCore;
const { detectSubjectFraming } = await import("../subject-framing");
test("framing decodes the physical camera and its mapped source time, never the virtual compound", async () => {
	failDecode = false;
	urls.length = 0;
	const result = await detectSubjectFraming({
		editor,
		signal: new AbortController().signal,
		onProgress: () => {},
		allowFallback: true,
	});
	expect(urls).toEqual(["camera-url"]);
	expect(sampled).toMatchObject([{ id: "cut", trimStart: 120000 }]);
	expect(result.framing).toMatchObject([
		{ elementId: "cut", width: 1920, height: 1080, samples: [] },
	]);
});
test("optional face sampling failure falls back safely; explicit Center Subject reports the error", async () => {
	failDecode = true;
	const result = await detectSubjectFraming({
		editor,
		signal: new AbortController().signal,
		onProgress: () => {},
		allowFallback: true,
	});
	expect(result.warnings[0]).toContain("frame sampling unavailable");
	expect(result.framing).toHaveLength(1);
	await expect(
		detectSubjectFraming({
			editor,
			signal: new AbortController().signal,
			onProgress: () => {},
			allowFallback: false,
		}),
	).rejects.toThrow("decode source");
});
