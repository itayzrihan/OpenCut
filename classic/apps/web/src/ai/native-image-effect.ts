import { z } from "zod";
import { generateConnectedImage } from "./local-connection";
import { reviewNativeImage } from "@/editor-agent/image-generation-review";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";

export async function performNativeImageEffect({
	effect,
	accountId,
	signal,
	scopeIsCurrent,
	storeImage,
}: {
	effect: EditingAgentHostEffect;
	accountId: string;
	signal: AbortSignal;
	scopeIsCurrent: () => boolean;
	storeImage: (image: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}) => unknown;
}): Promise<EditingAgentHostResult> {
	const input = z
		.object({
			projectId: z.literal(effect.projectId),
			operationId: z.string().min(1).max(160),
			prompt: z.string().min(1).max(16000),
			transparentBackground: z.boolean().default(false),
			references: z
				.array(z.object({ imageUrl: z.string() }))
				.max(4)
				.default([]),
		})
		.passthrough()
		.parse(effect.request);
	if (!scopeIsCurrent())
		return { type: "rejected", message: "The image project changed" };
	const prompt =
		input.prompt +
		(input.transparentBackground ? "\nUse a transparent background." : "");
	if (
		!(await reviewNativeImage({
			accountId,
			projectId: effect.projectId,
			prompt,
			referenceCount: input.references.length,
			signal,
		}))
	)
		return { type: "rejected", message: "Image generation was not approved" };
	if (!scopeIsCurrent())
		return { type: "rejected", message: "The image project changed" };
	const output = await generateConnectedImage({
		projectId: effect.projectId,
		operationId: input.operationId,
		prompt,
		references: input.references.map((r) => r.imageUrl),
		confirmed: true,
		signal,
	});
	signal.throwIfAborted();
	if (!scopeIsCurrent())
		throw new Error(
			"The image was generated, but the project changed. Recover this same operationId.",
		);
	const bitmap = await createImageBitmap(output.blob);
	let bytes: Uint8Array;
	const { width, height } = bitmap;
	try {
		if (width < 1 || height < 1 || width > 4096 || height > 4096)
			throw new Error("The generated image exceeds the editor dimensions");
		if (output.mimeType === "image/png")
			bytes = new Uint8Array(await output.blob.arrayBuffer());
		else {
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d");
			if (!context)
				throw new Error("The browser image converter is unavailable");
			context.drawImage(bitmap, 0, 0);
			bytes = new Uint8Array(
				await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
			);
		}
	} finally {
		bitmap.close();
	}
	if (bytes.length > 16_000_000)
		throw new Error("The generated PNG exceeds the editor byte limit");
	const key = Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify([effect.projectId, input.operationId]),
				),
			),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
	signal.throwIfAborted();
	if (!scopeIsCurrent())
		throw new Error("Recover the image in its original project");
	return {
		type: "success",
		data: {
			projectId: effect.projectId,
			operationId: input.operationId,
			mediaId: `imagegen-${key}`,
			fileName: `imagegen-${key}.png`,
			lastModified: output.lastModified,
			artifact: storeImage({ bytes, width, height }),
		},
	};
}
