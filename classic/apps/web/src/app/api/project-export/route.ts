import { withAccount } from "@/accounts/server";
import { assertLocalDriveRequest } from "@/services/local-drive/server";
import { readBoundedBody } from "@/accounts/request-body";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	captureSavedExport,
	enqueueSavedExport,
} from "@/export/library-server";
import type { ExportOptions } from "@/export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const options = z
	.object({
		format: z.enum(["mp4", "webm"]),
		quality: z.enum(["low", "medium", "high", "very_high"]),
		preferences: z.object({
			resolution: z.enum(["project", "source"]),
			encoding: z.enum(["compact", "compatible"]),
		}),
		fps: z
			.object({
				numerator: z.number().int().positive(),
				denominator: z.number().int().positive(),
			})
			.optional(),
		includeAudio: z.boolean(),
	})
	.strict();
const identity = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[A-Za-z0-9_-]+$/);
const schema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("inspect"),
			projectId: identity,
			sceneId: identity.optional(),
			options: options.optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("enqueue"),
			id: z.string().uuid(),
			projectId: identity,
			sceneId: identity,
			expectedStorageRevision: z.number().int().nonnegative(),
			options,
			delivery: z.enum(["queue", "direct"]),
			destinationName: z.string().min(1).max(1024).optional(),
		})
		.strict(),
]);
async function post(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const body = schema.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readBoundedBody({ request, maximumBytes: 64 * 1024 }),
				),
			),
		);
		if (body.action === "inspect")
			return NextResponse.json((await captureSavedExport(body)).info);
		return NextResponse.json(
			await enqueueSavedExport({
				...body,
				options: body.options as ExportOptions,
			}),
		);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
export const POST = withAccount(post);
