import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import {
	forwardCodexResponsesRequest,
	getOpenAIOAuthStatus,
} from "@/ai/server/openai-codex-oauth";
import {
	getMediaFile,
	listProjectMetadata,
	storeUploadedMedia,
} from "@/services/local-drive/server";
import { withEditorProjectWrite } from "./project-write";

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
	const journal = z
		.object({ projectId: z.literal(projectId) })
		.passthrough()
		.parse(initial.journal);
	const root = join(accountDataRoot(), "image-jobs");
	const path = join(root, `${initial.jobKey}.json`);
	await mkdir(root, { recursive: true });
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
	await withEditorProjectWrite({
		projectId,
		write: async ({ assertWrite }) => assertWrite(),
	});
	const connection = await getOpenAIOAuthStatus({ request });
	if (!connection.status.authenticated || !connection.credentials)
		throw new ImageHostError({
			message:
				"Connect your Codex subscription for image generation. No paid API fallback is enabled.",
			definitive: true,
		});
	await assertOwned({ projectId, accountId: account.id });
	request.signal.throwIfAborted();
	// Exclusive durable claim precedes the provider request. A racing host or a
	// process restart can recover a completed record, never dispatch it twice.
	try {
		await writeFile(path, JSON.stringify(journal), { flag: "wx" });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			throw new ImageHostError({
				message:
					"This image operation is already running; reconcile the same operationId",
				definitive: false,
			});
		throw error;
	}
	const response = await forwardCodexResponsesRequest({
		credentials: connection.credentials,
		body: plan.providerBody!,
		signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
		allowModelFallback: false,
	});
	const output = z
		.object({ output: z.array(z.unknown()) })
		.passthrough()
		.parse(response).output;
	const images = output.flatMap((item) => {
		const parsed = z
			.object({
				type: z.literal("image_generation_call"),
				status: z.literal("completed"),
				result: z.string().min(1).max(24_000_000),
			})
			.passthrough()
			.safeParse(item);
		return parsed.success ? [parsed.data.result] : [];
	});
	if (images.length !== 1)
		throw new ImageHostError({
			message:
				"The subscription did not return exactly one completed image. Reconcile this operation before generating again.",
			definitive: false,
		});
	const bytes = Buffer.from(images[0], "base64");
	if (
		bytes.length > 16_000_000 ||
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		throw new ImageHostError({
			message: "Generated image is not a bounded PNG",
			definitive: false,
		});
	const decoder = sharp(bytes, { limitInputPixels: 4096 * 4096 });
	const dimensions = await decoder.metadata();
	await decoder.stats(); // Decode all pixels before publishing the artifact.
	request.signal.throwIfAborted();
	await assertOwned({ projectId, accountId: account.id });
	const result = resultSchema.parse({
		mediaId: plan.mediaId,
		fileName: plan.fileName,
		width: dimensions.width,
		height: dimensions.height,
		byteSize: bytes.length,
		lastModified: Date.now(),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	await storeUploadedMedia({
		projectId,
		mediaId: result.mediaId,
		fileName: result.fileName,
		mimeType: "image/png",
		lastModified: result.lastModified,
		size: bytes.length,
		allowLargeCopy: false,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	});
	const completed = planSchema.parse(
		subscriptionImagePlan(input, journal, result, Date.now()),
	);
	const temporary = `${path}.${randomUUID()}.pending`;
	await writeFile(temporary, JSON.stringify(completed.journal), { flag: "wx" });
	await rename(temporary, path);
	return { ...result, projectId, jobKey: plan.jobKey };
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
