/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixture JSON is validated by the real canonical runtime. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SmartTakePlan } from "@/timeline/smart-takes/types";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

for (const mode of ["standard", "experimental"] as const) {
	test(`real WASM ${mode} take plans survive the UI bridge, archive/reopen and undo`, async () => {
		const runtime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime,
			projectId: "classic-project",
		});
		const original = JSON.parse(
			readFileSync(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		) as CanonicalClassicSnapshot;
		const captionTrack = original.document.scenes[0].tracks.overlay[0];
		if (captionTrack.type !== "text" || !captionTrack.captionSource)
			throw new Error("Fixture needs captions");
		captionTrack.captionSource.words = [
			{ text: "hello", start: 0, end: 1 },
			{ text: "welcome", start: 2, end: 4 },
			{ text: "end", start: 5, end: 6 },
		];
		original.document.scenes[0].tracks.main.elements[0].retime = { rate: 1 };
		session.attach({ classic: original });
		const prepared = session.prepareTakes({
			sceneId: "main-scene",
			elementIds: ["item-2"],
		});
		expect(prepared.words).toHaveLength(3);
		let plan: SmartTakePlan = {
			groups: [
				{
					label: "Opening",
					selected: 0,
					confidence: 0.8,
					alternatives: [
						{
							label: "Short",
							reason: "Direct",
							parts: [{ firstWord: 0, lastWord: 0 }],
						},
						{
							label: "Long",
							reason: "Warm",
							parts: [{ firstWord: 1, lastWord: 1 }],
						},
					],
				},
				{
					label: "Ending",
					selected: 0,
					confidence: 0.9,
					alternatives: [
						{
							label: "End",
							reason: "Complete",
							parts: [{ firstWord: 2, lastWord: 2 }],
						},
					],
				},
			],
			discarded: [],
		};
		if (mode === "experimental") {
			const reviewed = session.reviewTakes({
				sceneId: "main-scene",
				elementIds: ["item-2"],
				expectedRevision: prepared.revision,
				plan,
				selections: [{ groupIndex: 0, alternativeIndex: 1 }],
			});
			expect(reviewed.story[0].dialogue).toBe("welcome");
			expect(session.read()).toEqual(original);
			plan = reviewed.plan;
		}
		session.begin();
		session.editTakes({
			sceneId: "main-scene",
			change: {
				type: "assemble",
				elementIds: ["item-2"],
				plan,
				...(mode === "experimental"
					? {
							mode,
							runMetrics: {
								elapsedMs: 1234,
								stages: [{ stage: "Focused review", durationMs: 800 }],
							},
						}
					: {}),
			},
			expectedRevision: prepared.revision,
		});
		session.commit({ label: "Smart takes", hostContext: {} });
		const assembled = session.read();
		expect(assembled.document.scenes[0].takeAssembly?.mode).toBe(mode);
		if (mode === "experimental")
			expect(
				assembled.document.scenes[0].takeAssembly?.runMetrics?.elapsedMs,
			).toBe(1234);
		expect(
			assembled.document.scenes[0].takeAssembly?.plan.groups[0].alternatives,
		).toHaveLength(2);
		const reopened = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		reopened.restore(session.archive());
		reopened.begin();
		reopened.editTakes({
			sceneId: "main-scene",
			change: {
				type: "select",
				groupIndex: 0,
				alternativeIndex: 1,
			},
		});
		reopened.commit({ label: "Select take", hostContext: {} });
		expect(
			reopened.read().document.scenes[0].takeAssembly?.plan.groups[0].selected,
		).toBe(1);
		reopened.undo();
		expect(reopened.read()).toEqual(assembled);

		session.begin();
		session.prepareTakesForAutoEdit({ sceneId: "main-scene" });
		session.commit({ label: "Prepare Full Auto Edit", hostContext: {} });
		const clean = session.read().document.scenes[0];
		expect(clean.takeAssembly).toBeUndefined();
		expect(clean.tracks.overlay).toHaveLength(0);
		expect(clean.tracks.main.elements).toEqual(
			assembled.document.scenes[0].tracks.main.elements.map(
				({ takeGroup: _takeGroup, ...clip }) => clip,
			),
		);
		session.undo();
		expect(session.read()).toEqual(assembled);
		session.undo();
		expect(session.read()).toEqual(original);
	});
}
