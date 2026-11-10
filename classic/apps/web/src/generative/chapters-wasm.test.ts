// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
test("actual browser runtime builds timed chapters and restores editable collection through canonical archive", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		for (let i = 0; i < 4; i++)
			classic.mediaAssets.push({
				id: `chapter-${i}`,
				name: `Chapter ${i + 1}`,
				type: "video",
				duration: 10,
			});
		const call = ({
			id,
			input,
		}: {
			id: string;
			input: Record<string, unknown>;
		}) => runtime.invokeSync(id, input, {}).result.data;
		const state = () => call({ id: "app.state.read", input: {} }).value;
		call({
			id: "project.classic.session.attach",
			input: { projectId: "classic-project", expectedRevision: 0, classic },
		});
		const edit = ({
			capability = "project.generative.edit",
			change,
		}: {
			capability?: string;
			change: Record<string, unknown>;
		}) =>
			call({
				id: capability,
				input: {
					projectId: "classic-project",
					expectedRevision: state().revision,
					change,
				},
			});
		edit({
			capability: "project.production.edit",
			change: {
				type: "createScriptRow",
				rowId: "long",
				content: {
					startMs: 0,
					endMs: 35000,
					sourceLanguage: "he",
					sourceText: "שלום עולם זו בדיקה מלאה של הסרט שלנו",
					latinTransliteration:
						"shalom olam zu bdika mle'a shel haseret shelanu",
					speaker: "Narrator",
					visualDescription: "Forest at dawn",
					timingEstimated: false,
				},
			},
		});
		const planned = call({
			id: "project.generative.chapters.build",
			input: {
				projectId: "classic-project",
				expectedRevision: state().revision,
				id: "film",
				title: "Film",
				model: "test/live-model",
				resolution: "720p",
				aspectRatio: "16:9",
				supportedDurations: [5, 10],
			},
		}).plan;
		expect(planned.chapters).toHaveLength(4);
		expect(
			planned.chapters
				.map((c: { sourceText: string }) => c.sourceText)
				.join(""),
		).toBe("שלום עולם זו בדיקה מלאה של הסרט שלנו");
		expect(
			planned.chapters.map((c: { duration: number }) => c.duration),
		).toEqual([10, 10, 10, 5]);
		const ids = Array.from({ length: 4 }, (_, i) => String(i + 1).repeat(32));
		edit({
			change: {
				type: "chapterBatch",
				planId: "film",
				version: 1,
				batchId: "a".repeat(32),
				jobIds: ids,
			},
		});
		for (const [index, id] of ids.entries())
			edit({
				change: {
					type: "job",
					job: {
						id,
						digest: "b".repeat(64),
						status: "ready",
						mediaId: `chapter-${index}`,
					},
				},
			});
		const collection = call({
			id: "project.generative.chapters.collection",
			input: {
				projectId: "classic-project",
				expectedRevision: state().revision,
				planId: "film",
				startTime: 2400000,
			},
		});
		expect(collection.clips).toHaveLength(4);
		const inserted = call({
			id: "timeline.classic.elements.insert",
			input: {
				projectId: "classic-project",
				sceneId: "main-scene",
				expectedRevision: state().revision,
				clips: collection.clips,
			},
		});
		expect(inserted.elements).toHaveLength(4);
		const archive = call({
			id: "project.classic.session.archive",
			input: { projectId: "classic-project", persistableOnly: true },
		});
		const reopened = await createCanonicalTestRuntime();
		try {
			reopened.invokeSync(
				"project.classic.session.restore",
				{ projectId: "classic-project", expectedRevision: 0, archive },
				{},
			);
			const saved = reopened.invokeSync(
				"app.state.read",
				{ pointer: "/project/extensions/generative/chapterPlans/0" },
				{},
			).result.data.value;
			expect(saved.id).toBe("film");
			expect(saved.jobIds).toEqual(ids);
			expect(saved.chapters).toEqual(planned.chapters);
		} finally {
			reopened.free();
		}
	} finally {
		runtime.free();
	}
});
