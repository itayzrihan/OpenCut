import { withAccount, localRequestOrigin } from "@/accounts/server";
import { ensureRenderWorker } from "@/export/queue/host";
import { assertLocalDriveRequest } from "@/services/local-drive/server";
import { readBoundedBody } from "@/accounts/request-body";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	readRenderQueue,
	enqueueRender,
	changeRender,
	claimRender,
	reportRender,
} from "@/export/queue/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const identity = z.string().uuid();
const projectIdentity = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[A-Za-z0-9_-]+$/);
const requestSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("enqueue"),
			id: identity,
			projectId: projectIdentity,
			sceneId: projectIdentity,
			sourceRevision: z.number().int().nonnegative(),
			snapshot: z.unknown(),
			options: z.unknown(),
		})
		.strict(),
	z
		.object({
			action: z.enum(["cancel", "retry"]),
			id: identity,
			projectId: projectIdentity,
			expectedRevision: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			action: z.literal("configure"),
			id: identity,
			projectId: projectIdentity,
			expectedRevision: z.number().int().nonnegative(),
			options: z.unknown(),
		})
		.strict(),
	z
		.object({
			action: z.literal("claim"),
			attempt: identity,
			jobId: identity.optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("report"),
			id: identity,
			projectId: projectIdentity,
			attempt: identity,
			progress: z.number().min(0).max(1),
			message: z.string().max(4000),
			status: z.enum(["rendering", "failed", "cancelled", "completed"]),
		})
		.strict(),
]);
async function get(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const worker = request.headers.has("x-opencut-render-worker")
			? undefined
			: await ensureRenderWorker(localRequestOrigin(request));
		return NextResponse.json({ ...(await readRenderQueue()), worker });
	} catch (e) {
		return NextResponse.json({ error: String(e) }, { status: 400 });
	}
}
async function post(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const body = requestSchema.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readBoundedBody({ request, maximumBytes: 32 * 1024 * 1024 }),
				),
			),
		);
		if (body.action === "enqueue") {
			const state = await enqueueRender(
				body as Parameters<typeof enqueueRender>[0],
			);
			const worker = await ensureRenderWorker(localRequestOrigin(request));
			return NextResponse.json({ ...state, worker });
		}
		if (body.action === "claim")
			return NextResponse.json(await claimRender(body.attempt, body.jobId));
		if (body.action === "report") {
			if (body.status === "completed") {
				const { readRenderJob } = await import("@/export/queue/server");
				const job = await readRenderJob(body.id);
				if (job.delivery !== "direct" || job.attempt !== body.attempt)
					throw Error(
						"Only the direct destination worker can acknowledge a saved export",
					);
			}
			return NextResponse.json(await reportRender(body));
		}
		const state = await changeRender({
			...body,
			type: body.action,
		} as Parameters<typeof changeRender>[0]);
		const worker = await ensureRenderWorker(localRequestOrigin(request));
		return NextResponse.json({ ...state, worker });
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 400 },
		);
	}
}
export const GET = withAccount(get);
export const POST = withAccount(post);
