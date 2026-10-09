// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures cross the real Rust JSON boundary; product descriptors are compared with the existing resolver. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bindProductAnimationCatalog } from "../product-catalog";
import { specializedAnimationTargets } from "../target-registry";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import {
	getParamChannelLayout,
	type ParamDefinition,
	type ParamValue,
} from "@/params";
import {
	DefinitionRegistry,
	elementParamRegistry,
	getElementParams,
} from "@/params/registry";
import { effectsRegistry } from "@/effects";
import { graphicsRegistry } from "@/graphics/registry";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { PARALLAX_CAMERA_KEYFRAME_PARAMS } from "@/parallax-story-teller/camera-keyframes";
import { PARALLAX_CAMERA_GUIDE_KIND } from "@/parallax-story-teller/model";
import type { TimelineElement } from "@/timeline/types";

const READ = "animation.classic.targets.read";
const numberParam: ParamDefinition = {
	type: "number",
	key: "future.parameter",
	label: "Future parameter",
	default: 2,
	min: -10,
	max: 10,
	step: 0.1,
};
type Target = {
	propertyPath: string;
	baseValue: ParamValue;
	animated: boolean;
	parameter: ParamDefinition & { channelLayout: unknown };
};
type Output = {
	targets: Target[];
	total: number;
	catalogRevision: string;
	revision: number;
	nextOffset: number | null;
};

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
	const read = (input: Record<string, unknown> = {}) =>
		(
			runtime.invokeSync(
				READ,
				{
					projectId: "classic-project",
					sceneId: "main-scene",
					trackId: "video-track",
					elementId: "item-2",
					includeParameters: true,
					limit: 100,
					...input,
				},
				undefined,
			) as { result: { data: Output } }
		).result.data;
	return { runtime, session, read, dispose };
}

function json<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

test("product animation targets match actual resolver for all element, graphics, effect and camera definitions", async () => {
	const f = await fixture();
	try {
		const source = f.session.importHyperframes({
			name: "Catalog fixture",
			source: {
				entryFile: "index.html",
				files: {
					"index.html":
						"<div data-composition-id='catalog' data-duration='6'>Catalog fixture</div>",
				},
				resourceAssetIds: {},
			},
		});
		const classic = f.session.read();
		const original = classic.document.scenes[0].tracks.main.elements[0];
		const cases: Array<{ element: TimelineElement; expected: string[] }> = [];
		for (const [type, params] of elementParamRegistry.entries()) {
			const element = { ...original, type, params: {} } as unknown as TimelineElement;
			if (type === "graphic")
				Object.assign(element, {
					definitionId: graphicsRegistry.entries()[0][0],
				});
			cases.push({
				element,
				expected: params
					.filter((p) => p.keyframable !== false)
					.map((p) => p.key),
			});
		}
		for (const [definitionId, definition] of graphicsRegistry.entries()) {
			const element = {
				...original,
				type: "graphic",
				definitionId,
				params:
					definitionId === "hyperframes"
						? { hyperframesAssetId: source.assetId }
						: {},
			} as unknown as TimelineElement;
			cases.push({
				element,
				expected: [
					...getElementParams({ element })
						.filter((p) => p.keyframable !== false)
						.map((p) => p.key),
					...definition.params
						.filter((p) => p.keyframable !== false)
						.map((p) => `params.${p.key}`),
				],
			});
		}
		for (const effect of effectsRegistry.getAll()) {
			const element = {
				...original,
				effects: [
					{ id: "test-fx", type: effect.type, params: {}, enabled: true },
				],
			} as unknown as TimelineElement;
			cases.push({
				element,
				expected: [
					...getElementParams({ element })
						.filter((p) => p.keyframable !== false)
						.map((p) => p.key),
					...effect.params
						.filter((p) => p.keyframable !== false)
						.map((p) => `effects.test-fx.params.${p.key}`),
				],
			});
		}
		for (const kind of ["parallax-story-teller", PARALLAX_CAMERA_GUIDE_KIND]) {
			cases.push({
				element: {
					...original,
					type: "effect",
					params: { kind },
				} as unknown as TimelineElement,
				expected: PARALLAX_CAMERA_KEYFRAME_PARAMS.map((p) => `params.${p.key}`),
			});
		}
		for (const { element, expected } of cases) {
			const next = structuredClone(classic);
			next.document.scenes[0].tracks.main.elements[0] =
				element as typeof original;
			f.session.synchronize({ classic: next });
			const targets: Target[] = [];
			let offset: number | null = 0;
			do {
				const page = f.read({ offset });
				targets.push(...page.targets);
				offset = page.nextOffset;
			} while (offset !== null);
			for (const path of expected)
				expect(targets.some((t) => t.propertyPath === path)).toBe(true);
			for (const target of targets) {
				const resolved = resolveAnimationTarget({
					element,
					path: target.propertyPath,
				});
				expect(resolved).not.toBeNull();
				expect(target.baseValue).toEqual(resolved!.getBaseValue()!);
				expect(target.parameter.channelLayout).toEqual(
					json(resolved!.channelLayout),
				);
			}
		}
	} finally {
		f.dispose();
		f.session.dispose();
	}
}, 60000);

test("new product definitions appear live and rejected registrations roll back every host", async () => {
	const f = await fixture();
	const previous = elementParamRegistry.get("video");
	try {
		const before = f.session.read();
		const originalCatalog = f.read().catalogRevision;
		elementParamRegistry.register({
			key: "video",
			definition: [...previous, numberParam],
		});
		const added = f.read({ propertyPath: numberParam.key });
		expect(added.total).toBe(1);
		expect(added.targets[0].parameter.channelLayout).toEqual(
			json(getParamChannelLayout({ param: numberParam })),
		);
		expect(added.catalogRevision).not.toBe(originalCatalog);
		expect(f.session.read()).toEqual(before);
		const fail = elementParamRegistry.subscribeDefinitions(() => {
			throw new Error("second host refused");
		});
		try {
			expect(() =>
				elementParamRegistry.register({ key: "video", definition: previous }),
			).toThrow("second host refused");
			expect(f.read({ propertyPath: numberParam.key })).toEqual(added);
			expect(elementParamRegistry.get("video")).toContain(numberParam);
		} finally {
			fail();
		}
		f.session.begin();
		try {
			expect(() =>
				elementParamRegistry.register({ key: "video", definition: previous }),
			).toThrow("transaction");
			expect(f.read({ propertyPath: numberParam.key })).toEqual(added);
		} finally {
			f.session.rollback();
		}
		elementParamRegistry.register({ key: "video", definition: previous });
		expect(f.read().catalogRevision).toBe(originalCatalog);
		f.dispose();
		// A detached host must not receive registration during its transaction.
		f.session.begin();
		try {
			elementParamRegistry.register({ key: "video", definition: previous });
		} finally {
			f.session.rollback();
		}
	} finally {
		f.dispose();
		elementParamRegistry.register({ key: "video", definition: previous });
		f.session.dispose();
	}
}, 20000);

test("new graphic and effect definitions publish automatically without adding an agent tool", async () => {
	const f = await fixture();
	try {
		const before = f.read().catalogRevision;
		const graphic = {
			id: "catalog-future-graphic",
			name: "Future",
			keywords: [],
			params: [numberParam],
			render() {},
		};
		graphicsRegistry.register({ key: graphic.id, definition: graphic });
		expect(f.read().catalogRevision).not.toBe(before);
		const effect = {
			...effectsRegistry.getAll()[0],
			type: "catalog-future-effect",
			params: [numberParam],
		};
		effectsRegistry.register({ key: effect.type, definition: effect });
		const classic = f.session.read();
		const original = classic.document.scenes[0].tracks.main.elements[0];
		classic.document.scenes[0].tracks.main.elements[0] = {
			...original,
			type: "graphic",
			definitionId: graphic.id,
			params: {},
			effects: [{ id: "new-fx", type: effect.type, params: {}, enabled: true }],
		} as unknown as typeof original;
		f.session.synchronize({ classic });
		expect(f.read({ propertyPath: `params.${numberParam.key}` }).total).toBe(1);
		expect(
			f.read({ propertyPath: `effects.new-fx.params.${numberParam.key}` })
				.total,
		).toBe(1);
		specializedAnimationTargets.register({
			key: "future-kind",
			definition: {
				elementType: "effect",
				paramKind: "future-kind",
				pathPrefix: "params.",
				params: [numberParam],
			},
		});
		const element = {
			...original,
			type: "effect",
			params: { kind: "future-kind" },
		} as unknown as TimelineElement;
		classic.document.scenes[0].tracks.main.elements[0] =
			element as typeof original;
		f.session.synchronize({ classic });
		const path = `params.${numberParam.key}`;
		expect(f.read({ propertyPath: path }).targets[0].baseValue).toBe(
			resolveAnimationTarget({ element, path })!.getBaseValue()!,
		);
	} finally {
		f.dispose();
		f.session.dispose();
	}
}, 20000);

test("generic registry publication is ordered, rolled back on rejection and detachable", () => {
	const registry = new DefinitionRegistry<string, number>("test");
	registry.register({ key: "a", definition: 1 });
	const calls: unknown[] = [];
	const first = registry.subscribeDefinitions((entries) => {
		calls.push(entries);
	});
	const second = registry.subscribeDefinitions((entries) => {
		if (entries[0][1] === 2) throw new Error("reject");
	});
	expect(() => registry.register({ key: "a", definition: 2 })).toThrow(
		"reject",
	);
	expect(registry.get("a")).toBe(1);
	expect(calls).toEqual([[["a", 2]], [["a", 1]]]);
	second();
	first();
	registry.register({ key: "a", definition: 3 });
	expect(calls).toHaveLength(2);
	expect(registry.entries()).toEqual([["a", 3]]);
});
