import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mediaBinary,
	probeVideo,
	runMediaProcess,
	transcodePreview,
	verifyProxyTiming,
	type VideoProbe,
} from "../transcode";

// eslint-disable-next-line opencut/prefer-object-params -- Compact test fixture for timestamp vectors.
const probe = (times: number[], duration = 0.04): VideoProbe => ({
	streams: [],
	packets: times.map((time) => ({
		pts_time: String(time),
		duration_time: String(duration),
	})),
});
test("proxy validation accepts reordered packets and rejects missing, shifted and stretched frames", () => {
	expect(() =>
		verifyProxyTiming({
			source: probe([0.08, 0, 0.04]),
			proxy: probe([0, 0.04, 0.08]),
		}),
	).not.toThrow();
	for (const invalid of [
		probe([0, 0.04]),
		probe([0.04, 0.08, 0.12]),
		probe([0, 0.04, 0.08], 0.041),
		probe([NaN, 0.04, 0.08]),
	])
		expect(() =>
			verifyProxyTiming({ source: probe([0, 0.04, 0.08]), proxy: invalid }),
		).toThrow();
});

test("real proxy preserves B-frame presentation timing and fractional frame rates, and stays silent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opencut-proxy-test-"));
	try {
		const source = join(directory, "source.mp4"),
			output = join(directory, "proxy.mp4");
		await runMediaProcess({
			command: mediaBinary("ffmpeg"),
			args: [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=1920x1080:rate=30000/1001",
				"-frames:v",
				"15",
				"-c:v",
				"libx264",
				"-threads",
				"2",
				"-pix_fmt",
				"yuv422p10le",
				"-bf",
				"2",
				source,
			],
		});
		const original = await stat(source);
		const result = await transcodePreview({ source, destination: output });
		expect(result).toMatchObject({ frames: 15, width: 1280, height: 720 });
		verifyProxyTiming({
			source: await probeVideo({ path: source }),
			proxy: await probeVideo({ path: output }),
		});
		expect((await stat(source)).mtimeMs).toBe(original.mtimeMs);
		const streams = JSON.parse(
			await runMediaProcess({
				command: mediaBinary("ffprobe"),
				args: [
					"-v",
					"error",
					"-show_entries",
					"stream=codec_type",
					"-of",
					"json",
					output,
				],
			}),
		).streams;
		expect(
			streams.map((stream: { codec_type: string }) => stream.codec_type),
		).toEqual(["video"]);
		const abort = new AbortController();
		abort.abort();
		await expect(
			transcodePreview({
				source,
				destination: join(directory, "cancelled.mp4"),
				signal: abort.signal,
			}),
		).rejects.toThrow();
		await expect(stat(join(directory, "cancelled.mp4"))).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
