/* eslint-disable opencut/prefer-object-params -- Doubles preserve canonical runtime and Web Locks API signatures. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { HyperframesImportRecovery } from "../import-recovery-types";
import type { HyperframesFolder } from "../folder";

let inspected: unknown;
let freed = 0;
mock.module("@/core/load-canonical-runtime", () => ({
	loadCanonicalRuntime: async () => ({
		invokeSync: (id: string, input: unknown) => {
			expect(id).toBe("hyperframes.project.inspect");
			inspected = input;
			return { result: { data: { fingerprint: "canonical" } } };
		},
		free: () => {
			freed++;
		},
	}),
}));
const { prepareRecoveredFolder, withImportLock } =
	await import("../import-recovery");
let originalNavigator: PropertyDescriptor | undefined;
beforeEach(() => {
	inspected = undefined;
	freed = 0;
	originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
});
afterEach(() => {
	if (originalNavigator)
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	else Reflect.deleteProperty(globalThis, "navigator");
});

function fixture() {
	const source = "\ufeff<main>preserved\r\nsource</main>";
	const recovery: HyperframesImportRecovery = {
		uploadToken: "attempt",
		createdAt: new Date(0).toISOString(),
		draft: {
			kind: "hyperframes",
			name: "Folder",
			sceneId: "scene",
			startSeconds: 2,
			source: {
				entryFile: "index.html",
				files: { "index.html": source },
				resourceAssetIds: { "assets/a.bin": "a", "assets/b.bin": "b" },
			},
			resources: ["a", "b"].map((id) => ({
				id,
				name: `assets/${id}.bin`,
				type: "file",
				size: 3,
				lastModified: 100,
				fileName: `${id}.bin`,
				mimeType: "application/octet-stream",
			})),
		},
		readyAssetIds: ["a"],
	};
	const selected = {
		name: "Folder",
		plan: {
			entryFile: "index.html",
			entryCandidates: ["index.html"],
			files: [],
			ignoredPaths: [],
			sourceBytes: source.length,
			resourceBytes: 3,
		},
		files: new Map([
			["index.html", new File([source], "index.html")],
			[
				"assets/b.bin",
				new File([new Uint8Array([0, 255, 1])], "b.bin", { lastModified: 100 }),
			],
		]),
	} as HyperframesFolder;
	return { recovery, selected };
}

test("recovery keeps original resource IDs and bytes and only reads missing files", async () => {
	const input = fixture();
	const prepared = await prepareRecoveredFolder(input);
	expect(prepared.source).toBe(input.recovery.draft.source);
	expect(prepared.resources.map((item) => item.id)).toEqual(["a", "b"]);
	expect(prepared.resources[0].file).toBeUndefined();
	expect(
		new Uint8Array(await prepared.resources[1].file!.arrayBuffer()),
	).toEqual(new Uint8Array([0, 255, 1]));
	expect(inspected).toEqual({ source: input.recovery.draft.source });
	expect(freed).toBe(1);
});

test("complete copies recover without selecting the source folder again", async () => {
	const { recovery } = fixture();
	recovery.readyAssetIds = ["a", "b"];
	const prepared = await prepareRecoveredFolder({ recovery });
	expect(prepared.resources.every((asset) => !asset.file)).toBe(true);
	expect(freed).toBe(1);
});

test("missing files require the original folder and changed source or file metadata is rejected", async () => {
	const input = fixture();
	await expect(
		prepareRecoveredFolder({ recovery: input.recovery }),
	).rejects.toThrow("original project folder");
	const changedSource = {
		...input.selected,
		files: new Map(input.selected.files),
	};
	changedSource.files.set("index.html", new File(["different"], "index.html"));
	await expect(
		prepareRecoveredFolder({ ...input, selected: changedSource }),
	).rejects.toThrow("does not match");
	const changedResource = {
		...input.selected,
		files: new Map(input.selected.files),
	};
	changedResource.files.set(
		"assets/b.bin",
		new File(["123"], "b.bin", { lastModified: 101 }),
	);
	await expect(
		prepareRecoveredFolder({ ...input, selected: changedResource }),
	).rejects.toThrow("original file changed");
	expect(inspected).toBeUndefined();
});

test("cancelled recovery stops before reading files or inspecting source", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		prepareRecoveredFolder({ ...fixture(), signal: controller.signal }),
	).rejects.toThrow();
	expect(inspected).toBeUndefined();
});

test("only one tab can run the same attempt while unrelated attempts remain available", async () => {
	const held = new Set<string>();
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: async (
					name: string,
					_options: unknown,
					run: (lock: object | null) => Promise<unknown>,
				) => {
					if (held.has(name)) return run(null);
					held.add(name);
					try {
						return await run({});
					} finally {
						held.delete(name);
					}
				},
			},
		},
	});
	const scope = {
		accountId: "account",
		projectId: "project",
		uploadToken: "attempt",
		resuming: true,
	};
	await withImportLock({
		...scope,
		run: async () => {
			await expect(
				withImportLock({ ...scope, run: async () => "duplicate" }),
			).rejects.toThrow("another tab");
			expect(
				await withImportLock({
					...scope,
					uploadToken: "different",
					run: async () => "independent",
				}),
			).toBe("independent");
		},
	});
	expect(await withImportLock({ ...scope, run: async () => "released" })).toBe(
		"released",
	);
});

test("recovery requires cross-tab locking, while a fresh import works on older browsers", async () => {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {},
	});
	const scope = {
		accountId: "account",
		projectId: "project",
		uploadToken: "attempt",
		run: async () => "fresh",
	};
	await expect(withImportLock({ ...scope, resuming: true })).rejects.toThrow(
		"cannot safely resume",
	);
	expect(await withImportLock({ ...scope, resuming: false })).toBe("fresh");
});
