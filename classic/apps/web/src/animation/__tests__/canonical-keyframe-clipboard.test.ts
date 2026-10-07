// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- serialized fixtures are validated by Rust; Classic helpers are independent parity oracles. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { bindProductAnimationCatalog } from "../product-catalog";
import { elementParamRegistry } from "@/params/registry";
import { getKeyframeById } from "../keyframe-query";
import { getChannelEntriesFromData } from "../channel-data";
import { isScalarChannel } from "../interpolation";
import { pasteKeyframesIntoElement } from "./legacy-keyframe-paste";
import type { ElementAnimations, ScalarChannel, ScalarSegmentType } from "../types";
import type { KeyframeClipboardItem } from "@/clipboard";
import type { ParamDefinition } from "@/params";
import { mediaTime } from "@/wasm";
const target = { trackId: "video-track", elementId: "item-2" };
function normalized(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalized);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => [k, k === "id" ? "key-id" : normalized(v)]),
		);
	return value;
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
	prefix = "",
	segment = "bezier",
}: {
	prefix?: string;
	segment?: ScalarSegmentType;
}): ScalarChannel {
	return {
		extrapolation: { before: "hold", after: "linear" },
		keys: [
			{
				id: `${prefix}a`,
				time: mediaTime({ ticks: 20 }),
				value: 0.2,
				segmentToNext: segment,
				tangentMode: "broken",
				rightHandle: { dt: mediaTime({ ticks: 50 }), dv: 0.3 },
			},
			{
				id: `${prefix}b`,
				time: mediaTime({ ticks: 100 }),
				value: 0.8,
				segmentToNext: segment,
				tangentMode: "aligned",
				leftHandle: { dt: mediaTime({ ticks: -50 }), dv: -0.2 },
			},
		],
	};
}
test("portable copy and paste match Classic values, offsets, curves and collision behavior", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	const params: ParamDefinition[] = [
		{ key: "test.color", label: "Color", type: "color", default: "white" },
		{ key: "test.text", label: "Text", type: "text", default: "" },
		{ key: "test.boolean", label: "Boolean", type: "boolean", default: false },
	];
	try {
		elementParamRegistry.register({
			key: "video",
			definition: [...previous, ...params],
		});
		for (const segment of (["linear", "step", "bezier"] as const)) {
			const original = structuredClone(f.classic);
			const element = original.document.scenes[0].tracks.main.elements[0];
			element.duration = mediaTime({ ticks: 250 });
			// Different component identities exercise exact-time reuse and patch targeting.
			element.animations = {
				opacity: scalar({ segment }),
				"test.color": {
					a: scalar({ prefix: "alpha-", segment }),
					b: scalar({ prefix: "blue-", segment }),
					g: scalar({ prefix: "green-", segment }),
					r: scalar({ segment }),
				},
				"test.text": {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 20 }), value: "שלום" },
						{ id: "b", time: mediaTime({ ticks: 100 }), value: "עולם" },
					],
				},
				"test.boolean": {
					keys: [
						{ id: "a", time: mediaTime({ ticks: 20 }), value: false },
						{ id: "b", time: mediaTime({ ticks: 100 }), value: true },
					],
				},
			} as ElementAnimations;
			f.session.synchronize({ classic: original });
			const refs = Object.keys(element.animations).flatMap((propertyPath) =>
				["b", "a"].map((keyframeId) => ({ propertyPath, keyframeId })),
			);
			const expected: KeyframeClipboardItem[] = refs
				.map(({ propertyPath, keyframeId }) => {
					const key = getKeyframeById({
						animations: element.animations,
						propertyPath,
						keyframeId,
					})!;
					const curvePatches = getChannelEntriesFromData({
						data: element.animations?.[propertyPath],
					}).flatMap(([componentKey, channel]) => {
						if (!isScalarChannel(channel)) return [];
						const k = channel.keys.find((k) => k.id === keyframeId);
						if (!k) return [];
						return [
							{
								componentKey,
								patch: {
									leftHandle: k.leftHandle ?? null,
									rightHandle: k.rightHandle ?? null,
									segmentToNext: k.segmentToNext,
									tangentMode: k.tangentMode,
								},
							},
						];
					});
					return {
						propertyPath,
						timeOffset: mediaTime({ ticks: key.time - 20 }),
						value: key.value,
						interpolation: key.interpolation,
						curvePatches,
					};
				})
				.sort(
					(a, b) =>
						a.timeOffset - b.timeOffset ||
						(a.propertyPath < b.propertyPath
							? -1
							: a.propertyPath > b.propertyPath
								? 1
								: 0),
				);
			const before = f.session.read();
			const copied = f.session.copyKeyframes({
				sceneId: "main-scene",
				...target,
				keyframes: refs,
			});
			expect(copied.items).toEqual(expected);
			expect(f.session.read()).toEqual(before);
			for (const time of [-90, 0, 20, 75, 100, 220, 300]) {
				f.session.synchronize({ classic: original });
				const expectedElement = pasteKeyframesIntoElement({
					element,
					time: mediaTime({ ticks: time }),
					clipboardItems: expected,
				});
				const result = f.session.pasteKeyframes({
					sceneId: "main-scene",
					...target,
					time,
					items: copied.items,
				});
				expect(result.skipped).toEqual([]);
				expect(
					normalized(
						f.session.read().document.scenes[0].tracks.main.elements[0],
					),
				).toEqual(normalized(expectedElement));
			}
		}
	} finally {
		elementParamRegistry.register({ key: "video", definition: previous });
		f.dispose();
	}
}, 30000);

test("RGBA selection and clipboard primary identity survive JSON component reordering", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	try {
		elementParamRegistry.register({
			key: "video",
			definition: [
				...previous,
				{ key: "test.color", label: "Color", type: "color", default: "white" },
			],
		});
		for (const order of [
			["r", "g", "b", "a"],
			["a", "b", "g", "r"],
			["g", "r", "a", "b"],
		]) {
			const classic = structuredClone(f.classic);
			const data = Object.fromEntries(order.map((name) => [name, scalar({})]));
			const element = classic.document.scenes[0].tracks.main.elements[0];
			element.animations = { "test.color": data } as ElementAnimations;
			expect(
				getChannelEntriesFromData({
					data: element.animations["test.color"],
				}).map(([k]) => k),
			).toEqual(["r", "g", "b", "a"]);
			f.session.synchronize({ classic });
			const copied = f.session.copyKeyframes({
				sceneId: "main-scene",
				...target,
				keyframes: [{ propertyPath: "test.color", keyframeId: "a" }],
			});
			expect(copied.items[0].curvePatches.map((p) => p.componentKey)).toEqual([
				"r",
				"g",
				"b",
				"a",
			]);
			expect(copied.items[0].value).toEqual(
				getKeyframeById({
					animations: element.animations,
					propertyPath: "test.color",
					keyframeId: "a",
				})!.value,
			);
		}
	} finally {
		elementParamRegistry.register({ key: "video", definition: previous });
		f.dispose();
	}
});
