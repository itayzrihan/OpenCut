import { NextResponse } from "next/server";
import { z } from "zod";
import { basename } from "node:path";
import {
	assertLocalDriveRequest,
	chooseFiles,
} from "@/services/local-drive/server";
import {
	getBatchState,
	createBatch,
	updateBatch,
	cancelBatch,
} from "@/batch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const options = z
	.object({
		zoom: z.boolean(),
		transitions: z.boolean(),
		wordAnimation: z.boolean(),
		music: z.boolean(),
	})
	.strict();
const schema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("pick") }),
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
export async function GET(request: Request) {
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
export async function POST(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const raw = await request.text();
		if (raw.length > 50000) throw new Error("Batch request too large");
		const body = schema.parse(JSON.parse(raw));
		if (body.action === "pick")
			return NextResponse.json(
				(await chooseFiles())
					.filter((p) => /\.(mp4|mov|mkv|webm|m4v|avi|mts|m2ts)$/i.test(p))
					.map((p) => ({ sourcePath: p, name: basename(p) })),
			);
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
