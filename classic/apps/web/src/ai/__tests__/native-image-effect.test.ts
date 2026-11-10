import { expect, mock, test } from "bun:test";
import type { EditingAgentHostEffect } from "@/core/agent-protocol";
let approved = false,
	calls = 0;
let current = true;
const bytes = new Uint8Array(32);
bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
bytes.set([73, 72, 68, 82], 12);
new DataView(bytes.buffer).setUint32(16, 64);
new DataView(bytes.buffer).setUint32(20, 32);
mock.module("../local-connection", () => ({
	generateConnectedImage: async () => {
		calls++;
		return {
			blob: new Blob([bytes], { type: "image/png" }),
			mimeType: "image/png",
			lastModified: 12345,
		};
	},
}));
mock.module("@/editor-agent/image-generation-review", () => ({
	reviewNativeImage: async () => approved,
}));
const { performNativeImageEffect } = await import("../native-image-effect");
test("canonical native image adapter requires review and produces stable bounded owned-media metadata", async () => {
	const original = globalThis.createImageBitmap;
	Object.assign(globalThis, {
		createImageBitmap: async () => ({ width: 64, height: 32, close() {} }),
	});
	try {
		const effect: EditingAgentHostEffect = {
			id: 1,
			adapter: "subscriptionImage",
			projectId: "project",
			request: {
				projectId: "project",
				operationId: "image-one",
				prompt: "One approved frame",
				references: [],
			},
		};
		const common = {
			effect,
			accountId: "account",
			signal: new AbortController().signal,
			scopeIsCurrent: () => current,
			storeImage: (image: {
				bytes: Uint8Array;
				width: number;
				height: number;
			}) => ({
				uri: "artifact://image",
				mimeType: "image/png",
				width: image.width,
				height: image.height,
				byteSize: image.bytes.length,
			}),
		};
		expect((await performNativeImageEffect(common)).type).toBe("rejected");
		expect(calls).toBe(0);
		approved = true;
		const first = await performNativeImageEffect(common);
		expect(first.type).toBe("success");
		if (first.type !== "success") throw new Error("Expected success");
		expect(first.data).toMatchObject({
			projectId: "project",
			operationId: "image-one",
			lastModified: 12345,
			artifact: { width: 64, height: 32, byteSize: 32 },
		});
		expect(await performNativeImageEffect(common)).toEqual(first);
		current = false;
		expect((await performNativeImageEffect(common)).type).toBe("rejected");
		expect(calls).toBe(2);
	} finally {
		Object.assign(globalThis, { createImageBitmap: original });
	}
});
