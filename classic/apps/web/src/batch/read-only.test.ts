import { expect, test } from "bun:test";
import { SaveManager } from "@/core/managers/save-manager";
import {
	isBatchReadOnly,
	setBatchReadOnlyProjects,
	assertBatchEditable,
} from "./read-only";
import type { EditorCore } from "@/core";
test("locked viewer cannot save or execute edits; unrelated projects remain editable", async () => {
	let saved = 0;
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "busy" } }),
			saveCurrentProject: async () => {
				saved++;
			},
		},
	} as unknown as EditorCore;
	const manager = new SaveManager({ editor });
	try {
		setBatchReadOnlyProjects(["busy"]);
		expect(isBatchReadOnly("busy")).toBe(true);
		expect(() => assertBatchEditable("busy")).toThrow("read-only");
		expect(() => assertBatchEditable("other")).not.toThrow();
		manager.markDirty();
		await manager.flush();
		expect(saved).toBe(0);
		expect(manager.getIsDirty()).toBe(false);
	} finally {
		setBatchReadOnlyProjects([]);
		manager.stop();
	}
});
