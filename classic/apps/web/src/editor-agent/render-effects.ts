import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { HyperframesRenderClient } from "@/hyperframes/render-client";
import { mediaTime } from "@/wasm/media-time";
import { z } from "zod";
import { assertBatchEditable } from "@/batch/read-only";
import { inspectEncodedVideo } from "./video-inspection";

const sourceSchema = z
	.object({
		entryFile: z.string(),
		files: z.record(z.string(), z.string()),
		resourceAssetIds: z.record(z.string(), z.string()),
		variables: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
const scopeSchema = z.object({
	projectId: z.string(),
	expectedRevision: z.number().int().nonnegative(),
});

/** Host IO only: Rust supplies the package or prepared source and owns the
 * subsequent atomic commit. Never call a second editor write from this host. */
export async function performRenderEffect({
	effect,
	editor,
	accountId,
	signal,
	onExport,
}: {
	effect: EditingAgentHostEffect;
	editor: EditorCore;
	accountId: string;
	signal: AbortSignal;
	onExport: (value: {
		blob: Blob;
		filename: string;
		artifactId: string;
	}) => void;
}): Promise<EditingAgentHostResult> {
	const envelope = z
		.object({
			operation: z.enum(["import", "remix", "preview", "export"]),
			input: z.unknown().optional(),
		})
		.passthrough()
		.parse(effect.request);
	const input = scopeSchema.parse(envelope.input ?? effect.request);
	const assertScope = () => {
		signal.throwIfAborted();
		assertBatchEditable(effect.projectId);
		if (
			(window.__opencutAccountId ?? "local") !== accountId ||
			editor.project.getActiveOrNull()?.metadata.id !== effect.projectId ||
			input.projectId !== effect.projectId ||
			editor.command.getEditingAgentSnapshot()?.revision !==
				input.expectedRevision
		)
			throw new Error("The render account, project or revision changed");
	};
	try {
		assertScope();
		if (effect.adapter === "hyperframesAuthoring") {
			let source;
			if (envelope.operation === "import") {
				const request = scopeSchema
					.extend({ id: z.string(), upstreamCommit: z.string() })
					.parse(envelope.input);
				const prepared = z
					.object({
						entryFile: z.string(),
						files: z.array(z.object({ path: z.string(), sha256: z.string() })),
					})
					.parse(envelope.prepared);
				const files: Record<string, string> = {};
				for (const file of prepared.files) {
					let offset = 0;
					let text = "";
					for (;;) {
						assertScope();
						const response = await fetch(
							"/api/editor-agent/hyperframes-references",
							{
								method: "POST",
								credentials: "same-origin",
								cache: "no-store",
								signal,
								headers: {
									"Content-Type": "application/json",
									"X-OpenCut-Account": accountId,
								},
								body: JSON.stringify({
									projectId: effect.projectId,
									request: {
										...request,
										filePath: `@prepared/${file.path}`,
										expectedSha256: file.sha256,
										offset,
										limit: 12000,
									},
								}),
							},
						);
						if (!response.ok)
							throw new Error("The pinned reference could not be read");
						const page = z
							.object({
								text: z.string(),
								nextOffset: z.number().int().nullable(),
							})
							.parse(await response.json());
						text += page.text;
						if (page.nextOffset === null) break;
						if (page.nextOffset <= offset)
							throw new Error("Invalid reference pagination");
						offset = page.nextOffset;
					}
					files[file.path] = text;
				}
				source = { entryFile: prepared.entryFile, files, resourceAssetIds: {} };
			} else source = sourceSchema.parse(envelope.source);
			const renderer = new HyperframesRenderClient(effect.projectId);
			const abort = () => renderer.dispose();
			signal.addEventListener("abort", abort, { once: true });
			try {
				const session = await renderer.prepareSource(source);
				assertScope();
				return {
					type: "success",
					data: { source, manifest: session.runtimeManifest },
				};
			} finally {
				signal.removeEventListener("abort", abort);
				renderer.dispose();
			}
		}
		const request = scopeSchema
			.extend({
				sceneId: z.string(),
				timeTicks: z.number().int().nonnegative().nullable().optional(),
				format: z.enum(["mp4", "webm"]).nullable().optional(),
				includeAudio: z.boolean().optional(),
			})
			.parse(envelope.input);
		const assertScene = () => {
			assertScope();
			if (editor.scenes.getActiveSceneOrNull()?.id !== request.sceneId)
				throw new Error("The render scene changed");
		};
		assertScene();
		let blob: Blob;
		let filename = "";
		let media: Awaited<ReturnType<typeof inspectEncodedVideo>> | undefined;
		if (envelope.operation === "preview") {
			const frame = await editor.renderer.capturePreviewFrameAt({
				time: mediaTime({ ticks: request.timeTicks! }),
				maxDimension: 1024,
				maxBytes: 180000,
			});
			if (!frame.success) throw new Error(frame.error);
			blob = frame.blob;
		} else {
			const format = request.format!;
			const result = await editor.renderer.exportProject({
				options: {
					format,
					quality: "high",
					includeAudio: request.includeAudio,
				},
				onCancel: () => {
					try {
						assertScene();
						return false;
					} catch {
						return true;
					}
				},
			});
			if (!result.success || !result.buffer)
				throw new Error(result.error ?? "Export cancelled");
			media = await inspectEncodedVideo({ buffer: result.buffer, signal });
			if (!request.includeAudio && media.audioTracks !== 0)
				throw new Error("Silent export unexpectedly contains an audio track");
			blob = new Blob([result.buffer], {
				type: format === "mp4" ? "video/mp4" : "video/webm",
			});
			filename = `OpenCut-${effect.projectId}.${format}`;
		}
		assertScene();
		const artifact = editor.command.storeEditingAgentRender({
			bytes: new Uint8Array(await blob.arrayBuffer()),
			mimeType: blob.type,
		});
		assertScene();
		if (filename) onExport({ blob, filename, artifactId: artifact.id });
		return {
			type: "success",
			data: {
				projectId: effect.projectId,
				revision: input.expectedRevision,
				sceneId: request.sceneId,
				artifact,
				...(media ? { media } : {}),
			},
		};
	} catch (error) {
		// This adapter never commits: a definitive preflight/render failure is
		// safe to settle even after cancellation. Rust rechecks before commit.
		return {
			type: "rejected",
			message: error instanceof Error ? error.message : "Rendering failed",
		};
	}
}
