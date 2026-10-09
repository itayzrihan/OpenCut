/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Deliberately minimal IO fixtures. */
import { afterEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
let disposed = 0;
mock.module("../video-inspection", () => ({
	inspectEncodedVideo: async () => ({
		durationSeconds: 4.8,
		width: 1920,
		height: 1080,
		frameRate: 10,
		packetCount: 48,
		videoTracks: 1,
		audioTracks: 0,
		codec: "vp9",
	}),
}));
mock.module("@/hyperframes/render-client", () => ({
	HyperframesRenderClient: class {
		async prepareSource() {
			return { runtimeManifest: { sourceFingerprint: "measured" } };
		}
		dispose() {
			disposed++;
		}
	},
}));
const { performRenderEffect } = await import("../render-effects");
const originalWindow = globalThis.window;
afterEach(() => {
	globalThis.window = originalWindow;
});
function fixture() {
	globalThis.window = { __opencutAccountId: "alice" } as unknown as Window &
		typeof globalThis;
	let project = "project";
	const store = mock(() => ({
		id: "artifact",
		uri: "opencut://artifacts/artifact",
	}));
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: project } }) },
		scenes: { getActiveSceneOrNull: () => ({ id: "scene" }) },
		command: {
			getEditingAgentSnapshot: () => ({ revision: 7 }),
			storeEditingAgentRender: store,
		},
		renderer: {
			exportProject: mock(async () => ({
				success: true,
				buffer: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer,
			})),
		},
	} as unknown as EditorCore;
	return {
		editor,
		store,
		change: () => {
			project = "other";
		},
	};
}
test("export uses the real editor adapter options and stores a bounded artifact", async () => {
	const { editor, store } = fixture();
	const onExport = mock();
	const result = await performRenderEffect({
		editor,
		accountId: "alice",
		signal: new AbortController().signal,
		onExport,
		effect: {
			id: 1,
			projectId: "project",
			adapter: "editorRender",
			request: {
				operation: "export",
				input: {
					projectId: "project",
					expectedRevision: 7,
					sceneId: "scene",
					format: "webm",
					includeAudio: true,
				},
			},
		},
	});
	expect(result.type).toBe("success");
	expect(store).toHaveBeenCalledTimes(1);
	expect(onExport).toHaveBeenCalledTimes(1);
	expect(editor.renderer.exportProject).toHaveBeenCalledWith(
		expect.objectContaining({
			options: { format: "webm", quality: "high", includeAudio: true },
		}),
	);
});
test("scope changes reject export before artifacts or download presentation", async () => {
	const { editor, store, change } = fixture();
	const onExport = mock();
	editor.renderer.exportProject = async () => {
		change();
		return { success: true, buffer: new ArrayBuffer(4) };
	};
	const result = await performRenderEffect({
		editor,
		accountId: "alice",
		signal: new AbortController().signal,
		onExport,
		effect: {
			id: 1,
			projectId: "project",
			adapter: "editorRender",
			request: {
				operation: "export",
				input: {
					projectId: "project",
					expectedRevision: 7,
					sceneId: "scene",
					format: "webm",
				},
			},
		},
	});
	expect(result.type).toBe("rejected");
	expect(store).not.toHaveBeenCalled();
	expect(onExport).not.toHaveBeenCalled();
});
test("remix measures a new manifest and releases its renderer without writing editor state", async () => {
	const { editor, store } = fixture();
	const before = disposed;
	const result = await performRenderEffect({
		editor,
		accountId: "alice",
		signal: new AbortController().signal,
		onExport: mock(),
		effect: {
			id: 1,
			projectId: "project",
			adapter: "hyperframesAuthoring",
			request: {
				operation: "remix",
				projectId: "project",
				expectedRevision: 7,
				source: {
					entryFile: "index.html",
					files: { "index.html": "hello" },
					resourceAssetIds: {},
				},
			},
		},
	});
	expect(result.type).toBe("success");
	expect(disposed).toBe(before + 1);
	expect(store).not.toHaveBeenCalled();
});
