/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal host doubles isolate the real import adapter; canonical registry is exercised separately against real WASM. */
import { test, expect, afterEach, mock } from "bun:test";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { DirectorDocument, DirectorJob } from "./types";
mock.module("@/services/storage/service", () => ({
	storageService: { loadBrowserMediaAsset: async () => null },
}));
const { importDirectorResult } = await import("./result-import");
const savedFetch = globalThis.fetch,
	savedWindow = globalThis.window;
afterEach(() => {
	globalThis.fetch = savedFetch;
	if (savedWindow) globalThis.window = savedWindow;
	else Reflect.deleteProperty(globalThis, "window");
});
test("ready result becomes a normal asset once, preserves source bytes and never auto-inserts timeline", async () => {
	globalThis.window = { __opencutAccountId: "account-a" } as Window &
		typeof globalThis;
	const document: DirectorDocument = {
			messages: [],
			references: [],
			direction: "",
			transcript: "",
			jobs: [],
		},
		media: MediaAsset[] = [];
	let timelineCalls = 0;
	const editor = {
		command: {
			readGenerative: () => ({ document, instructions: "" }),
			invokeCanonicalControl: ({
				input,
			}: {
				input: {
					change: {
						type: string;
						job?: DirectorDocument["jobs"][number];
						reference?: DirectorDocument["references"][number];
					};
				};
			}) => {
				if (input.change.job) {
					const old = document.jobs.findIndex(
						(j) => j.id === input.change.job!.id,
					);
					if (old < 0) document.jobs.push(input.change.job);
					else document.jobs[old] = input.change.job;
				}
				if (input.change.reference)
					document.references.push(input.change.reference);
			},
		},
		project: { getActiveOrNull: () => ({ metadata: { id: "project-a" } }) },
		media: {
			getAssets: () => media,
			addGeneratedMediaAsset: async ({ asset }: { asset: MediaAsset }) => {
				media.push(asset);
				return asset;
			},
			reopenBrowserSource: async ({ id, file }: { id: string; file: File }) => {
				const asset = media.find((item) => item.id === id);
				if (!asset) throw new Error("Missing canonical asset");
				Object.assign(asset, { file, missing: false });
			},
		},
		timeline: {
			insertElement: () => {
				timelineCalls++;
			},
		},
	} as unknown as EditorCore;
	const bytes = "original-generated-video";
	let downloads = 0;
	globalThis.fetch = (async () => {
		downloads++;
		return new Response(bytes);
	}) as typeof fetch;
	const job: DirectorJob = {
		id: "a".repeat(32),
		projectId: "project-a",
		kind: "video",
		status: "ready",
		digest: "b".repeat(64),
		prompt: "direction",
		model: "test",
		references: [],
		createdAt: Date.now(),
		message: "ready",
		output: {
			id: "c".repeat(32),
			name: "scene.mp4",
			kind: "video",
			mime: "video/mp4",
			bytes: bytes.length,
			storyboard: false,
		},
	};
	let processed = "";
	const input = {
		editor,
		projectId: "project-a",
		accountId: "account-a",
		job,
		signal: new AbortController().signal,
		current: () => true,
		process: async ({ files }: { files: File[] }) => {
			processed = await files[0].text();
			return [
				{
					type: "video" as const,
					name: files[0].name,
					file: files[0],
					duration: 8,
				},
			];
		},
	};
	await importDirectorResult(input);
	await importDirectorResult(input);
	expect(media).toHaveLength(1);
	expect(processed).toBe(bytes);
	expect(timelineCalls).toBe(0);
	expect(document.jobs[0].mediaId).toBe("generative-" + job.id);
	expect(downloads).toBe(1);
	window.__opencutHostedLegitate = true;
	media[0].file = undefined;
	media[0].missing = true;
	media[0].name = "Edited name";
	await importDirectorResult(input);
	expect(media).toHaveLength(1);
	expect(await media[0].file?.text()).toBe(bytes);
	expect(media[0].name).toBe("Edited name");
	expect(downloads).toBe(2);
	media.splice(0);
	await importDirectorResult(input);
	expect(media).toHaveLength(0);
	expect(downloads).toBe(2);
});
test("stale project cannot import a ready result", async () => {
	let touched = false;
	await importDirectorResult({
		editor: {} as EditorCore,
		projectId: "stale",
		accountId: "account",
		job: {} as DirectorJob,
		signal: new AbortController().signal,
		current: () => false,
		process: async () => {
			touched = true;
			return [];
		},
	});
	expect(touched).toBe(false);
});
