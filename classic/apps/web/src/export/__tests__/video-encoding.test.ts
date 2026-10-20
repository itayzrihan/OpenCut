import { expect, mock, test } from "bun:test";
const probe = mock(async () => true);
mock.module("mediabunny", () => ({ canEncodeVideo: probe }));
const { checkExportEncoder } = await import("../video-encoding");
const plan = {
	width: 3840,
	height: 2160,
	logicalWidth: 1920,
	logicalHeight: 1080,
	codec: "hevc" as const,
	videoBitrate: 32000000,
	estimatedBytes: 1,
	upscaledSources: [],
	warnings: [],
};
test("checks exact output size/bitrate with quality encoding", async () => {
	probe.mockResolvedValue(true);
	expect(await checkExportEncoder(plan)).toBeNull();
	expect(probe).toHaveBeenLastCalledWith("hevc", {
		width: 3840,
		height: 2160,
		bitrate: 32000000,
		bitrateMode: "variable",
		latencyMode: "quality",
	});
});
test("unsupported HEVC is explicit and never silently replaced", async () => {
	probe.mockResolvedValue(false);
	expect(await checkExportEncoder(plan)).toContain("Choose Compatible H.264");
	probe.mockRejectedValue(new Error("unsupported"));
	expect(await checkExportEncoder(plan)).toContain(
		"HEVC encoding is unavailable",
	);
});
