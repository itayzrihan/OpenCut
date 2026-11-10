import { describe, expect, test, mock } from "bun:test";
import type { ResizeConfig } from "../../controllers/resize-controller";
import "./mock-ripple-wasm";
import { getDisplayTracks } from "../../track-order";
mock.module("@/timeline", () => ({
	getDisplayTracks,
	isRetimableElement: (element: { type: string }) =>
		["video", "audio"].includes(element.type),
}));
mock.module("@/timeline/animation-snap-points", () => ({
	getAnimationKeyframeSnapPointsForTimeline: () => [],
}));
const { ResizeController } =
	await import("../../controllers/resize-controller");
import type { GroupResizeUpdate } from "../types";
import type { SceneTracks } from "@/timeline/types";
import { mediaTime } from "@/wasm";

const t = (seconds: number) => mediaTime({ ticks: seconds * 120000 });

test("whole-row resize keeps linked microphone and other tracks out of preview and commit", () => {
	for (const exactRow of [false, true]) {
		const listeners = new Map<string, (event: { clientX: number }) => void>();
		const previousDocument = globalThis.document;
		globalThis.document = {
			// DOM EventTarget takes positional arguments.
			// eslint-disable-next-line opencut/prefer-object-params
			addEventListener: (
				name: string,
				listener: (event: { clientX: number }) => void,
			) => listeners.set(name, listener),
			removeEventListener: (name: string) => listeners.delete(name),
		} as unknown as Document;
		try {
			const clip = {
				id: "video",
				type: "video",
				startTime: t(0),
				duration: t(5),
				trimStart: t(0),
				trimEnd: t(2),
				sourceDuration: t(7),
				linkedAudioVideoId: "mic",
			};
			const microphone = {
				...clip,
				id: "mic",
				type: "audio",
				linkedAudioVideoId: "video",
			};
			const tracks = {
				main: { id: "main", type: "video", elements: [clip] },
				overlay: [],
				audio: [{ id: "microphone", type: "audio", elements: [microphone] }],
			} as unknown as SceneTracks;
			let preview: GroupResizeUpdate[] = [],
				committed: GroupResizeUpdate[] = [];
			let hasTimeEdit = false;
			const config: ResizeConfig = {
				zoomLevel: 1,
				snappingEnabled: false,
				rippleEditingEnabled: true,
				isShiftHeld: () => false,
				getSceneTracks: () => tracks,
				getCurrentPlayheadTime: () => t(0),
				getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
				selectedElements: [{ trackId: "main", elementId: "video" }],
				getExactTrackId: () => (exactRow ? "main" : null),
				discardPreview: () => {},
				previewElements: (value) => {
					preview = value;
				},
				commitElements: ({ updates, timeEdit }) => {
					committed = updates;
					hasTimeEdit = !!timeEdit;
				},
			};
			const controller = new ResizeController({
				configRef: { current: config },
			});
			controller.onResizeStart({
				event: {
					clientX: 100,
					stopPropagation() {},
					preventDefault() {},
				} as never,
				element: clip as never,
				track: tracks.main,
				side: "right",
			});
			listeners.get("mousemove")!({ clientX: 150 });
			listeners.get("mouseup")!({ clientX: 150 });
			const expected = exactRow ? ["video"] : ["video", "mic"];
			expect(preview.map((item) => item.elementId)).toEqual(expected);
			expect(committed.map((item) => item.elementId)).toEqual(expected);
			expect(hasTimeEdit).toBe(!exactRow);
			expect(microphone.duration).toBe(t(5));
		} finally {
			globalThis.document = previousDocument;
		}
	}
});

// The signed-time adapter is exercised in ripple-resize.test.ts; the Rust
// timeline suite verifies the production mapping, including consumed spans.
describe("main-track trim gesture", () => {
	for (const [side, pixels, expectedDuration, expectedTrim] of [
		["left", 50, 4, 3],
		["right", -50, 4, 3],
		["left", -50, 6, 1],
		["right", 50, 6, 1],
	] as const) {
		test(`${side} edge ${pixels > 0 ? "rightward" : "leftward"} ripples all layers`, () => {
			const listeners = new Map<string, (event: { clientX: number }) => void>();
			const oldDocument = globalThis.document;
			globalThis.document = {
				// DOM EventTarget takes positional arguments.
				// eslint-disable-next-line opencut/prefer-object-params
				addEventListener: (
					name: string,
					fn: (event: { clientX: number }) => void,
				) => listeners.set(name, fn),
				removeEventListener: (name: string) => listeners.delete(name),
			} as unknown as Document;
			try {
				const target = {
					id: "target",
					type: "video",
					startTime: t(5),
					duration: t(5),
					trimStart: t(2),
					trimEnd: t(2),
					sourceDuration: t(9),
				};
				const next = {
					id: "next",
					type: "video",
					startTime: t(10),
					duration: t(5),
					trimStart: t(0),
					trimEnd: t(0),
				};
				const tracks = {
					main: {
						id: "main",
						type: "video",
						elements: [
							{ ...next, id: "previous", startTime: t(0) },
							target,
							next,
						],
					},
					overlay: [
						{
							id: "fx",
							type: "effect",
							elements: [
								{
									id: "fx",
									type: "effect",
									startTime: t(0),
									duration: t(15),
									trimStart: t(0),
									trimEnd: t(0),
								},
							],
						},
						{
							id: "text",
							type: "text",
							elements: [
								{
									id: "caption",
									type: "text",
									params: { content: "hello" },
									startTime: t(11),
									duration: t(2),
									trimStart: t(0),
									trimEnd: t(0),
									wordRuns: [
										{
											id: "word",
											text: "hello",
											lineIndex: 0,
											startTime: t(0),
											endTime: t(2),
										},
									],
								},
							],
						},
					],
					audio: [],
				} as unknown as SceneTracks;
				let preview: GroupResizeUpdate[] = [];
				let committed: GroupResizeUpdate[] = [];
				const config: ResizeConfig = {
					zoomLevel: 1,
					snappingEnabled: false,
					rippleEditingEnabled: false,
					isShiftHeld: () => false,
					getSceneTracks: () => tracks,
					getCurrentPlayheadTime: () => t(0),
					getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
					selectedElements: [],
					discardPreview: () => {
						preview = [];
					},
					previewElements: (updates) => {
						preview = updates;
					},
					commitElements: ({ updates }) => {
						committed = updates;
					},
				};
				const controller = new ResizeController({
					configRef: { current: config },
				});
				controller.onResizeStart({
					event: {
						clientX: 100,
						stopPropagation() {},
						preventDefault() {},
					} as never,
					element: target as never,
					track: tracks.main,
					side,
				});
				listeners.get("mousemove")!({ clientX: 100 + pixels });
				expect(
					preview.find((u) => u.elementId === "target")?.patch.startTime,
				).toBe(t(side === "left" ? 5 + pixels / 50 : 5));
				expect(
					preview.find((u) => u.elementId === "target")?.patch.duration,
				).toBe(t(expectedDuration));
				expect(
					preview.find((u) => u.elementId === "target")?.patch[
						side === "left" ? "trimStart" : "trimEnd"
					],
				).toBe(t(expectedTrim));
				if (side === "left") {
					expect(preview.map((u) => u.elementId)).toEqual(["target"]);
					const patch = preview[0].patch;
					expect(patch.startTime + patch.duration).toBe(t(10));
				} else {
					expect(
						preview.find((u) => u.elementId === "next")?.patch.startTime,
					).toBe(t(5 + expectedDuration));
					expect(
						preview.find((u) => u.elementId === "fx")?.patch.duration,
					).toBe(t(10 + expectedDuration));
					expect(
						preview.find((u) => u.elementId === "caption")?.patch.startTime,
					).toBe(t(6 + expectedDuration));
					expect(
						preview.find((u) => u.elementId === "caption")?.patch.wordRuns?.[0]
							.endTime,
					).toBe(t(2));
				}
				listeners.get("mousemove")!({ clientX: 100 });
				expect(preview.every((u) => u.elementId === "target")).toBe(true);
				listeners.get("mousemove")!({ clientX: 100 + pixels });
				listeners.get("mouseup")!({ clientX: 100 + pixels });
				expect(
					committed.find((u) => u.elementId === "next")?.patch.startTime,
				).toBe(t(5 + expectedDuration));
				expect(controller.isResizing).toBe(false);
			} finally {
				globalThis.document = oldDocument;
			}
		});
	}
});

test("right trim on a speed ramp removes the correct source tail", async () => {
	const { computeGroupResize } = await import("../compute-resize");
	const result = computeGroupResize({
		side: "right",
		fps: { numerator: 25, denominator: 1 },
		deltaTime: t(-2),
		members: [
			{
				trackId: "main",
				elementId: "ramp",
				startTime: t(0),
				duration: t(6),
				trimStart: t(2),
				trimEnd: t(1),
				sourceDuration: t(11),
				leftNeighborBound: null,
				rightNeighborBound: null,
				retime: {
					rate: 1,
					speedKeyframes: [
						{ time: t(2), rate: 1, interpolation: "hold" },
						{ time: t(6), rate: 2, interpolation: "linear" },
					],
				},
			},
		],
	});
	expect(result.updates[0].patch.duration).toBe(t(4));
	expect(result.updates[0].patch.trimStart).toBe(t(2));
	expect(result.updates[0].patch.trimEnd).toBe(t(5));
});
