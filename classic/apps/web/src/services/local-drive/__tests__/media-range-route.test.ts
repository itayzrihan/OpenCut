import { expect, mock, test } from "bun:test";
mock.module("@/accounts/server", () => ({
	withAccount: (handler: unknown) => handler,
}));
mock.module("@/editor-agent/server/project-write", () => ({
	withProjectWriteRequest: () => {},
}));
mock.module("@/services/local-drive/server", () => ({
	assertLocalDriveRequest: () => {},
	getMediaFile: async () => ({
		path: "camera.mp4",
		stat: { size: 20 * 1024 ** 3, mtimeMs: 1 },
		record: { mimeType: "video/mp4" },
	}),
	storeUploadedMedia: () => {},
}));
const ranges: Array<{ start: number; end: number }> = [];
mock.module("@/services/local-drive/file-stream", () => ({
	createCancellationSafeFileStream: ({
		start,
		end,
	}: {
		start: number;
		end: number;
	}) => {
		ranges.push({ start, end });
		return new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
	},
}));
const { GET, HEAD } = await import("@/app/api/local-drive/media/route");
const url =
	"http://localhost/api/local-drive/media?projectId=project&id=camera";

test("HTTP media ranges advertise only the bounded response, with the full source size", async () => {
	const first = await GET(new Request(url, { headers: { Range: "bytes=0-" } }));
	expect(first.status).toBe(206);
	expect(first.headers.get("Content-Length")).toBe("8388608");
	expect(first.headers.get("Content-Range")).toBe(
		"bytes 0-8388607/21474836480",
	);
	const next = await GET(
		new Request(url, { headers: { Range: "bytes=8388608-" } }),
	);
	expect(next.headers.get("Content-Range")).toBe(
		"bytes 8388608-16777215/21474836480",
	);
	expect(ranges.slice(-2)).toEqual([
		{ start: 0, end: 8388607 },
		{ start: 8388608, end: 16777215 },
	]);
});

test("explicit ranges, suffix ranges, HEAD and complete-file downloads retain their semantics", async () => {
	const explicit = await GET(
		new Request(url, { headers: { Range: "bytes=100-199" } }),
	);
	expect(explicit.headers.get("Content-Length")).toBe("100");
	const suffix = await GET(
		new Request(url, { headers: { Range: "bytes=-100" } }),
	);
	expect(suffix.headers.get("Content-Range")).toBe(
		"bytes 21474836380-21474836479/21474836480",
	);
	const before = ranges.length;
	const head = await HEAD(
		new Request(url, { method: "HEAD", headers: { Range: "bytes=0-" } }),
	);
	expect(head.status).toBe(206);
	expect(ranges).toHaveLength(before);
	const full = await HEAD(new Request(url, { method: "HEAD" }));
	expect(full.status).toBe(200);
	expect(full.headers.get("Content-Length")).toBe("21474836480");
	const invalid = await GET(
		new Request(url, { headers: { Range: "bytes=21474836480-" } }),
	);
	expect(invalid.status).toBe(416);
});
