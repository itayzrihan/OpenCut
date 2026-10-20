import { describe, expect, test } from "bun:test";
import { scaleFrameOutput } from "../compositor/scale-frame-output";
import type {
	FrameDescriptor,
	TextureUploadDescriptor,
} from "../compositor/types";

describe("scaleFrameOutput", () => {
	test("4K output preserves native camera pixels and scales nested intro layout and raster text", () => {
		const transform = {
			centerX: 960,
			centerY: 540,
			width: 1920,
			height: 1080,
			rotationDegrees: 0,
			perspectiveXDegrees: 0,
			perspectiveYDegrees: 0,
			flipX: false,
			flipY: false,
		};
		const frame: FrameDescriptor = {
			width: 1920,
			height: 1080,
			clear: { color: [0, 0, 0, 1] },
			items: [
				{
					type: "group",
					opacity: 0.25,
					blendMode: "normal",
					items: [
						{
							type: "layer",
							textureId: "camera",
							transform,
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				},
			],
		};
		const source = {} as CanvasImageSource;
		let rasterScale = 0;
		const output = scaleFrameOutput({
			frame,
			width: 3840,
			height: 2160,
			textures: [
				{ kind: "external", id: "camera", source, width: 3840, height: 2160 },
				{
					kind: "rendered",
					id: "title",
					width: 400,
					height: 100,
					contentHash: "text",
					draw: (context) => {
						context.fillRect(0, 0, 400, 100);
					},
				},
			],
		});
		expect(output.textures[0]).toMatchObject({
			width: 3840,
			height: 2160,
			source,
		});
		expect(output.textures[1]).toMatchObject({ width: 800, height: 200 });
		const group = output.frame.items[0];
		if (group.type !== "group" || group.items[0].type !== "layer")
			throw Error("Missing nested group");
		expect(group.opacity).toBe(0.25);
		expect(group.items[0].transform).toMatchObject({
			centerX: 1920,
			centerY: 1080,
			width: 3840,
			height: 2160,
		});
		const text = output.textures[1];
		if (text.kind === "external") throw Error("Expected raster text");
		text.draw({
			save() {},
			restore() {},
			scale(x: number) {
				rasterScale = x;
			},
			fillRect() {},
		} as unknown as CanvasRenderingContext2D);
		expect(rasterScale).toBe(2);
	});
	test("scales logical transforms and texture uploads for preview", () => {
		const frame: FrameDescriptor = {
			width: 1920,
			height: 1080,
			clear: { color: [0, 0, 0, 1] },
			items: [
				{
					type: "layer",
					textureId: "video",
					transform: {
						centerX: 960,
						centerY: 540,
						width: 1920,
						height: 1080,
						rotationDegrees: 0,
						perspectiveXDegrees: 0,
						perspectiveYDegrees: 0,
						flipX: false,
						flipY: false,
					},
					opacity: 1,
					blendMode: "normal",
					effectPassGroups: [
						[
							{
								shader: "gaussian-blur",
								uniforms: { u_sigma: 12, u_step: 2 },
							},
						],
					],
					mask: null,
				},
			],
		};
		// The scaler only preserves source identity; no canvas methods are used.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const source = {} as CanvasImageSource;
		const textures: TextureUploadDescriptor[] = [
			{
				kind: "external",
				id: "video",
				source,
				width: 1920,
				height: 1080,
			},
		];

		const result = scaleFrameOutput({
			frame,
			textures,
			width: 960,
			height: 540,
		});

		expect(result.frame.width).toBe(960);
		expect(result.frame.height).toBe(540);
		const item = result.frame.items[0];
		expect(item?.type).toBe("layer");
		if (item?.type !== "layer") throw new Error("Expected layer");
		expect(item.transform).toMatchObject({
			centerX: 480,
			centerY: 270,
			width: 960,
			height: 540,
		});
		expect(item.effectPassGroups[0]?.[0]?.uniforms).toMatchObject({
			u_sigma: 6,
			u_step: 1,
		});
		expect(result.textures[0]).toMatchObject({ width: 960, height: 540 });
	});

	test("scales wide procedural backgrounds with the frame instead of the world width", () => {
		const frame: FrameDescriptor = {
			width: 1080,
			height: 1920,
			clear: { color: [0, 0, 0, 1] },
			items: [],
		};
		// The scaler only preserves source identity; no canvas methods are used.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const source = {} as CanvasImageSource;
		const textures: TextureUploadDescriptor[] = [
			{
				kind: "external",
				id: "parallax-grid",
				source,
				width: 7560,
				height: 1920,
				previewScaleMode: "frame",
			},
		];

		const result = scaleFrameOutput({
			frame,
			textures,
			width: 270,
			height: 480,
		});

		expect(result.textures[0]).toMatchObject({
			width: 1890,
			height: 480,
			previewScaleMode: "frame",
		});
	});
});
