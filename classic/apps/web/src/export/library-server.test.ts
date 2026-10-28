// @opencut-test-wasm: real
import { test, expect, mock, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
const initial = await createCanonicalTestRuntime();
const Runtime = initial.constructor;
initial.free();
mock.module("opencut-editor-runtime-wasm", () => ({
	CanonicalEditorRuntime: Runtime,
}));
const fixture = JSON.parse(
	await readFile(
		new URL(
			"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
			import.meta.url,
		),
		"utf8",
	),
) as CanonicalClassicSnapshot;
let storageRevision = 9;
const latest = structuredClone(fixture.document);
latest.metadata.name = "Latest saved version";
const legacy = structuredClone(fixture.document);
legacy.metadata.name = "Obsolete top-level data";
const requests: unknown[] = [];
mock.module("@/editor-agent/server/session-store", () => ({
	operateEditorSession: async (input: unknown) => {
		requests.push(structuredClone(input));
		return {
			storageRevision,
			saved: { project: structuredClone(latest), editorRevision: 47 },
			legacyProject: structuredClone(legacy),
			lease: { sessionId: "other-editor", generation: 12 },
		};
	},
}));
mock.module("@/services/local-drive/server", () => ({
	listMedia: async () => fixture.mediaAssets,
}));
let queued: Record<string, unknown> | undefined;
mock.module("./queue/server", () => ({
	readRenderQueue: async () => ({ jobs: [] }),
	enqueueRender: async (input: Record<string, unknown>) => {
		queued = input;
		return { jobs: [input] };
	},
}));
const { captureSavedExport, enqueueSavedExport } =
	await import("./library-server");
const options = {
	format: "mp4" as const,
	quality: "high" as const,
	preferences: {
		resolution: "project" as const,
		encoding: "compatible" as const,
	},
	includeAudio: true,
};
afterAll(() => mock.restore());
test("library reads latest saved canonical project without acquiring editor ownership and uses native export plan", async () => {
	const original = structuredClone(latest);
	const result = await captureSavedExport({
		projectId: "classic-project",
		options,
	});
	expect(result.info.name).toBe("Latest saved version");
	expect(result.info.sourceRevision).toBe(47);
	expect(result.info.storageRevision).toBe(9);
	expect(result.info.plan.codec).toBe("avc");
	expect(result.info.plan.width).toBe(1920);
	expect(result.snapshot.document).toEqual(latest);
	expect(latest).toEqual(original);
	expect(
		requests.every(
			(r) =>
				JSON.stringify(r) ===
				JSON.stringify({
					projectId: "classic-project",
					request: { type: "read" },
				}),
		),
	).toBe(true);
});
test("optimistic saved-version check prevents exporting a stale selection; direct destination intent survives capture", async () => {
	storageRevision = 10;
	await expect(
		enqueueSavedExport({
			id: "export-job",
			projectId: "classic-project",
			sceneId: "main-scene",
			expectedStorageRevision: 9,
			options,
			delivery: "direct",
			destinationName: "Episode.mp4",
		}),
	).rejects.toThrow("changed");
	expect(queued).toBeUndefined();
	await enqueueSavedExport({
		id: "export-job",
		projectId: "classic-project",
		sceneId: "main-scene",
		expectedStorageRevision: 10,
		options,
		delivery: "direct",
		destinationName: "Episode.mp4",
	});
	expect(queued).toMatchObject({
		sourceRevision: 47,
		delivery: "direct",
		destinationName: "Episode.mp4",
		sceneId: "main-scene",
	});
	expect(
		(queued!.snapshot as CanonicalClassicSnapshot).document.metadata.name,
	).toBe("Latest saved version");
});
test("unknown scene fails before enqueue and explicit saved scene selection determines planning", async () => {
	await expect(
		captureSavedExport({
			projectId: "classic-project",
			sceneId: "missing",
			options,
		}),
	).rejects.toThrow("Choose a saved scene");
	const result = await captureSavedExport({
		projectId: "classic-project",
		sceneId: "main-scene",
		options: { ...options, format: "webm" },
	});
	expect(result.info.plan.codec).toBe("vp9");
	expect(result.info.sceneId).toBe("main-scene");
});
