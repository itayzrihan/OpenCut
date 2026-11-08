import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	withProjectWriteRequest,
	withEditorProjectWrite,
} from "@/editor-agent/server/project-write";
import {
	readPeerStatus,
	startMediaPull,
	readPullJob,
	cancelMediaPull,
	verifiedPullSource,
	listPullJobs,
} from "@/peer-sync/host";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const scope = z.object({ projectId: id, operationId: id }).strict();
export const POST = withAccount(async (request: Request) => {
	try {
		if (request.headers.has("x-opencut-render-worker"))
			throw new Error("Render workers cannot transfer originals");
		const body = z
			.object({
				operation: z.enum([
					"devices",
					"transfers",
					"start",
					"status",
					"cancel",
					"source",
				]),
				projectId: id,
				input: z.record(z.string(), z.unknown()),
			})
			.strict()
			.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request, maximumBytes: 8192 }),
					),
				),
			);
		if (body.input.projectId !== body.projectId)
			throw new Error("Transfer project scope differs");
		const result = await withProjectWriteRequest({
			request,
			run: async () => {
				// Short authorization preflight only. No network/file transfer holds the
				// project lock, so editing with missing media remains available.
				await withEditorProjectWrite({
					projectId: body.projectId,
					write: async ({ assertWrite }) => assertWrite(),
				});
				if (body.operation === "devices")
					return { status: await readPeerStatus({ touch: true }) };
				if (body.operation === "transfers")
					return { jobs: await listPullJobs(body.projectId) };
				if (body.operation === "start") {
					const { resume, expectedRevision: _revision, ...input } = body.input;
					return {
						job: await startMediaPull({ input, resume: resume === true }),
					};
				}
				const input = scope.parse({
					projectId: body.projectId,
					operationId: body.input.operationId,
				});
				if (body.operation === "source") return verifiedPullSource(input);
				return {
					job: await (body.operation === "cancel"
						? cancelMediaPull(input)
						: readPullJob(input)),
				};
			},
		});
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		// Invalid scope and preflight rejection are definitive. Transfer acceptance
		// is separately reconciled by its durable operationId after a lost reply.
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : "Media transfer rejected",
				definitive: true,
			},
			{ status: 400 },
		);
	}
});
