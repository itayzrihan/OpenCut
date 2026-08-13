import { describe, expect, test } from "bun:test";
import { scaleFrameOutput } from "../compositor/scale-frame-output";
import type {
	FrameDescriptor,
	TextureUploadDescriptor,
} from "../compositor/types";

describe("scaleFrameOutput", () => {
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
