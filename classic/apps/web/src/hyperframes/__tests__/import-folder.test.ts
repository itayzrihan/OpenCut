/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Platform effects use explicit host doubles; canonical import behavior is tested with real Rust/WASM separately. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { PreparedHyperframesFolder } from "../folder";
import type { MediaAsset } from "@/media/types";
import type { LocalDriveRequestScope } from "@/services/local-drive/client";

let events: string[];
let mode:
	| "ok"
	| "preflight"
	| "upload"
	| "runtime"
	| "cancel"
	| "account"
	| "scene"
	| "commit"
	| "save";
let abort: AbortController;
let sceneId: string;
let closed: number;
let failCleanup = false;
let activeUploadToken = "";
let windowDescriptor: PropertyDescriptor | undefined;
const runtimeManifest = {
	sourceFingerprint: "observed",
	runtimeVersion: "0.8.115",
	durationSeconds: 4,
	layers: [],
	diagnostics: [],
};

mock.module("@/services/storage/service", () => ({
	storageService: {
		saveMediaAsset: async ({
			projectId,
			mediaAsset,
			scope,
		}: {
			projectId: string;
			mediaAsset: MediaAsset;
			scope: LocalDriveRequestScope;
		}) => {
			expect(projectId).toBe("project");
			expect(scope.accountId).toBe("account");
			expect(scope.signal).toBe(abort.signal);
			expect(scope.uploadToken).toBeString();
			activeUploadToken ||= scope.uploadToken ?? "";
			expect(scope.uploadToken).toBe(activeUploadToken);
			events.push(`upload:${mediaAsset.id}`);
			if (mode === "upload" && mediaAsset.id === "b")
				throw new Error("Upload failed");
			if (mode === "cancel") abort.abort();
			if (mode === "account") window.__opencutAccountId = "other";
			if (mode === "scene") sceneId = "other";
			mediaAsset.url = "http://example.invalid/durable";
		},
		finishMediaUpload: async ({
			projectId,
			uploadToken,
			discard,
			scope,
		}: {
			projectId: string;
			uploadToken: string;
			discard: boolean;
			scope: LocalDriveRequestScope;
		}) => {
			expect(projectId).toBe("project");
			expect(scope.accountId).toBe("account");
			expect(scope.signal).toBeUndefined();
			expect(uploadToken).toBe(activeUploadToken);
			events.push(discard ? "discard" : "finalize");
			if (failCleanup) throw new Error("Cleanup failed");
		},
	},
}));
mock.module("../render-client", () => ({
	HyperframesRenderClient: class {
		async prepareSource() {
			events.push("runtime");
			if (mode === "runtime") throw new Error("Runtime failed");
			return { durationSeconds: 4, runtimeManifest };
		}
		dispose() {
			closed++;
		}
	},
}));
const { importHyperframesFolder } = await import("../import-folder");

beforeEach(() => {
	events = [];
	mode = "ok";
	abort = new AbortController();
	sceneId = "scene";
	closed = 0;
	failCleanup = false;
	activeUploadToken = "";
	windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "account" },
	});
});
afterEach(() => {
	if (windowDescriptor)
		Object.defineProperty(globalThis, "window", windowDescriptor);
	else Reflect.deleteProperty(globalThis, "window");
});

function fixture() {
	const folder: PreparedHyperframesFolder = {
		name: "Folder",
		source: {
			entryFile: "index.html",
			files: { "index.html": "<div/>" },
			resourceAssetIds: { "a.bin": "a", "b.bin": "b" },
		},
		resources: ["a", "b"].map((id) => ({
			id,
			name: `${id}.bin`,
			type: "file" as const,
			file: new File([id], `${id}.bin`),
			storageKind: "copied" as const,
		})),
		inspection: {
			fingerprint: "fixture",
			compositionId: "main",
			width: 640,
			height: 360,
			fps: 30,
			durationSeconds: null,
			requiresRuntime: true,
			elements: [],
			dependencies: [],
			diagnostics: [],
		},
	};
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project" } }) },
		scenes: { getActiveSceneOrNull: () => ({ id: sceneId }) },
		command: {
			importHyperframes: async (input: {
				dryRun?: boolean;
				resolvedDurationSeconds: number;
				runtimeManifest?: typeof runtimeManifest;
				classicResourceAssets: Array<Record<string, unknown>>;
			}) => {
				events.push(input.dryRun ? "preflight" : "commit");
				expect(input.resolvedDurationSeconds).toBe(input.dryRun ? 1 : 4);
				expect(input.runtimeManifest).toEqual(
					input.dryRun ? undefined : runtimeManifest,
				);
				expect(
					input.classicResourceAssets.every(
						(asset) => !("file" in asset) && !("url" in asset),
					),
				).toBe(true);
				if (mode === "preflight" && input.dryRun)
					throw new Error("Invalid binding");
				if (mode === "commit" && !input.dryRun)
					throw new Error("Commit failed");
				return { assetId: "composition", itemId: "clip", trackId: "track" };
			},
		},
		save: {
			flush: async () => {
				events.push("save");
				if (mode === "save") throw new Error("Drive full");
			},
		},
	} as unknown as EditorCore;
	return { folder, editor, signal: abort.signal };
}

test("imports only after durable resources and measured runtime are ready", async () => {
	const input = fixture();
	const result = await importHyperframesFolder(input);
	expect(result.itemId).toBe("clip");
	expect(result.saveError).toBeUndefined();
	expect(events).toEqual([
		"preflight",
		"upload:a",
		"upload:b",
		"runtime",
		"commit",
		"save",
		"finalize",
	]);
	expect(input.folder.resources[0].url).toBeUndefined();
	expect(closed).toBe(1);
});

test("preflight rejects before writing any resource", async () => {
	mode = "preflight";
	await expect(importHyperframesFolder(fixture())).rejects.toThrow(
		"Invalid binding",
	);
	expect(events).toEqual(["preflight"]);
	expect(closed).toBe(1);
});

for (const failure of ["upload", "runtime", "commit"] as const)
	test(`${failure} failure removes only staged resource IDs`, async () => {
		mode = failure;
		await expect(importHyperframesFolder(fixture())).rejects.toThrow();
		expect(events.at(-1)).toBe("discard");
		expect(events).not.toContain("save");
		expect(closed).toBe(1);
	});

for (const interruption of ["cancel", "account", "scene"] as const)
	test(`${interruption} during upload cannot import into another target`, async () => {
		mode = interruption;
		await expect(importHyperframesFolder(fixture())).rejects.toThrow();
		expect(events).toEqual(["preflight", "upload:a", "discard"]);
		expect(closed).toBeGreaterThanOrEqual(1);
	});

test("save failure retains the committed clip and its resources for retry", async () => {
	mode = "save";
	const result = await importHyperframesFolder(fixture());
	expect(result.itemId).toBe("clip");
	expect(result.saveError).toBe("Drive full");
	expect(events).not.toContain("discard");
	expect(events).not.toContain("finalize");
});

test("finalization failure retains the saved import and reports a retryable error", async () => {
	failCleanup = true;
	const result = await importHyperframesFolder(fixture());
	expect(result.itemId).toBe("clip");
	expect(result.saveError).toBe("Cleanup failed");
	expect(events.slice(-2)).toEqual(["save", "finalize"]);
	expect(events).not.toContain("discard");
});

test("a cancelled upload reports incomplete cleanup instead of hiding it", async () => {
	mode = "cancel";
	failCleanup = true;
	await expect(importHyperframesFolder(fixture())).rejects.toBeInstanceOf(
		AggregateError,
	);
	expect(events).toEqual(["preflight", "upload:a", "discard"]);
	expect(closed).toBeGreaterThanOrEqual(1);
});
