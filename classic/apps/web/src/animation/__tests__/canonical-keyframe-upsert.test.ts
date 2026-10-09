// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- serialized fixtures are validated by real Rust WASM; the existing Classic helpers are the parity oracle. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
	type ClassicKeyframeUpsert,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { bindProductAnimationCatalog } from "../product-catalog";
import { upsertPathKeyframe } from "../keyframes";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { elementParamRegistry } from "@/params/registry";
import {
	coerceParamValue,
	parseColorToLinearRgba,
	type ParamDefinition,
} from "@/params";
import { mediaTime } from "@/wasm";
import type { ScalarAnimationChannel } from "../types";

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
	const element = () =>
		session.read().document.scenes[0].tracks.main.elements[0];
	const write = (keyframes: ClassicKeyframeUpsert[]) =>
		session.upsertKeyframes({ sceneId: "main-scene", keyframes });
	return { runtime, session, element, write, dispose };
}
function key({
	propertyPath,
	value,
	time = 0,
	keyframeId,
}: {
	propertyPath: string;
	value: ClassicKeyframeUpsert["value"];
	time?: number;
	keyframeId?: string;
}): ClassicKeyframeUpsert {
	return {
		trackId: "video-track",
		elementId: "item-2",
		propertyPath,
		value,
		time,
		keyframeId,
	};
}
function json(v: unknown): unknown {
	return JSON.parse(JSON.stringify(v));
}

test("canonical upserts match Classic scalar/discrete authoring, time collisions and existing curves", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	const params: ParamDefinition[] = [
		{ key: "future.text", label: "Text", type: "text", default: "" },
		{
			key: "future.boolean",
			label: "Enabled",
			type: "boolean",
			default: false,
		},
		{
			key: "future.select",
			label: "Mode",
			type: "select",
			default: "on",
			options: [
				{ value: "on", label: "On" },
				{ value: "off", label: "Off" },
			],
		},
	];
	try {
		elementParamRegistry.register({
			key: "video",
			definition: [...previous, ...params],
		});
		const classic = f.session.read();
		classic.document.scenes[0].tracks.main.elements[0].animations = {
			opacity: {
				keys: [
					{
						id: "a",
						time: mediaTime({ ticks: 0 }),
						value: 0,
						segmentToNext: "bezier",
						tangentMode: "broken",
						rightHandle: { dt: mediaTime({ ticks: 40 }), dv: 0.25 },
					},
					{
						id: "b",
						time: mediaTime({ ticks: 100 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "flat",
						leftHandle: { dt: mediaTime({ ticks: -40 }), dv: -0.25 },
					},
				],
			},
		};
		f.session.synchronize({ classic });
		const edits = [
			key({
				propertyPath: "opacity",
				value: 0.25,
				time: 50,
				keyframeId: "middle",
			}),
			key({
				propertyPath: "opacity",
				value: 0.6,
				time: 50,
				keyframeId: "ignored-on-time-collision",
			}),
			{
				...key({
					propertyPath: "opacity",
					value: 0.8,
					time: 20,
					keyframeId: "b",
				}),
				interpolation: "hold" as const,
			},
			key({
				propertyPath: "opacity",
				value: 3,
				time: -100,
				keyframeId: "outside",
			}),
			key({
				propertyPath: "opacity",
				value: 0.3,
				time: 999999999,
				keyframeId: "last",
			}),
			key({
				propertyPath: "future.text",
				value: "שלום עולם",
				time: 3,
				keyframeId: "text",
			}),
			key({
				propertyPath: "future.boolean",
				value: true,
				time: 7,
				keyframeId: "boolean",
			}),
			key({
				propertyPath: "future.select",
				value: "off",
				time: 5,
				keyframeId: "select",
			}),
		];
		let expected = f.element().animations;
		for (const edit of edits) {
			const element = f.element();
			const target = resolveAnimationTarget({
				element,
				path: edit.propertyPath,
			})!;
			expected = upsertPathKeyframe({
				animations: expected,
				propertyPath: edit.propertyPath,
				time: mediaTime({
					ticks: Math.min(element.duration, Math.max(0, edit.time)),
				}),
				value: edit.value,
				interpolation: edit.interpolation,
				keyframeId: edit.keyframeId,
				channelLayout: target.channelLayout,
				coerceValue: target.coerceValue,
			});
			f.write([edit]);
			expect(json(f.element().animations)).toEqual(json(expected));
		}
	} finally {
		f.dispose();
		elementParamRegistry.register({ key: "video", definition: previous });
		f.session.dispose();
	}
}, 30000);

test("canonical numeric coercion matches product step rounding including negatives and scientific precision", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	try {
		const params: ParamDefinition[] = [
			0, 0.01, 0.1, 0.25, 1, 2.5e-7, 1e-8, 1.25e-6,
		].map((step, i) => ({
			key: `future.step${i}`,
			label: "Step",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step,
		}));
		elementParamRegistry.register({
			key: "video",
			definition: [...previous, ...params],
		});
		const values = [
			-1000,
			-2.55,
			-0.5,
			-0.05,
			-3.75e-7,
			0,
			0.05,
			0.125,
			0.375,
			2.55,
			3.75e-7,
			1000,
			...Array.from({ length: 25 }, (_, i) => Math.sin(i * 7.13) * 23.71),
		];
		f.write(
			params.flatMap((param) =>
				values.map((value, i) =>
					key({
						propertyPath: param.key,
						value,
						time: i,
						keyframeId: `${param.key}:${i}`,
					}),
				),
			),
		);
		for (const param of params) {
			const keys = (
				f.element().animations![param.key] as ScalarAnimationChannel
			).keys;
			expect(keys).toHaveLength(values.length);
			for (const [i, value] of values.entries())
				expect(json(keys[i].value)).toBe(
					json(coerceParamValue({ param, value })),
				);
		}
	} finally {
		f.dispose();
		elementParamRegistry.register({ key: "video", definition: previous });
		f.session.dispose();
	}
}, 30000);

test("canonical CSS color keys match product linear RGBA for CSS spaces and share stable identity", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	try {
		elementParamRegistry.register({
			key: "video",
			definition: [
				...previous,
				{
					key: "future.color",
					label: "Color",
					type: "color",
					default: "white",
				},
			],
		});
		const colors = [
			"red",
			"#abc",
			"#1234",
			"#80402080",
			"transparent",
			"rebeccapurple",
			"rgb(128 64 32 / .4)",
			"rgba(10%, 20%, 30%, .5)",
			"hsl(240 80% 60%)",
			"hwb(60 10% 20%)",
			"lab(60% 15 20)",
			"lch(60% 35 150)",
			"oklab(.6 .1 .15)",
			"oklch(70% .15 30deg)",
			"color(display-p3 1 .2 .1 / .4)",
			"color(rec2020 .7 .2 .1)",
			"color(a98-rgb .3 .7 .1)",
			"color(prophoto-rgb .6 .2 .3)",
			"color(srgb-linear .5 .2 .1)",
			"rgb(none 30 40)",
		];
		f.write(
			colors.map((value, i) =>
				key({
					propertyPath: "future.color",
					value,
					time: i,
					keyframeId: `color:${i}`,
				}),
			),
		);
		const channels = f.element().animations!["future.color"] as Record<
			string,
			ScalarAnimationChannel
		>;
		for (const [i, color] of colors.entries()) {
			const expected = parseColorToLinearRgba({ color })!;
			expect(expected).not.toBeNull();
			for (const c of ["r", "g", "b", "a"] as const) {
				expect(channels[c].keys[i].id).toBe(`color:${i}`);
				expect(channels[c].keys[i].value).toBeCloseTo(expected[c], 10);
			}
		}
		f.write([key({ propertyPath: "future.color", value: "blue", time: 3 })]);
		const updated = f.element().animations!["future.color"] as Record<
			string,
			ScalarAnimationChannel
		>;
		for (const c of ["r", "g", "b", "a"]) {
			expect(updated[c].keys).toHaveLength(colors.length);
			expect(updated[c].keys[3].id).toBe("color:3");
		}
	} finally {
		f.dispose();
		elementParamRegistry.register({ key: "video", definition: previous });
		f.session.dispose();
	}
}, 30000);
