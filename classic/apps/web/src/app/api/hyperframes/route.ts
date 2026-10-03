/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The canonical registry validates source packages before resolving assets or executing scripts. */
import { z } from "zod";
import { requireAccount, withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { getMediaFile, getProject } from "@/services/local-drive/server";
import { HyperframesRenderHost } from "@/hyperframes/render-host";
import type { HyperframesSource } from "@/hyperframes/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const id = z.string().min(1).max(128);
const requestSchema = z.discriminatedUnion("action", [
	z
		.object({ action: z.literal("open"), projectId: id, source: z.unknown() })
		.strict(),
	z
		.object({
			action: z.literal("capture"),
			projectId: id,
			id,
			timeSeconds: z.number().finite().nonnegative(),
		})
		.strict(),
	z
		.object({ action: z.enum(["close", "keepAlive"]), projectId: id, id })
		.strict(),
]);
const cache = globalThis as typeof globalThis & {
	__opencutHyperframesHost?: Promise<HyperframesRenderHost>;
};
function getHost(): Promise<HyperframesRenderHost> {
	return (cache.__opencutHyperframesHost ??= (async () => {
		try {
			const { CanonicalEditorRuntime } =
				await import("opencut-editor-runtime-wasm");
			// This runtime is used only for canonical validation and output artifacts.
			// It never attaches or stores an editor project.
			return new HyperframesRenderHost(new CanonicalEditorRuntime());
		} catch (error) {
			delete cache.__opencutHyperframesHost;
			throw error;
		}
	})());
}

export const POST = withAccount(async (request) => {
	try {
		// A valid 16 MiB source can expand sixfold through JSON escapes.
		const input = requestSchema.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readBoundedBody(request, 100 * 1024 * 1024),
				),
			),
		);
		const scope = {
			accountId: requireAccount().id,
			projectId: input.projectId,
		};
		const host = await getHost();
		if (input.action === "open") {
			if (!(await getProject(input.projectId)))
				throw new Error("OpenCut project is unavailable");
			return Response.json(
				await host.open({
					scope,
					source: input.source as HyperframesSource,
					signal: request.signal,
					resolveResource: async (assetId) => {
						const file = await getMediaFile(input.projectId, assetId);
						return file
							? {
									path: file.path,
									mimeType: file.record.mimeType || "application/octet-stream",
									size: file.stat.size,
								}
							: null;
					},
				}),
			);
		}
		if (input.action === "capture")
			return Response.json(
				await host.capture({ ...input, scope, signal: request.signal }),
			);
		if (input.action === "keepAlive")
			return Response.json({
				alive: await host.keepAlive({ ...input, scope }),
			});
		await host.closeSession({ ...input, scope });
		return Response.json({ closed: true });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
});

export const GET = withAccount(async (request) => {
	try {
		const params = new URL(request.url).searchParams;
		const scope = {
			accountId: requireAccount().id,
			projectId: id.parse(params.get("projectId")),
		};
		const result = (await getHost()).readArtifact({
			scope,
			id: id.parse(params.get("id")),
		});
		return new Response(new Uint8Array(result.bytes), {
			headers: {
				"Content-Type": result.artifact.mimeType,
				"Content-Length": String(result.bytes.byteLength),
				"X-OpenCut-Artifact-Sha256": result.artifact.sha256,
			},
		});
	} catch {
		return Response.json(
			{ error: "HyperFrames artifact is unavailable" },
			{ status: 404 },
		);
	}
});
