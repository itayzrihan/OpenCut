import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { TextElement, TextTrack, VideoElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";
import type { ParsedTimelineDocumentV2 } from "../timeline-document-v2";
import type { TimelineDocumentV2MutationScopeValidator } from "../timeline-document-v2-scope";

mock.module("../timeline-document-v2-scope-validator", () => ({
	defaultTimelineDocumentV2MutationScopeValidator: undefined,
}));
mock.module("../timeline-document-v2-canonicalizer", () => ({
	defaultTimelineDocumentV2Canonicalizer: undefined,
}));

let validateTimelineDocumentV2MutationScope: typeof import("../timeline-document-v2-scope").validateTimelineDocumentV2MutationScope;

beforeAll(async () => {
	({ validateTimelineDocumentV2MutationScope } =
		await import("../timeline-document-v2-scope"));
});

describe("Timeline Source v2 Rust mutation-scope adapter", () => {
	test("serializes the complete web document and forwards the selected range", () => {
		const before = createDocument();
		const after = structuredClone(before);
		findText(after).params.content = "Changed";
		const calls: Parameters<TimelineDocumentV2MutationScopeValidator>[0][] = [];
		const validate: TimelineDocumentV2MutationScopeValidator = (options) => {
			calls.push(options);
			return { valid: true, diagnostics: [] };
		};

		const result = validateTimelineDocumentV2MutationScope({
			before,
			after,
			selectedRange: { startTime: ticks(100), duration: ticks(200) },
			validate,
		});

		expect(result).toEqual({ valid: true, diagnostics: [] });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.selectedRange).toEqual({
			startTime: ticks(100),
			duration: ticks(200),
		});
		const beforeJson = JSON.parse(calls[0]?.beforeJson ?? "null");
		const afterJson = JSON.parse(calls[0]?.afterJson ?? "null");
		expect(beforeJson).toMatchObject({
			schemaVersion: 2,
			projectSettings: {
				canvasSize: { width: 1920, height: 1080 },
			},
			scene: {
				id: "scene-1",
				createdAt: "2026-07-01T00:00:00.000Z",
				bookmarks: [{ time: ticks(120), note: "Inside" }],
				tracks: [
					{ id: "text-track", area: "overlay" },
					{ id: "main-track", area: "main" },
					{ id: "audio-track", area: "audio" },
				],
			},
		});
		expect(afterJson.scene.tracks[0].elements[0].params.content).toBe(
			"Changed",
		);
	});

	test("returns Rust policy diagnostics unchanged", () => {
		const document = createDocument();
		const validate: TimelineDocumentV2MutationScopeValidator = () => ({
			valid: false,
			diagnostics: [
				{
					code: "range_element_out_of_scope",
					path: "$.scene.tracks[0].elements[0]",
					message: 'Element "text-1" was changed outside the selected range',
				},
			],
		});

		expect(
			validateTimelineDocumentV2MutationScope({
				before: document,
				after: structuredClone(document),
				validate,
			}),
		).toEqual({
			valid: false,
			diagnostics: [
				{
					code: "range_element_out_of_scope",
					path: "$.scene.tracks[0].elements[0]",
					message: 'Element "text-1" was changed outside the selected range',
				},
			],
		});
	});

	test("fails closed when the shared validator throws or returns bad data", () => {
		const document = createDocument();
		const thrown = validateTimelineDocumentV2MutationScope({
			before: document,
			after: structuredClone(document),
			validate: () => {
				throw new Error("stale WASM glue");
			},
		});
		const malformed = validateTimelineDocumentV2MutationScope({
			before: document,
			after: structuredClone(document),
			validate: (() => ({
				valid: true,
			})) as TimelineDocumentV2MutationScopeValidator,
		});

		expect(thrown).toMatchObject({
			valid: false,
			diagnostics: [
				{
					code: "wasm_scope_validation_unavailable",
					message: expect.stringContaining("stale WASM glue"),
				},
			],
		});
		expect(malformed).toMatchObject({
			valid: false,
			diagnostics: [{ code: "wasm_scope_validation_unavailable" }],
		});
	});
});

function createDocument(): ParsedTimelineDocumentV2 {
	return {
		projectSettings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1_920, height: 1_080 },
			background: { type: "color", color: "#000000" },
		},
		scene: {
			id: "scene-1",
			name: "Scene",
			isMain: true,
			createdAt: new Date("2026-07-01T00:00:00.000Z"),
			updatedAt: new Date("2026-07-02T00:00:00.000Z"),
		},
		bookmarks: [{ time: ticks(120), note: "Inside" }],
		tracks: {
			overlay: [textTrack()],
			main: {
				id: "main-track",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [videoElement()],
			},
			audio: [
				{
					id: "audio-track",
					name: "Audio",
					type: "audio",
					muted: false,
					elements: [],
				},
			],
			order: ["text-track", "main-track", "audio-track"],
		},
	};
}

function textTrack(): TextTrack {
	return {
		id: "text-track",
		name: "Text",
		type: "text",
		hidden: false,
		elements: [
			{
				id: "text-1",
				name: "Text",
				type: "text",
				startTime: ticks(100),
				duration: ticks(100),
				trimStart: ticks(0),
				trimEnd: ticks(100),
				params: { content: "Before", opacity: 1 },
			},
		],
	};
}

function videoElement(): VideoElement {
	return {
		id: "video-1",
		name: "Video",
		type: "video",
		mediaId: "media-1",
		startTime: ticks(0),
		duration: ticks(300),
		trimStart: ticks(0),
		trimEnd: ticks(300),
		params: { opacity: 1 },
	};
}

function findText(document: ParsedTimelineDocumentV2): TextElement {
	const element = document.tracks.overlay[0]?.elements[0];
	if (!element || element.type !== "text")
		throw new Error("Missing text fixture");
	return element;
}

function ticks(value: number): MediaTime {
	return value as MediaTime;
}
