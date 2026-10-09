import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

test("real WASM source-PNG inspection is discoverable, read-only, checksummed and restores pinned bytes", async () => {
	const runtime = await createCanonicalTestRuntime();
	const rgba = Buffer.from([
		255, 0, 255, 0, 10, 20, 30, 255, 200, 0, 0, 127, 20, 40, 60, 128, 250, 250,
		250, 0, 30, 60, 90, 255,
	]);
	const png = await sharp(rgba, { raw: { width: 3, height: 2, channels: 4 } })
		.png()
		.toBuffer();
	const artifact = z
		.object({ id: z.string(), sha256: z.string() })
		.parse(runtime.storeArtifact(png, "image/png", 3, 2));
	runtime.pinArtifact(artifact.id);
	const classic = z
		.object({
			document: z.record(z.string(), z.unknown()),
			mediaAssets: z.array(z.record(z.string(), z.unknown())),
		})
		.parse(
			JSON.parse(
				await readFile(
					new URL(
						"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
	classic.mediaAssets.push({
		id: "inspected-image",
		name: "PNG fixture",
		type: "image",
		generation: { artifactId: artifact.id, sha256: artifact.sha256 },
	});
	runtime.invokeSync(
		"project.classic.session.attach",
		{
			projectId: "classic-project",
			expectedRevision: 0,
			classic,
		},
		undefined,
	);
	const input = {
		projectId: "classic-project",
		expectedRevision: 1,
		mediaId: "inspected-image",
	};
	const inspect = () =>
		z
			.object({
				result: z.object({
					data: z.object({
						transparentPixels: z.number(),
						opaquePixels: z.number(),
						partialAlphaPixels: z.number(),
						decodedHasAlpha: z.boolean(),
						artifact: z.object({ sha256: z.string() }),
						visibleBounds: z.object({ width: z.number(), height: z.number() }),
						visibleColors: z.object({
							pixelCount: z.number(),
							meanRgb: z.array(z.number()),
						}),
					}),
				}),
			})
			.parse(
				runtime.invokeSync("media.classic.image.inspect", input, undefined),
			).result.data;
	try {
		const before = runtime.serialize();
		const beforeState: unknown = structuredClone(runtime.snapshot());
		const result = inspect();
		expect(result).toMatchObject({
			transparentPixels: 2,
			opaquePixels: 2,
			partialAlphaPixels: 2,
			decodedHasAlpha: true,
			visibleBounds: { width: 3, height: 2 },
			visibleColors: { pixelCount: 3, meanRgb: [20, 40, 60] },
		});
		expect(result.artifact.sha256).toBe(
			createHash("sha256").update(png).digest("hex"),
		);
		// Serialized envelopes include an export timestamp; compare editor state.
		expect(runtime.snapshot()).toEqual(beforeState);
		expect(() =>
			runtime.invokeSync(
				"media.classic.image.inspect",
				{
					...input,
					projectId: "other",
				},
				undefined,
			),
		).toThrow();
		const artifacts = runtime.conversationArtifacts("alice", "classic-project");
		const reopened = await createCanonicalTestRuntime();
		try {
			reopened.restore(before);
			reopened.restoreConversationArtifacts(
				"alice",
				"classic-project",
				artifacts,
			);
			const response = z
				.object({
					result: z.object({
						data: z.object({
							artifact: z.object({ sha256: z.string() }),
							transparentPixels: z.number(),
						}),
					}),
				})
				.parse(
					reopened.invokeSync("media.classic.image.inspect", input, undefined),
				);
			expect(response.result.data.artifact.sha256).toBe(result.artifact.sha256);
			expect(response.result.data.transparentPixels).toBe(2);
		} finally {
			reopened.free();
		}
	} finally {
		runtime.free();
	}
});
