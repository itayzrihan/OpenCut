import { afterAll, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import type { NextRequest } from "next/server";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

const root = resolve("../../../.local/subscription-image-tests");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(join(root, "run-"));
const account = new AsyncLocalStorage<string>();
const media = new Map<string, { path: string; size: number }>();
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
mock.module("@/services/local-drive/server", () => ({
	listProjectMetadata: async () =>
		account.getStore() === "alice" ? [{ id: "project" }, { id: "other" }] : [],
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

const jobs = join(evidence, "alice", "image-jobs");
await mkdir(jobs, { recursive: true });

test("retirement preserves completed PNG recovery and account boundaries", async () => {
	const initial = glue.subscriptionImagePlan(
		input("completed"),
		null,
		null,
		Date.now(),
	);
	const result = {
		mediaId: initial.mediaId,
		fileName: initial.fileName,
		width: 2,
		height: 2,
		byteSize: png.length,
		lastModified: Date.now(),
		sha256: createHash("sha256").update(png).digest("hex"),
	};
	const completed = glue.subscriptionImagePlan(
		input("completed"),
		initial.journal,
		result,
		Date.now(),
	);
	await writeFile(
		join(jobs, `${initial.jobKey}.json`),
		JSON.stringify(completed.journal),
	);
	const path = join(evidence, "prior-image.png");
	await writeFile(path, png);
	media.set(JSON.stringify(["alice", "project", result.mediaId]), {
		path,
		size: png.length,
	});
	expect(
		await generate({
			operationId: "completed",
			overrides: { expectedRevision: 200 },
		}),
	).toEqual({ ...result, projectId: "project", jobKey: initial.jobKey });
	expect(
		await account.run("alice", () =>
			readSubscriptionImage({ projectId: "project", jobKey: initial.jobKey }),
		),
	).toEqual(png);
	await expect(
		generate({
			operationId: "completed",
			overrides: { prompt: "Changed" },
		}),
	).rejects.toThrow("different image content");
	await expect(
		account.run("bob", () =>
			readSubscriptionImage({ projectId: "project", jobKey: initial.jobKey }),
		),
	).rejects.toThrow("does not own");
	await expect(
		account.run("alice", () =>
			readSubscriptionImage({ projectId: "other", jobKey: initial.jobKey }),
		),
	).rejects.toThrow();
});

test("no new image is dispatched and an uncertain job stays uncertain", async () => {
	const initial = glue.subscriptionImagePlan(
		input("lost-reply"),
		null,
		null,
		Date.now(),
	);
	await writeFile(
		join(jobs, `${initial.jobKey}.json`),
		JSON.stringify(initial.journal),
	);
	const before = await readdir(jobs);
	await expect(generate({ operationId: "lost-reply" })).rejects.toThrow(
		"already dispatched",
	);
	await expect(generate({ operationId: "new" })).rejects.toThrow(
		"Image generation is unavailable",
	);
	expect(await readdir(jobs)).toEqual(before);
});
