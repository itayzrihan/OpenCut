import { ALL_FORMATS, Input, VideoSampleSink } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "@/media/source";

export type OrderedPodcastColor = {
	exposure: number;
	temperature: number;
	tint: number;
};

export async function readPodcastColor({
	asset,
	duration,
}: {
	asset: BrowserMediaSource;
	duration: number;
}): Promise<OrderedPodcastColor | undefined> {
	const input = new Input({
		source: createMediaSource({
			...asset,
			urlOptions: { maxCacheSize: 8 * 1024 * 1024, parallelism: 1 },
		}),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode())) return;
		const sink = new VideoSampleSink(track);
		const canvas = new OffscreenCanvas(48, 32);
		const context = canvas.getContext("2d", { willReadFrequently: true })!;
		const luma: number[] = [];
		let red = 0;
		let green = 0;
		let blue = 0;
		let neutral = 0;
		const first = await track.getFirstTimestamp();
		for (const position of [0.2, 0.5, 0.8]) {
			const sample = await sink.getSample(first + position * duration);
			if (!sample) continue;
			try {
				sample.draw(context, 0, 0, canvas.width, canvas.height);
				const { data } = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height,
				);
				for (let index = 0; index < data.length; index += 4) {
					const [r, g, b] = [data[index]!, data[index + 1]!, data[index + 2]!];
					const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
					if (light > 12 && light < 250) luma.push(light);
					if (
						light < 50 ||
						light > 235 ||
						Math.max(r, g, b) - Math.min(r, g, b) > 28
					)
						continue;
					red += r;
					green += g;
					blue += b;
					neutral++;
				}
			} finally {
				sample.close();
			}
		}
		if (luma.length < 64) return;
		luma.sort((a, b) => a - b);
		const clamp = (value: number, min: number, max: number) =>
			Math.max(min, Math.min(max, value));
		const median = luma[Math.floor(luma.length * 0.5)]!;
		const highlights = luma[Math.floor(luma.length * 0.95)]!;
		// Leave deliberate dark looks and bright highlights mostly intact.
		const desired = 0.65 * Math.log2(115 / median);
		const exposure = clamp(
			Math.min(desired, Math.max(0, Math.log2(245 / highlights))),
			-0.55,
			0.65,
		);
		const enoughNeutral = neutral >= luma.length * 0.12;
		return {
			exposure: Math.round(exposure * 20) / 20,
			temperature: enoughNeutral
				? Math.round(clamp(((blue - red) / neutral) * 0.45, -16, 16))
				: 0,
			tint: enoughNeutral
				? Math.round(
						clamp(((green - (red + blue) / 2) / neutral) * 0.45, -14, 14),
					)
				: 0,
		};
	} finally {
		input.dispose();
	}
}
