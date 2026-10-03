import { expect, mock, test } from "bun:test";

test("portable settings include future keys and remove settings absent from the selected version", async () => {
	let disk: Record<string, string> = {};
	mock.module("../client", () => ({
		localDriveRequest: async ({
			operation,
			payload,
		}: {
			operation: string;
			payload?: { key: string; value: string };
		}) => {
			if (operation === "preferences.list") return { ...disk };
			if (operation === "preferences.put") disk[payload!.key] = payload!.value;
		},
	}));
	const { saveAllAccountPreferences, hydrateAccountPreferences } =
		await import("../preferences");
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const values = new Map<string, string>();
	const storage = {
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	try {
		storage.setItem("future-editor-setting", '{"preserve":true}');
		storage.setItem("obsolete-preference", "local");
		storage.setItem("pocut-local-drive-migration-v1", "complete");
		await saveAllAccountPreferences();
		expect(disk["future-editor-setting"]).toBe('{"preserve":true}');
		expect(disk["pocut-local-drive-migration-v1"]).toBeUndefined();
		disk = { "future-editor-setting": '{"restored":true}' };
		expect(await hydrateAccountPreferences()).toBe(true);
		expect(storage.getItem("obsolete-preference")).toBeNull();
		expect(storage.getItem("future-editor-setting")).toBe('{"restored":true}');
		expect(storage.getItem("pocut-local-drive-migration-v1")).toBe("complete");
		expect(await hydrateAccountPreferences()).toBe(false);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
