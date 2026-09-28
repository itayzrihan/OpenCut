import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
test("browser bootstrap preserves legacy settings and isolates account storage before hydration", async () => {
	class Storage {
		data = new Map<string, string>();
		get length() {
			return this.data.size;
		}
		getItem(key: string) {
			return this.data.get(key) ?? null;
		}
		setItem(key: string, value: string) {
			this.data.set(key, String(value));
		}
		removeItem(key: string) {
			this.data.delete(key);
		}
		clear() {
			this.data.clear();
		}
		key(index: number) {
			return [...this.data.keys()][index] ?? null;
		}
	}
	const storage = new Storage(),
		session = new Storage();
	const alice = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		bob = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
	storage.setItem("panel-sizes", "legacy");
	storage.setItem("opencut-active-account-v1", alice);
	storage.setItem(`opencut-account:${bob}:panel-sizes`, "bob");
	let reloads = 0;
	const window = {
		fetch: async () => new Response(),
		addEventListener: () => {},
		__opencutLegacyPreferences: () => ({}),
		__opencutActivateAccount: (_: string | null) => {},
	};
	runInNewContext(
		await readFile(
			new URL("../../public/account-scope.js", import.meta.url),
			"utf8",
		),
		{
			Storage,
			localStorage: storage,
			sessionStorage: session,
			window,
			location: {
				href: "http://localhost:3000",
				origin: "http://localhost:3000",
				reload: () => reloads++,
			},
			URL,
			Request,
			Headers,
		},
	);
	expect(storage.getItem("panel-sizes")).toBeNull();
	storage.setItem("panel-sizes", "alice");
	expect(storage.getItem("panel-sizes")).toBe("alice");
	expect(storage.length).toBe(1);
	expect(storage.key(0)).toBe("panel-sizes");
	storage.clear();
	expect(storage.data.get("panel-sizes")).toBe("legacy");
	expect(storage.data.get(`opencut-account:${bob}:panel-sizes`)).toBe("bob");
	expect(window.__opencutLegacyPreferences()).toEqual({
		"panel-sizes": "legacy",
	});
	window.__opencutActivateAccount(bob);
	expect(storage.data.get("opencut-active-account-v1")).toBe(bob);
	expect(reloads).toBe(1);
});
