// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The adapter fixture supplies only SelectionManager's command boundary. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { EditorCore } from "@/core";
import { CanonicalClassicSession } from "../canonical-classic-session";
import { SelectionManager } from "../managers/selection-manager";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

test("canonical selection projection stays stable, stages transaction refs, clears on scene/account/unload and never expands linked rows", async () => {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	const fixture = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	session.attach({ classic: fixture });
	let active = true;
	let inTransaction = false;
	let accountId = "account-a";
	const editor = {
		command: {
			getCanonicalRevision: () =>
				active ? session.status().revision : undefined,
			readClassicSelection: () =>
				active && !inTransaction
					? { ...session.readSelection(), accountId }
					: undefined,
			writeClassicSelection: ({
				elements,
				preserveRowScope,
			}: Parameters<EditorCore["command"]["writeClassicSelection"]>[0]) =>
				active && !inTransaction
					? {
							...session.setSelection({
								type: "elements",
								elements,
								preserveRowScope,
								reconcileMissing: true,
							}),
							accountId,
						}
					: undefined,
		},
	} as EditorCore;
	const selection = new SelectionManager(editor);
	try {
		const before = session.status();
		session.setSelection({ type: "track", trackId: "video-track" });
		selection.refreshCanonicalSelection({ clearSpecific: true });
		const refs = selection.getSelectedElements();
		expect(refs).toEqual([{ trackId: "video-track", elementId: "item-2" }]);
		for (let i = 0; i < 100; i++)
			expect(selection.getSelectedElements()).toBe(refs);
		expect(session.status()).toEqual(before);
		expect(selection.getExactTrackSelectionId()).toBe("video-track");
		selection.setSelectedElements({ elements: refs });
		expect(selection.getExactTrackSelectionId()).toBeNull();
		session.setSelection({ type: "track", trackId: "video-track" });
		inTransaction = true;
		selection.applySelectionPatch({ patch: { selectedElements: refs } });
		inTransaction = false;
		selection.flushCanonicalSelection();
		expect(selection.getExactTrackSelectionId()).toBe("video-track");
		selection.setSelectedElements({
			elements: [...refs, { trackId: "titles", elementId: "text-1" }],
		});
		expect(session.readSelection().exactTrackId).toBeNull();
		expect(session.readSelection().elements).toHaveLength(2);
		const state = runtime.invokeSync(
			"app.state.read",
			{ pointer: "/selection" },
			{},
		) as { result: { data: { value: { itemIds: string[] } } } };
		expect(state.result.data.value.itemIds).toEqual(["item-2", "text-1"]);
		session.openScene("other-scene");
		expect(selection.getSelectedElements()).toEqual([]);
		session.openScene("main-scene");
		session.setSelection({ type: "track", trackId: "video-track" });
		selection.refreshCanonicalSelection();
		accountId = "account-b";
		const changedAccount = selection.getSelectedElements();
		expect(changedAccount).not.toBe(refs);
		active = false;
		expect(selection.getSelectedElements()).toEqual([]);
	} finally {
		session.dispose();
	}
});
