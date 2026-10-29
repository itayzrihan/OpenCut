/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal host IO fixtures. */
import { afterEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
let synthesize: () => Promise<AudioBuffer>;
const resolve = mock(async () => synthesize());
mock.module("@/earshot/audio", () => ({ resolveEarshotBuffer: resolve }));
const { performEarshotPreviewEffect } =
	await import("../earshot-preview-effect");
const originalWindow = globalThis.window;
const originalContext = globalThis.OfflineAudioContext;
afterEach(() => {
	globalThis.window = originalWindow;
	globalThis.OfflineAudioContext = originalContext;
	resolve.mockClear();
});
function fixture() {
	globalThis.window = { __opencutAccountId: "alice" } as unknown as Window &
		typeof globalThis;
	globalThis.OfflineAudioContext =
		class {} as unknown as typeof OfflineAudioContext;
	let revision = 7;
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project" } }) },
		command: { getCanonicalRevision: () => revision },
	} as unknown as EditorCore;
	const buffer = {
		sampleRate: 48000,
		length: 4800,
		numberOfChannels: 2,
		getChannelData: (channel: number) =>
			Float32Array.from({ length: 4800 }, (_, i) =>
				i < 960 ? 0 : channel ? -0.25 : 0.5,
			),
	} as AudioBuffer;
	synthesize = async () => buffer;
	return {
		editor,
		buffer,
		change: () => revision++,
		effect: {
			id: 1,
			projectId: "project",
			adapter: "earshotPreview",
			request: {
				projectId: "project",
				expectedRevision: 7,
				startFrame: 960,
				frames: 960,
				procedural: {
					version: 1,
					engine: "earshot",
					bankRevision: "591fa3e028032e6dce56620a20e932e35667e8d8",
					presetId: "whoosh_fast/whip",
					seed: 42,
					duration: 0.1,
				},
			},
		},
	};
}
test("shared synthesizer yields exact offset stereo PCM for canonical artifact creation", async () => {
	const { editor, effect } = fixture();
	const signal = new AbortController().signal;
	const result = await performEarshotPreviewEffect({
		editor,
		effect,
		accountId: "alice",
		signal,
	});
	expect(result.type).toBe("success");
	if (result.type !== "success") throw new Error(result.message);
	const data = result.data as { channels: number; pcm16Base64: string };
	const bytes = Buffer.from(data.pcm16Base64, "base64");
	expect(data.channels).toBe(2);
	expect(bytes.length).toBe(960 * 2 * 2);
	expect(bytes.readInt16LE(0)).toBe(16384);
	expect(bytes.readInt16LE(2)).toBe(-8192);
	expect(resolve).toHaveBeenCalledWith(
		expect.objectContaining({ signal, spec: effect.request.procedural }),
	);
});
test("revision, account, cancellation and invalid windows prevent synthesis or output", async () => {
	for (const mode of [
		"revision",
		"account",
		"cancel",
		"window",
		"during",
	] as const) {
		const { editor, effect, change, buffer } = fixture();
		const controller = new AbortController();
		if (mode === "revision") change();
		if (mode === "account") window.__opencutAccountId = "bob";
		if (mode === "cancel") controller.abort();
		if (mode === "window") effect.request.frames = 6000;
		if (mode === "during")
			synthesize = async () => {
				change();
				return buffer;
			};
		const result = await performEarshotPreviewEffect({
			editor,
			effect,
			accountId: "alice",
			signal: controller.signal,
		});
		expect(result.type).toBe("rejected");
		expect(resolve).toHaveBeenCalledTimes(mode === "during" ? 1 : 0);
		resolve.mockClear();
	}
});
test("non-finite samples reject preflight", async () => {
	const { editor, effect, buffer } = fixture();
	synthesize = async () =>
		({
			...buffer,
			getChannelData: () => new Float32Array(4800).fill(Number.NaN),
		}) as AudioBuffer;
	expect(
		(
			await performEarshotPreviewEffect({
				editor,
				effect,
				accountId: "alice",
				signal: new AbortController().signal,
			})
		).type,
	).toBe("rejected");
});
