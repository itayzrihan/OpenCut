import { expect, test } from "bun:test";
import { browserEditorSessionId } from "../session-identity";

test("reload resumes its identity, copied tabs cannot share it, and account/project scopes stay separate", async () => {
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const held = new Set<string>();
	const writes = new Map<string, string>();
	let stored = "previous-document-session";
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			sessionStorage: {
				getItem: () => stored,
				setItem: (key: string, value: string) => writes.set(key, value),
			},
		},
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: async (
					name: string,
					options: LockOptions,
					callback: LockGrantedCallback<unknown>,
				) => {
					expect(options.ifAvailable).toBe(true);
					if (held.has(name)) return callback(null);
					held.add(name);
					return callback({ name, mode: "exclusive" } as Lock);
				},
			},
		},
	});
	try {
		const scope = { accountId: "alice", projectId: "reload" };
		expect(await browserEditorSessionId(scope)).toBe(stored);
		expect(await browserEditorSessionId(scope)).toBe(stored);
		// Another document's copied storage ID is already held. Use a distinct
		// scope to exercise a fresh resolver in this test's single JS module.
		const duplicate = await browserEditorSessionId({
			...scope,
			projectId: "copied-tab",
		});
		expect(duplicate).not.toBe(stored);
		expect(held.has(`opencut-editor-identity:${duplicate}`)).toBe(true);
		// A closed document releases its browser lock. Reload may claim that ID.
		held.delete(`opencut-editor-identity:${stored}`);
		expect(
			await browserEditorSessionId({ ...scope, projectId: "after-close" }),
		).toBe(stored);
		stored = "other-account-session";
		expect(await browserEditorSessionId({ ...scope, accountId: "bob" })).toBe(
			stored,
		);
		expect(writes.size).toBe(4);
	} finally {
		if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (oldNavigator)
			Object.defineProperty(globalThis, "navigator", oldNavigator);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});
