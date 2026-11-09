import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { getMediaFile, listProjectMetadata } from "@/services/local-drive/server";

const resultSchema = z
	.object({
		mediaId: z.string().regex(/^imagegen-[a-f0-9]{64}$/),
		fileName: z.string().regex(/^imagegen-[a-f0-9]{64}\.png$/),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		width: z.number().int().min(1).max(4096),
		height: z.number().int().min(1).max(4096),
		byteSize: z.number().int().min(24).max(16_000_000),
		lastModified: z.number().int().nonnegative(),
	})
	.strict();
const planSchema = z
	.object({
		action: z.enum(["dispatch", "recover", "uncertain"]),
		jobKey: z.string().regex(/^[a-f0-9]{64}$/),
		journal: z.unknown().optional(),
		providerBody: z.record(z.string(), z.unknown()).optional(),
		mediaId: z.string().optional(),
		fileName: z.string().optional(),
		result: resultSchema.optional(),
		message: z.string().optional(),
	})
	.strict();
export class ImageHostError extends Error {
	readonly definitive: boolean;
	constructor({
		message,
		definitive,
	}: {
		message: string;
		definitive: boolean;
	}) {
		super(message);
		this.definitive = definitive;
	}
}
async function assertOwned({
	projectId,
	accountId,
}: {
	projectId: string;
	accountId: string;
}) {
	if (
		requireAccount().id !== accountId ||
		!(await listProjectMetadata()).some((p) => p.id === projectId)
	)
		throw new ImageHostError({
			message: "The authenticated account does not own this image project",
			definitive: true,
		});
}
/** Authenticated IO only. Rust owns the request, provider plan and durable dispatch policy. */
export async function generateSubscriptionImage({
	request,
	projectId,
	input,
}: {
	request: NextRequest;
	projectId: string;
	input: unknown;
}) {
	const account = requireAccount();
	await assertOwned({ projectId, accountId: account.id });
	request.signal.throwIfAborted();
	const { subscriptionImagePlan } = await import("opencut-editor-runtime-wasm");
	let initial: z.infer<typeof planSchema>;
	try {
		initial = planSchema.parse(
			subscriptionImagePlan(input, null, null, Date.now()),
		);
	} catch {
		throw new ImageHostError({
			message: "Invalid image generation request",
			definitive: true,
		});
	}
	z.object({ projectId: z.literal(projectId) }).parse(initial.journal);
	const root = join(accountDataRoot(), "image-jobs");
	const path = join(root, `${initial.jobKey}.json`);
	let saved: unknown = null;
	try {
		if ((await stat(path)).size > 16_000)
			throw new ImageHostError({
				message: "Image job record exceeds its limit",
				definitive: false,
			});
		saved = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	let plan: z.infer<typeof planSchema>;
	try {
		plan = planSchema.parse(
			subscriptionImagePlan(input, saved, null, Date.now()),
		);
	} catch {
		throw new ImageHostError({
			message: "operationId belongs to different image content",
			definitive: true,
		});
	}
	if (plan.action === "uncertain")
		throw new ImageHostError({
			message:
				plan.message ?? "Image result is uncertain; do not repeat generation",
			definitive: false,
		});
	if (plan.action === "recover")
		return { ...plan.result!, projectId, jobKey: plan.jobKey };
	throw new ImageHostError({
		message: "Image generation is unavailable through the POCUT Agent ChatGPT connection.",
		definitive: true,
	});
}

export async function readSubscriptionImage({
	projectId,
	jobKey,
}: {
	projectId: string;
	jobKey: string;
}) {
	if (!/^[a-f0-9]{64}$/.test(jobKey))
		throw new ImageHostError({
			message: "Invalid image job identity",
			definitive: true,
		});
	await assertOwned({ projectId, accountId: requireAccount().id });
	const path = join(accountDataRoot(), "image-jobs", `${jobKey}.json`);
	if ((await stat(path)).size > 16_000)
		throw new ImageHostError({
			message: "Invalid image job record",
			definitive: false,
		});
	const journal = z
		.object({
			projectId: z.literal(projectId),
			jobKey: z.literal(jobKey),
			state: z.literal("completed"),
			result: resultSchema,
		})
		.passthrough()
		.parse(JSON.parse(await readFile(path, "utf8")));
	const file = await getMediaFile(projectId, journal.result.mediaId);
	if (!file || file.stat.size !== journal.result.byteSize)
		throw new ImageHostError({
			message:
				"Completed image bytes are unavailable; do not regenerate automatically",
			definitive: false,
		});
	const bytes = await readFile(file.path);
	if (
		createHash("sha256").update(bytes).digest("hex") !== journal.result.sha256
	)
		throw new ImageHostError({
			message: "Completed image checksum differs",
			definitive: false,
		});
	return bytes;
}
