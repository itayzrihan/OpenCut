import { describe, expect, test } from "bun:test";
import {
	getAudioBitrateCandidates,
	getPreferredAudioBitrate,
} from "@/export/audio-quality";

describe("export audio quality", () => {
	test("uses a higher AAC bitrate for very high than high", () => {
		expect(
			getPreferredAudioBitrate({ codec: "aac", quality: "very_high" }),
		).toBeGreaterThan(
			getPreferredAudioBitrate({ codec: "aac", quality: "high" }),
		);
	});

	test("checks high-quality AAC fallbacks before lower bitrates", () => {
		expect(
			getAudioBitrateCandidates({ codec: "aac", quality: "very_high" }),
		).toEqual([320_000, 256_000, 224_000, 192_000, 160_000, 128_000, 96_000]);
	});

	test("keeps WebM Opus quality monotonic", () => {
		expect(
			getPreferredAudioBitrate({ codec: "opus", quality: "very_high" }),
		).toBeGreaterThan(
			getPreferredAudioBitrate({ codec: "opus", quality: "high" }),
		);
	});
});
