import { expect, mock, test } from "bun:test";

let sampledAt: number | undefined;
let closed = false;
const track = {
	displayWidth: 1920,
	displayHeight: 1080,
	codec: "avc",
	canDecode: async () => true,
	computePacketStats: async () => ({ averagePacketRate: 30 }),
	getFirstTimestamp: async () => 2.25,
};

mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	BlobSource: class {},
	UrlSource: class {},
	Input: class {
		getDurationFromMetadata = async () => 4;
		getPrimaryVideoTrack = async () => track;
		getPrimaryAudioTrack = async () => null;
		dispose() {}
	},
	VideoSampleSink: class {
		async getSample(timestamp: number) {
			sampledAt = timestamp;
			return timestamp < 2.25
				? null
				: {
						close: () => {
							closed = true;
						},
					};
		}
	},
}));
mock.module("@/media/audio", () => ({ createTimelineAudioBuffer: () => null }));
mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 1 }));
mock.module("./thumbnail", () => ({
	renderThumbnailDataUrl: () => "data:image/jpeg;base64,AA==",
}));

const { readVideoFile } = await import("./mediabunny");

test("fast video thumbnails use the first presentation timestamp even when it starts after zero", async () => {
	const result = await readVideoFile({
		file: new File(["video"], "shifted.mp4"),
		fastMetadata: true,
	});
	expect(sampledAt).toBe(2.25);
	expect(result.thumbnailUrl).toBe("data:image/jpeg;base64,AA==");
	expect(result.duration).toBe(4);
	expect(closed).toBe(true);
});
