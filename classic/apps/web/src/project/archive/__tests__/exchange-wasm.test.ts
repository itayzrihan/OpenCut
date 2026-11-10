// @opencut-test-wasm: real
import { afterAll, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { EditorSessionBundle } from "@/editor-agent/session-client";
import type { MediaAsset } from "@/media/types";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";
import { assetKey, parseProjectXml } from "../exchange-format";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const accountId = "exchange-qa-account";
globalThis.window = { __opencutAccountId: accountId } as unknown as Window &
	typeof globalThis;
const projectWrites = new Map<string, unknown>();
const mediaWrites = new Map<string, MediaAsset>();
const records = new Map<string, string>();
let writes = 0;
let failNextAcquire = false;
let cancelAfterAcquire: AbortController | null = null;
mock.module("@/core/load-canonical-runtime", () => ({
	loadCanonicalRuntime: createCanonicalTestRuntime,
}));
mock.module("@/accounts/browser", () => ({
	isHostedBrowserWorkspace: () => false,
	accountAssetUrl: (url: string) => url,
}));
mock.module("@/batch/write-token", () => ({ batchWriteHeaders: () => ({}) }));
mock.module("@/services/storage/hosted-media", () => ({
	hostedMedia: () => ({ clear: async () => {} }),
}));
mock.module("@/services/storage/service", () => ({
	storageService: {
		canStoreFile: async () => ({ canStore: true }),
		loadMediaAsset: async ({ id }: { id: string }) => mediaWrites.get(id),
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			writes++;
			mediaWrites.set(mediaAsset.id, mediaAsset);
		},
		saveProjectFont: async () => {
			throw new Error("Unexpected font write");
		},
	},
}));
mock.module("@/services/local-drive/client", () => ({
	captureLocalDriveWriteScope: () => ({ accountId, writeHeaders: {} }),
	assertLocalDriveWriteScope: () => {
		if (window.__opencutAccountId !== accountId)
			throw new Error("Account changed");
	},
	localDriveRequest: async ({
		operation,
		payload,
	}: {
		operation: string;
		payload: Record<string, unknown>;
	}) => {
		if (operation === "project.get")
			return projectWrites.get(String(payload.projectId)) ?? null;
		writes++;
		if (operation === "project.put")
			projectWrites.set(String(payload.projectId), payload.project);
		else if (operation === "project.delete")
			projectWrites.delete(String(payload.projectId));
		return { ok: true };
	},
}));
mock.module("@/generative/client", () => ({
	fileUrl: () => {
		throw new Error("Unexpected Director asset");
	},
}));
mock.module("@/generative/archive-reference-client", () => ({
	uploadArchiveReference: async () => {
		throw new Error("Unexpected Director upload");
	},
}));
mock.module("../shared-assets", () => ({
	collectSharedExchangeAssets: async () => [],
	importSharedExchangeAsset: async () => {
		throw new Error("Unexpected shared import");
	},
}));
const {
	createProjectExchange,
	readProjectExchange,
	importProjectExchange,
	validateExchangeBundle,
} = await import("../exchange");

const initialize = await createCanonicalTestRuntime();
initialize.free();
const glue =
	await import("../../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
globalThis.fetch = async (input, init) => {
	if (String(input) !== "/api/editor-session")
		throw new Error(`Unexpected request ${String(input)}`);
	const { projectId, request } = JSON.parse(String(init?.body));
	if (request.type === "acquire" && failNextAcquire) {
		failNextAcquire = false;
		return Response.json(
			{ error: "acquire denied", definitive: true },
			{ status: 409 },
		);
	}
	const transition = glue.sessionStoreTransition(
		records.get(projectId) ?? "",
		accountId,
		projectId,
		request,
		Date.now(),
	) as { record: string; result: Record<string, unknown> };
	records.set(projectId, transition.record);
	if (request.type === "acquire" && cancelAfterAcquire) {
		cancelAfterAcquire.abort(new Error("cancelled before commit"));
		cancelAfterAcquire = null;
	}
	return Response.json({
		...transition.result,
		legacyProject: projectWrites.get(projectId) ?? null,
		legacyHistory: null,
	});
};
afterAll(() => {
	globalThis.fetch = originalFetch;
	globalThis.window = originalWindow;
});

async function fixture() {
	const runtime = await createCanonicalTestRuntime();
	const classic = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	classic.document.customFonts = [];
	const file = new File(["ORIGINAL_MEDIA_BYTES_NOT_XML"], "original.mov", {
		type: "video/quicktime",
		lastModified: 42,
	});
	classic.mediaAssets[0] = {
		...classic.mediaAssets[0],
		fileName: file.name,
		size: file.size,
		mimeType: file.type,
		lastModified: file.lastModified,
	};
	const projectId = classic.document.metadata.id;
	runtime.invokeSync(
		"project.classic.session.attach",
		{ projectId, expectedRevision: 0, classic },
		{},
	);
	runtime.invokeSync(
		"project.production.edit",
		{
			projectId,
			expectedRevision: 1,
			change: {
				type: "importScript",
				rowIdPrefix: "dialogue",
				text: "שלום לעולם",
				sourceLanguage: "he",
				defaultDurationMs: 4000,
			},
		},
		{},
	);
	runtime.invokeSync(
		"project.production.edit",
		{
			projectId,
			expectedRevision: 2,
			change: {
				type: "createReferenceSlot",
				slotId: "future",
				label: "History preserved",
			},
		},
		{},
	);
	runtime.invokeSync("history.undo", {}, {});
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const artifact = runtime.storeArtifact(
		bytes,
		"application/octet-stream",
		undefined,
		undefined,
		undefined,
	) as { id: string };
	runtime.conversationApply(accountId, projectId, {
		type: "user",
		text: "Keep the original Hebrew source",
	});
	runtime.conversationApply(accountId, projectId, {
		type: "round",
		review: false,
	});
	runtime.conversationApply(accountId, projectId, {
		type: "artifacts",
		artifactIds: [artifact.id],
	});
	const bundle: EditorSessionBundle = {
		archive: new CanonicalClassicSession({ runtime, projectId }).archive(),
		agentCheckpoint: null,
		conversation: runtime.conversationRead(
			accountId,
			projectId,
		) as EditorSessionBundle["conversation"],
		artifacts: runtime.conversationArtifacts(
			accountId,
			projectId,
		) as EditorSessionBundle["artifacts"],
	};
	return {
		runtime,
		file,
		bundle,
		mediaAsset: { ...classic.mediaAssets[0], file } as MediaAsset,
		artifact,
		bytes,
	};
}

test("metadata XML omits media, requires originals, then atomically reopens canonical history, script and paused conversation artifacts", async () => {
	const f = await fixture();
	const reopened = await createCanonicalTestRuntime();
	try {
		const sourceBefore = f.runtime.invokeSync("app.state.read", {}, {}).result
			.data.value;
		const xml = await createProjectExchange({
			bundle: f.bundle,
			mediaAssets: [f.mediaAsset],
			projectFonts: [],
			format: "xml",
		});
		const text = await xml.text();
		expect(text).not.toContain("ORIGINAL_MEDIA_BYTES_NOT_XML");
		expect(text).not.toContain("AQIDBA==");
		expect(text).not.toContain("dataBase64");
		expect(parseProjectXml(text).assets).toHaveLength(2);
		const plan = await readProjectExchange(
			new File([xml], "proposal.pocut.xml", { type: "application/xml" }),
		);
		expect(plan).not.toBeNull();
		const beforeWrites = writes;
		await expect(
			importProjectExchange({ plan: plan!, selections: new Map() }),
		).rejects.toThrow("Select the original");
		expect(writes).toBe(beforeWrites);
		const files = new Map(
			plan!.payload.assets.map((asset) => [
				assetKey(asset),
				asset.kind === "media"
					? f.file
					: new File([f.bytes], asset.fileName, { type: asset.mimeType }),
			]),
		);
		const result = await importProjectExchange({
			plan: plan!,
			selections: files,
		});
		expect(result.projectId).not.toBe(f.bundle.archive.projectId);
		const saved = JSON.parse(records.get(result.projectId)!).saved;
		expect(saved.bundle.agentCheckpoint).toBeNull();
		expect(saved.bundle.conversation.projectId).toBe(result.projectId);
		expect(saved.bundle.conversation.accountId).toBe(accountId);
		expect(saved.bundle.conversation.activeRound).toBeNull();
		expect(saved.bundle.conversation.entries[0].text).toBe(
			"Keep the original Hebrew source",
		);
		const session = new CanonicalClassicSession({
			runtime: reopened,
			projectId: result.projectId,
		});
		session.restore(saved.bundle.archive);
		reopened.restoreConversationArtifacts(
			accountId,
			result.projectId,
			saved.bundle.artifacts,
		);
		reopened.conversationRestore(
			accountId,
			result.projectId,
			saved.bundle.conversation,
		);
		expect(Array.from(reopened.readArtifact(f.artifact.id))).toEqual([
			1, 2, 3, 4,
		]);
		expect(
			reopened.invokeSync(
				"app.state.read",
				{
					pointer:
						"/project/extensions/productionStudio/scriptRows/0/versions/0/sourceText",
				},
				{},
			).result.data.value,
		).toBe("שלום לעולם");
		session.redo();
		expect(
			reopened.invokeSync(
				"app.state.read",
				{
					pointer:
						"/project/extensions/productionStudio/referenceSlots/0/label",
				},
				{},
			).result.data.value,
		).toBe("History preserved");
		session.undo();
		session.undo();
		expect(
			reopened.invokeSync("app.state.read", { pointer: "/project/id" }, {})
				.result.data.value,
		).toBe(result.projectId);
		expect(
			f.runtime.invokeSync("app.state.read", {}, {}).result.data.value,
		).toEqual(sourceBefore);
		expect(await mediaWrites.get(f.mediaAsset.id)?.file?.text()).toBe(
			"ORIGINAL_MEDIA_BYTES_NOT_XML",
		);
	} finally {
		f.runtime.free();
		reopened.free();
	}
});

test("full ZIP carries linked source and artifact bytes; malformed metadata cannot publish files", async () => {
	const f = await fixture();
	try {
		const zip = await createProjectExchange({
			bundle: f.bundle,
			mediaAssets: [{ ...f.mediaAsset, storageKind: "linked" }],
			projectFonts: [],
			format: "zip",
		});
		const plan = await readProjectExchange(
			new File([zip], "complete.opencut.zip", { type: "application/zip" }),
		);
		expect(plan?.files.size).toBe(2);
		expect(await plan?.files.get(`media:${f.mediaAsset.id}`)?.text()).toBe(
			"ORIGINAL_MEDIA_BYTES_NOT_XML",
		);
		const before = writes;
		const corrupted = structuredClone(plan!.payload);
		corrupted.assets.find(
			(asset) => asset.kind === "artifact",
		)!.metadata.sha256 = "0".repeat(64);
		const { serializeProjectXml } = await import("../exchange-format");
		await expect(
			readProjectExchange(
				new File([serializeProjectXml(corrupted)], "bad.pocut.xml"),
			),
		).rejects.toThrow("Artifact metadata");
		expect(writes).toBe(before);
	} finally {
		f.runtime.free();
	}
});

test("definite acquire failure and cancellation before commit remove only the newly imported project", async () => {
	const f = await fixture();
	try {
		const xml = await createProjectExchange({
			bundle: f.bundle,
			mediaAssets: [f.mediaAsset],
			projectFonts: [],
			format: "xml",
		});
		const plan = (await readProjectExchange(
			new File([xml], "project.pocut.xml"),
		))!;
		const selections = new Map(
			plan.payload.assets.map((asset) => [
				assetKey(asset),
				asset.kind === "media"
					? f.file
					: new File([f.bytes], asset.fileName, { type: asset.mimeType }),
			]),
		);
		const existing = [...projectWrites.keys()].sort();
		failNextAcquire = true;
		await expect(importProjectExchange({ plan, selections })).rejects.toThrow(
			"acquire denied",
		);
		expect([...projectWrites.keys()].sort()).toEqual(existing);
		const abort = new AbortController();
		cancelAfterAcquire = abort;
		await expect(
			importProjectExchange({ plan, selections, signal: abort.signal }),
		).rejects.toThrow("cancelled before commit");
		expect([...projectWrites.keys()].sort()).toEqual(existing);
		expect(
			[...records.values()].filter((record) => JSON.parse(record).saved).length,
		).toBe(existing.length);
	} finally {
		f.runtime.free();
		failNextAcquire = false;
		cancelAfterAcquire = null;
	}
});

test("aggregate artifact budget rejects before reading binary files or creating storage", async () => {
	const f = await fixture();
	try {
		const xml = await createProjectExchange({
			bundle: f.bundle,
			mediaAssets: [f.mediaAsset],
			projectFonts: [],
			format: "xml",
		});
		const plan = (await readProjectExchange(
			new File([xml], "budget.pocut.xml"),
		))!;
		const template = plan.payload.assets.find(
			(asset) => asset.kind === "artifact",
		)!;
		plan.payload.assets = [0, 1].map((index) => ({
			...template,
			id: `large-${index}`,
			size: 64 * 1024 * 1024,
			metadata: {
				...template.metadata,
				id: `large-${index}`,
				byteSize: 64 * 1024 * 1024,
			},
		}));
		let reads = 0;
		const files = new Map(
			plan.payload.assets.map((asset) => {
				const file = new File([], asset.fileName, { type: asset.mimeType });
				Object.defineProperty(file, "size", { value: asset.size });
				file.arrayBuffer = async () => {
					reads++;
					throw new Error("Binary was read before aggregate budget validation");
				};
				return [assetKey(asset), file] as const;
			}),
		);
		const prepared = f.runtime.invokeSync(
			"project.classic.exchange.prepare",
			{ projectId: f.bundle.archive.projectId, archive: f.bundle.archive },
			{},
		).result.data as Parameters<typeof validateExchangeBundle>[0]["prepared"];
		const before = writes;
		await expect(
			validateExchangeBundle({ plan, prepared, files, accountId }),
		).rejects.toThrow("session storage limit");
		expect(reads).toBe(0);
		expect(writes).toBe(before);
	} finally {
		f.runtime.free();
	}
});
