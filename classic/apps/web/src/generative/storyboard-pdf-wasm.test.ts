// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { z } from "zod";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";
import { encodeStoryboardPdf } from "./storyboard-pdf-writer";
import { parseStoryboardPdfPlan } from "./storyboard-pdf-plan";

test("real browser WASM projects canonical client copy, calls its registered PDF host, and returns the exact ArtifactStore PDF", async () => {
	const rt = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const projectId = classic.document.metadata.id;
		rt.invokeSync(
			"project.classic.session.attach",
			{ projectId, expectedRevision: 0, classic },
			{},
		);
		const revision = () =>
			rt.invokeSync("app.state.read", {}, {}).result.data.value.revision;
		rt.invokeSync(
			"project.generative.edit",
			{
				projectId,
				expectedRevision: revision(),
				change: {
					type: "storyboard",
					storyboard: {
						title: "A client proposal",
						summary: "The story we will create.",
						sheetReferenceIds: [],
						scenes: [
							{
								id: "one",
								title: "The opening",
								description: "The door opens to a bright room.",
								startSeconds: 0,
								endSeconds: 4,
							},
						],
					},
				},
			},
			{},
		);
		const expectedRevision = revision();
		const plan = rt.invokeSync(
			"project.generative.storyboard.plan",
			{ projectId, expectedRevision },
			{},
		).result.data;
		expect(parseStoryboardPdfPlan(plan).scenes[0].description).toBe(
			"The door opens to a bright room.",
		);
		let hostCalls = 0;
		const canvas = createCanvas(10, 10);
		const pdf = encodeStoryboardPdf([
			{
				bytes: new Uint8Array(canvas.toBuffer("image/jpeg")),
				width: 10,
				height: 10,
			},
		]);
		const receipt = await rt.invokeWithHost(
			"project.generative.storyboard.export",
			{ projectId, expectedRevision },
			{},
			async (raw: unknown) => {
				const effect = z
					.object({
						adapter: z.literal("storyboardPdf"),
						projectId: z.literal(projectId),
						request: z.object({ plan: z.unknown() }).strict(),
					})
					.passthrough()
					.parse(raw);
				const supplied = parseStoryboardPdfPlan(effect.request.plan);
				expect(supplied.digest).toBe(plan.digest);
				hostCalls++;
				const artifact = rt.storeArtifact(
					pdf,
					"application/pdf",
					undefined,
					undefined,
					undefined,
				);
				return {
					type: "success",
					data: {
						projectId,
						revision: expectedRevision,
						planDigest: supplied.digest,
						artifact,
						pageCount: 1,
					},
				};
			},
		);
		expect(hostCalls).toBe(1);
		expect(receipt.result.artifacts).toHaveLength(1);
		const artifact = receipt.result.artifacts[0];
		expect(artifact.mimeType).toBe("application/pdf");
		expect(rt.readArtifact(artifact.id)).toEqual(pdf);
		expect(revision()).toBe(expectedRevision);
		const session = new CanonicalClassicSession({ runtime: rt, projectId });
		const temporary = session.storeStoryboardPdf({
			bytes: pdf,
			retainForConversation: false,
		});
		const retained = session.storeStoryboardPdf({
			bytes: pdf,
			retainForConversation: true,
		});
		const metadata = z.object({ expiresAtMs: z.number() });
		expect(
			metadata.parse(rt.artifactMetadata(temporary.id)).expiresAtMs,
		).toBeLessThan(Number.MAX_SAFE_INTEGER);
		expect(metadata.parse(rt.artifactMetadata(retained.id)).expiresAtMs).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	} finally {
		rt.free();
	}
});
