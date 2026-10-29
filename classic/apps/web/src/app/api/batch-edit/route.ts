import { withAccount } from "@/accounts/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { basename } from "node:path";
import {
	assertLocalDriveRequest,
	chooseFiles,
} from "@/services/local-drive/server";
import {
	getBatchState,
	createProjectEdit,
	createBatch,
	updateBatch,
	cancelBatch,
	createSceneEdits,
	recoverSceneWorker,
	retrySceneEdit,
} from "@/batch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const options = z
	.object({
		zoom: z.boolean(),
		transitions: z.boolean(),
		wordAnimation: z.boolean(),
		music: z.boolean(),
		soundEffects: z.boolean().default(false),
		brandKitId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
	})
	.strict();
const schema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("retry"),
		executor: z.enum(["iframe", "window"]).optional(),
		id: z.string().uuid(),
		ownerId: z.string().uuid(),
	}),
	z.object({
		action: z.literal("scenes"),
		executor: z.enum(["iframe", "window"]).optional(),
		projectId: z.string().uuid(),
		jobIds: z.array(z.string().uuid()).min(1).max(100),
		ownerId: z.string().uuid(),
	}),
	z.object({
		action: z.literal("recover"),
		executor: z.enum(["iframe", "window"]).optional(),
		workerId: z.string().uuid().optional(),
		ownerId: z.string().uuid(),
		activeRunId: z.string().uuid().optional(),
	}),
	z.object({ action: z.literal("pick") }),
	z.object({
		action: z.literal("project"),
		id: z.string().uuid(),
		projectId: z.string().uuid(),
		expectedUpdatedAt: z.string().datetime(),
		resumeRunId: z.string().uuid().optional(),
		options,
	}),
	z.object({
		action: z.literal("create"),
		id: z.string().uuid(),
		files: z
			.array(
				z.object({
					projectId: z.string().uuid(),
					fileName: z.string().min(1).max(255),
				}),
			)
			.min(1)
			.max(100),
		options,
	}),
	z.object({
		action: z.literal("update"),
		id: z.string().uuid(),
		projectId: z.string().uuid().optional(),
		event: z
			.enum(["import", "ready", "run", "complete", "fail", "cancel"])
			.optional(),
		message: z.string().max(4000).optional(),
		created: z.boolean().optional(),
		completedStages: z.number().int().min(0).max(20).optional(),
	}),
	z.object({
		action: z.literal("cancel"),
		id: z.string().uuid(),
		projectId: z.string().uuid().optional(),
	}),
]);
async function GETHandler(request: Request) {
	try {
		assertLocalDriveRequest(request);
		return NextResponse.json(await getBatchState());
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 400 },
		);
	}
}
async function POSTHandler(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const raw = await request.text();
		if (raw.length > 50000) throw new Error("Batch request too large");
		const body = schema.parse(JSON.parse(raw));
		if (body.action === "retry")
			return NextResponse.json(await retrySceneEdit(body));
		if (body.action === "scenes")
			return NextResponse.json(await createSceneEdits(body));
		if (body.action === "recover")
			return NextResponse.json(await recoverSceneWorker(body));
		if (body.action === "pick")
			return NextResponse.json(
				(await chooseFiles())
					.filter((p) => /\.(mp4|mov|mkv|webm|m4v|avi|mts|m2ts)$/i.test(p))
					.map((p) => ({ sourcePath: p, name: basename(p) })),
			);
		if (body.action === "project")
			return NextResponse.json(await createProjectEdit(body));
		if (body.action === "create") {
			if (
				new Set(body.files.map((f) => f.projectId)).size !== body.files.length
			)
				throw new Error("Duplicate project ids");
			return NextResponse.json(await createBatch(body));
		}
		if (body.action === "cancel")
			return NextResponse.json(await cancelBatch(body));
		return NextResponse.json(
			await updateBatch({
				...body,
				token: request.headers.get("X-OpenCut-Batch-Token") ?? "",
			}),
		);
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 400 },
		);
	}
}

export const GET = withAccount(GETHandler);

export const POST = withAccount(POSTHandler);
