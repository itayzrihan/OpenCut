import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { ImageNode } from "@/services/renderer/nodes/image-node";
import { buildTransformFromParams } from "@/rendering";
import { checkExportEncoder } from "../video-encoding";

/** A tiny real encode/decode test. The one-pixel pattern detects 1080p upscaling. */
export async function verifySourceResolution() {
	const source = new OffscreenCanvas(3840, 2160);
	const context = source.getContext("2d")!;
	context.fillStyle = "#808080";
	context.fillRect(0, 0, 3840, 2160);
	context.fillStyle = "red";
	context.fillRect(0, 0, 200, 200);
	for (let x = 1800; x < 1864; x++) {
		context.fillStyle = x % 2 ? "white" : "black";
		context.fillRect(x, 1000, 1, 64);
	}
	const url = URL.createObjectURL(
		await source.convertToBlob({ type: "image/png" }),
	);
	const root = new RootNode({ duration: 12000 });
	root.add(
		new ImageNode({
			url,
			duration: 12000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: buildTransformFromParams({ params: {} }),
			opacity: 1,
		}),
	);
	const results = [];
	try {
		for (const codec of ["hevc", "avc"] as const) {
			const plan = {
				width: 3840,
				height: 2160,
				logicalWidth: 1920,
				logicalHeight: 1080,
				codec,
				videoBitrate: 32000000,
				estimatedBytes: 1,
				upscaledSources: [],
				warnings: [],
			};
			const unsupported = await checkExportEncoder(plan);
			if (unsupported) {
				results.push({ codec, unsupported });
				continue;
			}
			const exporter = new SceneExporter({
				...plan,
				videoCodec: codec,
				fps: { numerator: 30, denominator: 1 },
				format: "mp4",
				quality: "very_high",
			});
			const data = await exporter.export({ rootNode: root });
			if (!(data instanceof ArrayBuffer)) throw Error("No encoded output");
			const input = new Input({
				formats: ALL_FORMATS,
				source: new BlobSource(new Blob([data], { type: "video/mp4" })),
			});
			try {
				const track = await input.getPrimaryVideoTrack();
				if (!track) throw Error("Missing video track");
				const sample = await new VideoSampleSink(track).getSample(0);
				if (!sample) throw Error("Missing decoded frame");
				const canvas = new OffscreenCanvas(3840, 2160),
					ctx = canvas.getContext("2d")!;
				sample.draw(ctx, 0, 0);
				sample.close();
				const stripe = ctx.getImageData(1800, 1020, 64, 1).data;
				let contrast = 0;
				for (let i = 1; i < 64; i++)
					contrast += Math.abs(stripe[i * 4] - stripe[(i - 1) * 4]);
				contrast /= 63;
				const red = Array.from(ctx.getImageData(100, 100, 1, 1).data);
				if (
					track.displayWidth !== 3840 ||
					track.displayHeight !== 2160 ||
					contrast < 120 ||
					red[0] < 180 ||
					red[1] > 50
				)
					throw Error(`4K detail/layout check failed: ${contrast}, ${red}`);
				results.push({
					codec: track.codec,
					width: track.displayWidth,
					height: track.displayHeight,
					bytes: data.byteLength,
					nativePixelContrast: contrast,
					red,
					passed: true,
				});
			} finally {
				input.dispose();
			}
		}
	} finally {
		URL.revokeObjectURL(url);
	}
	return results;
}
