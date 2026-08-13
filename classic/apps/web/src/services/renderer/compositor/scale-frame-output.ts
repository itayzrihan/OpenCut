import type { EffectPass } from "@/effects/types";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	TextureUploadDescriptor,
} from "./types";

export function scaleFrameOutput({
	frame,
	textures,
	width,
	height,
}: {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
	width: number;
	height: number;
}): { frame: FrameDescriptor; textures: TextureUploadDescriptor[] } {
	if (frame.width === width && frame.height === height) {
		return { frame, textures };
	}

	const scaleX = width / Math.max(1, frame.width);
	const scaleY = height / Math.max(1, frame.height);
	const textureScale = Math.min(scaleX, scaleY);

	return {
		frame: {
			...frame,
			width,
			height,
			items: frame.items.map((item) =>
				scaleFrameItem({ item, scaleX, scaleY, effectScale: textureScale }),
			),
		},
		textures: textures.map((texture) => {
			const externalScale = Math.min(
				1,
				Math.max(width, height) /
					Math.max(1, texture.width, texture.height),
			);
			const rasterScale =
				texture.kind === "external" && texture.previewScaleMode !== "frame"
					? externalScale
					: textureScale;
			const textureWidth = Math.max(1, Math.round(texture.width * rasterScale));
			const textureHeight = Math.max(
				1,
				Math.round(texture.height * rasterScale),
			);
			if (texture.kind === "external") {
				return {
					...texture,
					width: textureWidth,
					height: textureHeight,
				};
			}

			return {
				...texture,
				contentHash: `${texture.contentHash}:preview-${textureWidth}x${textureHeight}`,
				width: textureWidth,
				height: textureHeight,
				draw: (context) => {
					context.save();
					context.scale(rasterScale, rasterScale);
					texture.draw(context);
					context.restore();
				},
			};
		}),
	};
}

function scaleFrameItem({
	item,
	scaleX,
	scaleY,
	effectScale,
}: {
	item: FrameItemDescriptor;
	scaleX: number;
	scaleY: number;
	effectScale: number;
}): FrameItemDescriptor {
	if (item.type === "group") {
		return {
			...item,
			items: item.items.map((child) =>
				scaleFrameItem({ item: child, scaleX, scaleY, effectScale }),
			),
		};
	}

	if (item.type === "sceneEffect") {
		return {
			...item,
			effect_pass_groups: scaleEffectPassGroups({
				groups: item.effect_pass_groups,
				scale: effectScale,
			}),
		};
	}

	return {
		...item,
		transform: {
			...item.transform,
			centerX: item.transform.centerX * scaleX,
			centerY: item.transform.centerY * scaleY,
			width: item.transform.width * scaleX,
			height: item.transform.height * scaleY,
		},
		effectPassGroups: scaleEffectPassGroups({
			groups: item.effectPassGroups,
			scale: effectScale,
		}),
	};
}

function scaleEffectPassGroups({
	groups,
	scale,
}: {
	groups: EffectPass[][];
	scale: number;
}): EffectPass[][] {
	return groups.map((passes) =>
		passes.map((pass) => {
			if (pass.shader !== "gaussian-blur") return pass;
			return {
				...pass,
				uniforms: {
					...pass.uniforms,
					u_sigma:
						typeof pass.uniforms.u_sigma === "number"
							? pass.uniforms.u_sigma * scale
							: pass.uniforms.u_sigma,
					u_step:
						typeof pass.uniforms.u_step === "number"
							? pass.uniforms.u_step * scale
							: pass.uniforms.u_step,
				},
			};
		}),
	);
}
