import type { ExportQuality } from "./index";

export type ExportAudioCodec = "aac" | "opus";

const AUDIO_BITRATE_BY_CODEC_AND_QUALITY = {
	aac: {
		low: 96_000,
		medium: 128_000,
		high: 192_000,
		very_high: 320_000,
	},
	opus: {
		low: 38_000,
		medium: 64_000,
		high: 128_000,
		very_high: 256_000,
	},
} as const satisfies Record<
	ExportAudioCodec,
	Record<ExportQuality, number>
>;

const AAC_BITRATE_FALLBACKS_BY_QUALITY = {
	low: [96_000],
	medium: [128_000, 96_000],
	high: [192_000, 160_000, 128_000, 96_000],
	very_high: [320_000, 256_000, 224_000, 192_000, 160_000, 128_000, 96_000],
} as const satisfies Record<ExportQuality, readonly number[]>;

export function getPreferredAudioBitrate({
	codec,
	quality,
}: {
	codec: ExportAudioCodec;
	quality: ExportQuality;
}): number {
	return AUDIO_BITRATE_BY_CODEC_AND_QUALITY[codec][quality];
}

export function getAudioBitrateCandidates({
	codec,
	quality,
}: {
	codec: ExportAudioCodec;
	quality: ExportQuality;
}): readonly number[] {
	if (codec === "aac") {
		return AAC_BITRATE_FALLBACKS_BY_QUALITY[quality];
	}

	return [getPreferredAudioBitrate({ codec, quality })];
}
