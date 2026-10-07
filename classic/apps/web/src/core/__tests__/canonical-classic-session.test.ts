/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the shared serialized fixture is validated by the real Rust runtime in these tests. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	canonicalMediaBindings,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

function fixture(): CanonicalClassicSnapshot {
	return JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
}

test("real WASM session groups host edits, restores context and reopens compact history", async () => {
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	const original = fixture();
	session.attach({ classic: original });
	expect(session.status().canUndo).toBe(false);
	const refresh = structuredClone(original);
	refresh.document.metadata.name = "Host refresh";
	session.synchronize({ classic: refresh });
	expect(session.status().canUndo).toBe(false);
	session.begin();
	const changed = structuredClone(refresh);
	changed.document.metadata.name = "First update";
	session.synchronize({ classic: changed });
	changed.document.settings.canvasSize.width = 1080;
	session.synchronize({ classic: changed });
	session.commit({
		label: "Compound edit",
		hostContext: {
			previousSelection: { selectedElements: [] },
			callbackId: "command",
			optionalMetadata: { absent: undefined, cleared: null },
		},
	});
	expect(session.read()).toEqual(changed);
	expect(session.undo().hostContext).toEqual({
		previousSelection: { selectedElements: [] },
		callbackId: "command",
		optionalMetadata: { cleared: null },
	});
	expect(session.read()).toEqual(refresh);
	expect(session.status().canUndo).toBe(false);
	const saved = session.archive();
	const reopened = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	reopened.restore(saved);
	expect(reopened.read()).toEqual(refresh);
	reopened.redo();
	expect(reopened.read()).toEqual(changed);
	reopened.dispose();
	session.dispose();
});

test("failed host edits roll back without losing redo or source packages", async () => {
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	session.attach({ classic: fixture() });
	const imported = session.importHyperframes({
		name: "Source",
		source: {
			entryFile: "index.html",
			files: {
				"index.html":
					"<div data-composition-id='main' data-duration='6'>שלום</div>",
			},
			resourceAssetIds: {},
		},
	});
	expect(
		session.read().document.hyperframesCompositions?.[imported.assetId].source
			.files["index.html"],
	).toContain("שלום");
	session.undo();
	const before = session.read();
	session.begin();
	const invalid = structuredClone(before);
	invalid.document.currentSceneId = "missing-scene";
	expect(() => session.synchronize({ classic: invalid })).toThrow();
	session.rollback();
	expect(session.read()).toEqual(before);
	expect(session.status().canRedo).toBe(true);
	session.redo();
	expect(Object.keys(session.archive().sources)).toHaveLength(1);
	session.dispose();
});

test("durable history respects media side-effect boundaries and omits browser handles", async () => {
	const file = new File(["bytes"], "image.png", { lastModified: 123 });
	const bindings = canonicalMediaBindings([
		{
			id: "image",
			name: "image.png",
			type: "image",
			file,
			url: "blob:local",
			thumbnailUrl: "blob:thumbnail",
		},
	]);
	expect(bindings[0]).toEqual({
		id: "image",
		name: "image.png",
		type: "image",
		size: 5,
		lastModified: 123,
	});
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	session.attach({ classic: fixture() });
	for (const persistable of [true, false, true]) {
		session.begin();
		const state = session.read();
		state.document.metadata.name += " edit";
		session.synchronize({ classic: state });
		session.commit({ label: "Edit", hostContext: { persistable } });
	}
	expect(session.archive().undoStack).toHaveLength(1);
	session.undo();
	session.undo();
	session.undo();
	expect(session.read()).toEqual(fixture());
	session.dispose();
});
