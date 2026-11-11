/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- A minimal browser and authenticated synthetic response isolate the real output cache. */
import { afterEach, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { LocalDriveRequestScope } from "@/services/local-drive/client";
import type { AudioJob } from "./types";

const records = new Map<string, MediaAsset>();
function key({
	projectId,
	id,
	scope,
}: {
	projectId: string;
	id: string;
	scope: LocalDriveRequestScope;
}) {
	return JSON.stringify([scope.accountId, projectId, id]);
}
mock.module("@/services/storage/service", () => ({
	storageService: {
		loadBrowserMediaAsset: async (input: Parameters<typeof key>[0]) =>
			records.get(key(input)) ?? null,
		saveBrowserMediaAsset: async ({
			projectId,
			mediaAsset,
			scope,
		}: {
			projectId: string;
			mediaAsset: MediaAsset;
			scope: LocalDriveRequestScope;
		}) => {
			const stored = {
				...mediaAsset,
				storageKind: "copied" as const,
				missing: false,
				url: "blob:local-audio",
			};
			records.set(key({ projectId, id: mediaAsset.id, scope }), stored);
			return {
				hasLocalCopy: true,
				storageKind: stored.storageKind,
				missing: false,
				url: stored.url,
			};
		},
	},
}));
const { saveAudioResult } = await import("./result-media");
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWindow) globalThis.window = originalWindow;
	else Reflect.deleteProperty(globalThis, "window");
	records.clear();
});

test("a completed ElevenLabs output is cached once and reused in the same browser after reload", async () => {
	const bytes = "synthetic elevenlabs bytes";
	const open = () =>
		({
			__opencutAccountId: "account-a",
			__opencutHostedLegitate: true,
		}) as Window & typeof globalThis;
	globalThis.window = open();
	const request = mock(async () => new Response(bytes));
	globalThis.fetch = request as unknown as typeof fetch;
	const job: AudioJob = {
		id: "audio-job",
		projectId: "project-a",
		digest: "digest",
		status: "ready",
		createdAt: 42,
		draft: {
			id: "draft",
			version: 1,
			title: "Narration",
			kind: "speech",
			modelId: "fixture",
			text: "Example",
			voiceId: "voice",
			instrumental: false,
			dialogue: [],
		},
		output: {
			id: "output",
			kind: "audio",
			name: "Narration.mp3",
			mime: "audio/mpeg",
			bytes: bytes.length,
			storyboard: false,
		},
	};
	const input = {
		projectId: job.projectId,
		job,
		scope: { accountId: "account-a" },
		signal: new AbortController().signal,
	};
	const [first, second] = await Promise.all([
		saveAudioResult(input),
		saveAudioResult(input),
	]);
	expect(first.id).toBe("elevenlabs-audio-job");
	expect(second.url).toBe("blob:local-audio");
	expect(request).toHaveBeenCalledTimes(1);
	globalThis.window = open();
	const restored = await saveAudioResult(input);
	expect(await restored.file?.text()).toBe(bytes);
	expect(restored.storageKind).toBe("copied");
	expect(request).toHaveBeenCalledTimes(1);
	await expect(
		saveAudioResult({ ...input, projectId: "other-project" }),
	).rejects.toThrow();
	window.__opencutAccountId = "other-account";
	await expect(saveAudioResult(input)).rejects.toThrow();
	expect(request).toHaveBeenCalledTimes(1);
});
