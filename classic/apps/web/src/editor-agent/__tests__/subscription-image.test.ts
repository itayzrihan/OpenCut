import { afterAll, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import type { NextRequest } from "next/server";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

const root = resolve("../../../.local/subscription-image-tests");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(join(root, "run-"));
const account = new AsyncLocalStorage<string>();
const media = new Map<string, { path: string; size: number }>();
let connected = true;
let calls = 0;
let failProvider = false;
const png = await sharp({
	create: {
		width: 2,
		height: 2,
		channels: 4,
		background: { r: 20, g: 100, b: 200, alpha: 0.5 },
	},
})
	.png()
	.toBuffer();
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: account.getStore() ?? "anonymous" }),
	accountDataRoot: () => join(evidence, account.getStore() ?? "anonymous"),
}));
mock.module("@/editor-agent/server/project-write", () => ({
	withEditorProjectWrite: async ({
		write,
	}: {
		write: (context: { assertWrite: () => void }) => Promise<unknown>;
	}) => write({ assertWrite: () => {} }),
}));
mock.module("@/ai/server/openai-codex-oauth", () => ({
	getOpenAIOAuthStatus: async () => ({
		status: { authenticated: connected },
		credentials: connected ? { access: "test-only" } : undefined,
	}),
	forwardCodexResponsesRequest: async ({
		body,
		allowModelFallback,
	}: {
		body: Record<string, unknown>;
		allowModelFallback: boolean;
	}) => {
		calls++;
		expect(allowModelFallback).toBe(false);
		expect(body.tools).toEqual([
			{
				type: "image_generation",
				output_format: "png",
				background: "transparent",
			},
		]);
		expect(body.tool_choice).toEqual({ type: "image_generation" });
		if (failProvider) throw new Error("Provider reply lost after dispatch");
		return {
			output: [
				{
					type: "image_generation_call",
					status: "completed",
					result: png.toString("base64"),
				},
			],
		};
	},
}));
mock.module("@/services/local-drive/server", () => ({
	listProjectMetadata: async () =>
		account.getStore() === "alice" ? [{ id: "project" }, { id: "other" }] : [],
	storeUploadedMedia: async ({
		projectId,
		mediaId,
		body,
	}: {
		projectId: string;
		mediaId: string;
		body: ReadableStream<Uint8Array>;
	}) => {
		const { writeFile } = await import("node:fs/promises");
		const path = join(
			evidence,
			`${account.getStore()}-${projectId}-${mediaId}.png`,
		);
		const bytes = await new Response(body).arrayBuffer();
		await writeFile(path, new Uint8Array(bytes));
		media.set(JSON.stringify([account.getStore(), projectId, mediaId]), {
			path,
			size: bytes.byteLength,
		});
	},
	getMediaFile: async (...[projectId, mediaId]: [string, string]) => {
		const file = media.get(
			JSON.stringify([account.getStore(), projectId, mediaId]),
		);
		return file ? { path: file.path, stat: { size: file.size } } : null;
	},
}));
const runtime = await createCanonicalTestRuntime();
const glue =
	await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
mock.module("opencut-editor-runtime-wasm", () => ({
	subscriptionImagePlan: glue.subscriptionImagePlan,
}));
const { generateSubscriptionImage, readSubscriptionImage } =
	await import("../server/subscription-image");
afterAll(() => runtime.free());
const input = (operationId: string) => ({
	projectId: "project",
	expectedRevision: 1,
	operationId,
	title: "Image",
	prompt: "Blue shape",
	transparentBackground: true,
	referenceArtifactIds: [],
});
const generate = ({
	operationId,
	overrides = {},
}: {
	operationId: string;
	overrides?: Record<string, unknown>;
}) =>
	account.run("alice", () =>
		generateSubscriptionImage({
			// Only standard Request fields are exercised by this authenticated host fixture.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			request: new Request("http://localhost") as NextRequest,
			projectId: "project",
			input: { ...input(operationId), ...overrides },
		}),
	);

test("completed PNG is decoded, stored, recovered after a revision change and scoped to its owner", async () => {
	const before = calls;
	const result = await generate({ operationId: "completed" });
	expect(calls).toBe(before + 1);
	expect(result.width).toBe(2);
	expect(result.height).toBe(2);
	const saved = await account.run("alice", () =>
		readSubscriptionImage({ projectId: "project", jobKey: result.jobKey }),
	);
	expect(saved.equals(png)).toBe(true);
	expect(
		await generate({
			operationId: "completed",
			overrides: { expectedRevision: 200 },
		}),
	).toEqual(result);
	expect(calls).toBe(before + 1);
	await expect(
		generate({ operationId: "completed", overrides: { prompt: "Changed" } }),
	).rejects.toThrow("different image content");
	await expect(
		account.run("bob", () =>
			readSubscriptionImage({ projectId: "project", jobKey: result.jobKey }),
		),
	).rejects.toThrow("does not own");
	await expect(
		account.run("alice", () =>
			readSubscriptionImage({ projectId: "other", jobKey: result.jobKey }),
		),
	).rejects.toThrow();
	const journal = await readFile(
		join(evidence, "alice", "image-jobs", `${result.jobKey}.json`),
		"utf8",
	);
	expect(journal).not.toContain("Blue shape");
	expect(journal).not.toContain("test-only");
});
test("an uncertain provider reply never dispatches again, including a concurrent recovery", async () => {
	const before = calls;
	failProvider = true;
	await expect(generate({ operationId: "lost-reply" })).rejects.toThrow(
		"reply lost",
	);
	failProvider = false;
	await expect(generate({ operationId: "lost-reply" })).rejects.toThrow(
		"already dispatched",
	);
	expect(calls).toBe(before + 1);
	const race = await Promise.allSettled([
		generate({ operationId: "race" }),
		generate({ operationId: "race" }),
	]);
	expect(race.some((value) => value.status === "fulfilled")).toBe(true);
	expect(calls).toBe(before + 2);
});
test("missing subscription is explicit and does not claim or charge an image operation", async () => {
	connected = false;
	const before = calls;
	await expect(generate({ operationId: "not-connected" })).rejects.toThrow(
		"No paid API fallback",
	);
	expect(calls).toBe(before);
	connected = true;
	expect((await generate({ operationId: "not-connected" })).width).toBe(2);
	expect(calls).toBe(before + 1);
});
