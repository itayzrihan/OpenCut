import { expect, test } from "bun:test";
import { SaveManager } from "@/core/managers/save-manager";
import {
	isBatchReadOnly,
	setBatchReadOnlyProjects,
	assertBatchEditable,
	beginAutomationHandoff,
	automationReadVersion,
	acknowledgeAutomationReload,
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

test("completed automation cannot be overwritten by a viewer left on another route", async () => {
	let writes = 0;
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "stale-viewer" } }),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject: async () => {
				writes++;
			},
		},
	} as unknown as EditorCore;
	const save = new SaveManager({ editor });
	setBatchReadOnlyProjects(["stale-viewer"]);
	const duringWork = automationReadVersion("stale-viewer");
	setBatchReadOnlyProjects([]);
	acknowledgeAutomationReload({
		projectId: "stale-viewer",
		version: duringWork,
	});
	await save.flush();
	expect(writes).toBe(0);
	expect(() => assertBatchEditable("stale-viewer")).toThrow("read-only");
	acknowledgeAutomationReload({
		projectId: "stale-viewer",
		version: automationReadVersion("stale-viewer"),
	});
	await save.flush();
	expect(writes).toBe(1);
	save.stop();
});

test("handoff freezes commands while allowing the final durable save", async () => {
	let writes = 0;
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "handoff" } }),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject: async () => {
				writes++;
			},
		},
	} as unknown as EditorCore;
	const save = new SaveManager({ editor });
	const release = beginAutomationHandoff("handoff");
	try {
		expect(() => assertBatchEditable("handoff")).toThrow("read-only");
		expect(isBatchReadOnly("handoff")).toBe(false);
		await save.flush();
		expect(writes).toBe(1);
	} finally {
		release();
		save.stop();
	}
	expect(() => assertBatchEditable("handoff")).not.toThrow();
});
