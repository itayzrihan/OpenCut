import type { TimelineElement } from "@/timeline/types";
import { mediaTime } from "@/wasm";
// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures cross the serialized Rust boundary; existing Classic helpers are the parity oracle. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { bindProductAnimationCatalog } from "../product-catalog";
import { elementParamRegistry } from "@/params/registry";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import {
	getElementLocalTime,
	resolveAnimationPathValueAtTime,
} from "../resolve";
import { removeElementKeyframe } from "../keyframes";
import { hasKeyframesForPath } from "../keyframe-query";
import type { ElementAnimations, ScalarChannel, ScalarSegmentType } from "../types";
import type { ParamDefinition } from "@/params";

const target = { trackId: "video-track", elementId: "item-2" };
function canonical<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
async function fixture() {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	const classic = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	session.attach({ classic });
	const dispose = bindProductAnimationCatalog((groups) =>
		session.setAnimationCatalog(groups),
	);
	return { session, classic, dispose };
}
function scalar({
	segment = "linear",
	equal = false,
	handles = false,
}: {
	segment?: ScalarSegmentType;
	equal?: boolean;
	handles?: boolean;
}): ScalarChannel {
	return {
		extrapolation: { before: "linear", after: "linear" },
		keys: [
			{
				id: "a",
				time: mediaTime({ ticks: 20 }),
				value: 0.15,
				segmentToNext: segment,
				tangentMode: "auto",
				...(handles && { rightHandle: { dt: mediaTime({ ticks: 500 }), dv: 1.25 } }),
			},
			{
				id: "b",
				time: mediaTime({ ticks: equal ? 20 : 80 }),
				value: 0.85,
				segmentToNext: segment,
				tangentMode: "auto",
				...(handles && {
					leftHandle: { dt: mediaTime({ ticks: -500 }), dv: -0.25 },
					rightHandle: { dt: mediaTime({ ticks: 3 }), dv: -1 },
				}),
			},
			{
				id: "c",
				time: mediaTime({ ticks: 150 }),
				value: 0.35,
				segmentToNext: segment,
				tangentMode: "auto",
				...(handles && { leftHandle: { dt: mediaTime({ ticks: -5 }), dv: 0.6 } }),
			},
		],
	};
}

test("canonical removal matches Classic playhead sampling, partial deletion and base persistence", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	const params: ParamDefinition[] = [
		{
			key: "test.color",
			label: "Color",
			type: "color",
			default: "color(display-p3 0.3 0.5 0.2 / 0.4)",
		},
		{ key: "test.text", label: "Text", type: "text", default: "לפני" },
		{ key: "test.boolean", label: "Boolean", type: "boolean", default: false },
		{
			key: "test.select",
			label: "Select",
			type: "select",
			default: "off",
			options: [
				{ value: "off", label: "Off" },
				{ value: "on", label: "On" },
			],
		},
	];
	try {
		elementParamRegistry.register({
			key: "video",
			definition: [...previous, ...params],
		});
		const cases = [
			...(["linear", "step", "bezier"] as const).flatMap((segment) =>
				[false, true].flatMap((equal) =>
					[false, true].map((handles) => ({
						propertyPath: "opacity",
						data: scalar({ segment, equal, handles }),
					})),
				),
			),
			{
				propertyPath: "test.text",
				data: {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 20 }), value: "שלום" },
						{ id: "b", time: mediaTime({ ticks: 80 }), value: "עולם" },
						{ id: "c", time: mediaTime({ ticks: 150 }), value: "סיום" },
					],
				},
			},
			{
				propertyPath: "test.boolean",
				data: {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 20 }), value: true },
						{ id: "b", time: mediaTime({ ticks: 80 }), value: false },
						{ id: "c", time: mediaTime({ ticks: 150 }), value: true },
					],
				},
			},
			{
				propertyPath: "test.select",
				data: {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 20 }), value: "on" },
						{ id: "b", time: mediaTime({ ticks: 80 }), value: "off" },
						{ id: "c", time: mediaTime({ ticks: 150 }), value: "on" },
					],
				},
			},
			{
				propertyPath: "test.color",
				data: {
					r: scalar({ segment: "bezier", handles: true }),
					g: scalar({ segment: "step" }),
					b: scalar({ equal: true }),
					a: scalar({}),
				},
			},
			// Existing partial color channels fall back to the whole base color.
			{
				propertyPath: "test.color",
				data: { r: scalar({}), g: scalar({}), b: scalar({}) },
			},
		];
		for (const { propertyPath, data } of cases) {
			for (const time of [-20, 0, 10, 20, 50, 80, 120, 150, 175, 200, 250]) {
				for (const ids of [["b"], ["a", "b", "c"]]) {
					const original = structuredClone(f.classic);
					const element = original.document.scenes[0].tracks.main.elements[0];
					element.startTime = 100 as typeof element.startTime;
					element.duration = 200 as typeof element.duration;
					element.animations = canonical({
						[propertyPath]: data,
					}) as ElementAnimations;
					f.session.synchronize({ classic: original });
					const descriptor = resolveAnimationTarget({
						element,
						path: propertyPath,
					})!;
					const sample = resolveAnimationPathValueAtTime({
						animations: element.animations,
						propertyPath,
						localTime: getElementLocalTime({
							timelineTime: 100 + time,
							elementStartTime: 100,
							elementDuration: 200,
						}),
						fallbackValue: descriptor.getBaseValue()!,
					});
					let animations: ElementAnimations | undefined = element.animations;
					for (const keyframeId of ids)
						animations = removeElementKeyframe({
							animations,
							propertyPath,
							keyframeId,
						});
					const base = hasKeyframesForPath({ animations, propertyPath })
						? element
						: descriptor.setBaseValue({ value: sample });
					const expected = canonical({ ...base, animations });
					f.session.removeKeyframes({
						sceneId: "main-scene",
						playheadTime: 100 + time,
						preserveAtPlayhead: true,
						keyframes: ids.map((keyframeId) => ({
							...target,
							propertyPath,
							keyframeId,
						})),
					});
					expect<TimelineElement>(
						canonical(
							f.session.read().document.scenes[0].tracks.main.elements[0],
						),
					).toEqual(expected);
				}
			}
		}
	} finally {
		elementParamRegistry.register({ key: "video", definition: previous });
		f.dispose();
	}
}, 60000);

test("retaining base values does not sample or mutate other animation paths", async () => {
	const f = await fixture();
	try {
		const original = structuredClone(f.classic);
		const element = original.document.scenes[0].tracks.main.elements[0];
		element.animations = {
			opacity: scalar({}),
			other: { keys: [{ id: "untouched", time: mediaTime({ ticks: 0 }), value: "keep" }] },
		} as ElementAnimations;
		f.session.synchronize({ classic: original });
		f.session.removeKeyframes({
			sceneId: "main-scene",
			playheadTime: 0,
			preserveAtPlayhead: false,
			keyframes: ["a", "b", "c"].map((keyframeId) => ({
				...target,
				propertyPath: "opacity",
				keyframeId,
			})),
		});
		const after = f.session.read().document.scenes[0].tracks.main.elements[0];
		expect(after.params).toEqual(element.params);
		expect(after.animations).toEqual({ other: element.animations.other });
	} finally {
		f.dispose();
	}
});
