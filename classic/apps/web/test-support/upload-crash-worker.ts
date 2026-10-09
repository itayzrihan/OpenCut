// A separate process lets the recovery test terminate file I/O without running
// storeUploadedMedia's catch/finally blocks, like an unexpected server exit.
import { mock } from "bun:test";
import { accountScope } from "@/accounts/server";
import "./session-policy";

mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
	batchEditIsLocked: () => false,
	batchEditTransition: () => "",
	fullAutoEditStages: () => [],
}));
const { storeUploadedMedia } = await import("@/services/local-drive/server");
const keepAlive = setInterval(() => undefined, 1000);
try {
	await accountScope.run(
		{ id: "recovery-account", login: "test", displayName: "Test" },
		() =>
			storeUploadedMedia({
				projectId: "project",
				mediaId: "interrupted",
				fileName: "resource.bin",
				mimeType: "application/octet-stream",
				lastModified: 1,
				size: 6,
				allowLargeCopy: false,
				uploadToken: "crashed-attempt",
				body: new ReadableStream<Uint8Array>(
					{
						pull: async (controller) => {
							controller.enqueue(new TextEncoder().encode("part"));
							process.stdout.write("upload-stream-open\n");
							await new Promise(() => undefined);
						},
					},
					{ highWaterMark: 0 },
				),
			}),
	);
} finally {
	clearInterval(keepAlive);
}
