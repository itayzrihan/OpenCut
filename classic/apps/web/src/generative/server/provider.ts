/** HTTP/credential adapter only. Canonical editing state lives in Rust. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DirectorJob, DirectorReference } from "../types";
import { REPLACE_IMAGE_MODEL, REPLACE_MAX_REFERENCES, REPLACE_VIDEO_MODEL } from "../replace-model";
import {
	supportsSeamless,
	type VideoGenerationModel,
} from "../seamless-models";
import {
	CHATGPT_STORYBOARD_MODEL,
	CHATGPT_STORYBOARD_ORCHESTRATOR,
} from "../storyboard-model";
import * as store from "./store";
import * as vault from "./vault";
export type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
const host = globalThis as typeof globalThis & {
	__directorWorkers?: Set<string>;
	__directorApprove?: Set<string>;
};
const workers = (host.__directorWorkers ??= new Set());
const approvals = (host.__directorApprove ??= new Set());
const API = "https://openrouter.ai/api/v1";
const failedVideoStatuses = ["failed", "cancelled", "expired"] as const;
const videoStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	...failedVideoStatuses,
]);
const targetId = z.string().min(1).max(256);
const settingsSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		kind: z.enum(["video", "storyboard"]),
		model: z.string().min(1).max(200),
		prompt: z
			.string()
			.max(100_000)
			.refine((prompt) => !!prompt.trim()),
		duration: z.number().int().min(1).max(30).optional(),
		resolution: z.enum(["480p", "720p", "1080p"]).optional(),
		aspectRatio: z
			.enum(["9:16", "16:9", "4:3", "3:4", "1:1", "21:9", "9:21"])
			.optional(),
		referenceIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(12),
		httpsReferences: z.record(z.string(), z.string().url()).optional(),
		referenceImage: z.literal(true).optional(),
		replacement: z.object({
			sceneId: targetId,
			trackId: targetId,
			elementId: targetId,
			anchor: z.string().regex(/^[a-f0-9]{64}$/),
			durationTicks: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
			mode: z.enum(["full", "refine"]),
		}).strict().optional(),
		seamless: z
			.object({
				sceneId: targetId,
				trackId: targetId,
				leftId: targetId,
				rightId: targetId,
				anchor: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict()
			.optional(),
	})
	.strict();
export type Model = VideoGenerationModel;
export async function models(net: Fetcher = fetch): Promise<Model[]> {
	const r = await net(API + "/videos/models", {
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) throw new Error("Video model catalog unavailable");
	return (await r.json()).data;
}
async function bodyBytes({
	r,
	max = 100 * 1024 * 1024,
}: {
	r: Response;
	max?: number;
}) {
	const reader = r.body?.getReader();
	if (!reader) throw new Error("Empty provider response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > max) throw new Error("Provider output exceeds100MB limit");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}
async function provider({
	root,
	path,
	body,
	net = fetch,
}: {
	root: string;
	path: string;
	body?: unknown;
	net?: Fetcher;
}) {
	const key = vault.keyFor(root);
	const r = await net(API + path, {
		method: body ? "POST" : "GET",
		headers: {
			Authorization: "Bearer " + key,
			"Content-Type": "application/json",
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		redirect: "error",
		signal: AbortSignal.timeout(180_000),
	});
	if (!r.ok)
		throw new Error(
			`OpenRouter returned HTTP${r.status}. No paid retry was sent.`,
		);
	return r;
}
export async function prepare({
	root,
	raw,
	referenceUrl,
	net = fetch,
}: {
	root: string;
	raw: unknown;
	referenceUrl: (r: DirectorReference) => Promise<string>;
	net?: Fetcher;
}) {
	const i = settingsSchema.parse(raw);
	store.validProject(i.projectId);
	if (
		i.replacement &&
		(i.kind !== "video" ||
			i.model !== REPLACE_VIDEO_MODEL ||
			i.seamless || i.httpsReferences || i.referenceImage ||
			i.referenceIds.length > REPLACE_MAX_REFERENCES ||
			new Set(i.referenceIds).size !== i.referenceIds.length ||
			(i.replacement.mode === "refine" && i.referenceIds.length === 0))
	)
		throw new Error("Replace requires Wan 3.0 and up to ten distinct image references");
	if (
		i.referenceImage &&
		(i.kind !== "storyboard" || i.model !== REPLACE_IMAGE_MODEL ||
			i.referenceIds.length > REPLACE_MAX_REFERENCES || i.httpsReferences)
	)
		throw new Error("Unsupported replacement reference image request");
	if (
		i.seamless &&
		(i.kind !== "video" ||
			i.referenceIds.length !== 2 ||
			i.referenceIds[0] === i.referenceIds[1] ||
			i.httpsReferences ||
			i.seamless.leftId === i.seamless.rightId)
	)
		throw new Error("Seamless Connect requires two distinct boundary images");
	if (
		!i.seamless && !i.replacement &&
		((i.duration !== undefined && i.duration < 4) ||
			i.resolution === "1080p" ||
			i.aspectRatio === "9:21")
	)
		throw new Error("Unsupported Director generation settings");
	const chatgpt =
		i.kind === "storyboard" && i.model === CHATGPT_STORYBOARD_MODEL;
	const refs = [];
	const bindings = [];
	const imageUrls: string[] = [];
	let embeddedBytes = 0;
	for (const refId of i.referenceIds) {
		const f = await store.fileBytes({
			root: root,
			fileId: refId,
			projectId: i.projectId,
		});
		const ref = f.info;
		if (i.seamless && (ref.kind !== "image" || f.bytes.length > 512_000))
			throw new Error("Seamless Connect requires two bounded image references");
		if (i.replacement && ref.kind !== "image")
			throw new Error("Replace accepts image references only");
		if (i.kind === "storyboard" && ref.kind !== "image")
			throw new Error(
				"Storyboard generation accepts image references only; original audio remains attached to the later video",
			);
		if (ref.kind === "image") {
			embeddedBytes += f.bytes.length;
			if (embeddedBytes > 24 * 1024 * 1024)
				throw new Error(
					"Image references exceed the24MB embedded request limit. Use smaller reference copies; originals are retained.",
				);
		}
		if (
			i.kind === "video" &&
			ref.kind === "audio" &&
			f.info.durationSeconds &&
			(i.duration ?? 0) < f.info.durationSeconds
		)
			throw new Error(
				"Video duration would truncate the original dialogue. Increase duration or split the source recording before uploading.",
			);
		refs.push({
			id: ref.id,
			name: ref.name,
			kind: ref.kind,
			mime: ref.mime,
			bytes: ref.bytes,
			storyboard: ref.storyboard,
		});
		const url =
			ref.kind === "image"
				? `data:${ref.mime};base64,${f.bytes.toString("base64")}`
				: i.httpsReferences?.[refId] || (await referenceUrl(ref));
		if (chatgpt) imageUrls.push(url);
		if (ref.kind !== "image") {
			const u = new URL(url);
			if (
				u.protocol !== "https:" ||
				u.username ||
				u.password ||
				u.hash ||
				u.hostname === "localhost" ||
				u.hostname.endsWith(".local") ||
				/^[\d.:[\]]+$/.test(u.hostname)
			)
				throw new Error(
					"Audio/video references need reachable temporary HTTPS media links",
				);
		}
		if (ref.kind !== "image") {
			const u = new URL(url);
			const publicHost = process.env.OPENCUT_PUBLIC_ORIGIN
				? new URL(process.env.OPENCUT_PUBLIC_ORIGIN).hostname
				: null;
			if (u.hostname !== "pocast.co.il" && u.hostname !== publicHost)
				throw new Error(
					"Use a verified POCAST HTTPS link or this POCUT public host",
				);
			const remote = await net(url, {
				redirect: "error",
				signal: AbortSignal.timeout(60_000),
			});
			if (
				!remote.ok ||
				store.sha(await bodyBytes({ r: remote })) !== f.info.sha256
			)
				throw new Error(
					"Hosted audio/video does not match the original file bytes",
				);
		}
		bindings.push({ type: ref.kind + "_url", [ref.kind + "_url"]: { url } });
	}
	if (
		i.kind === "video" &&
		!i.seamless &&
		!i.replacement &&
		!refs.some((r) => r.storyboard && r.kind === "image")
	)
		throw new Error(
			"Attach a physical storyboard image before preparing a video",
		);
	let body: Record<string, unknown>;
	if (i.kind === "video") {
		const catalog = await models(net);
		const model = catalog.find((m) => m.id === i.model);
		if (
			!model ||
			(i.seamless && !supportsSeamless(model)) ||
			!model.supported_durations?.includes(i.duration ?? 0) ||
			!model.supported_resolutions?.includes(i.resolution ?? "") ||
			!model.supported_aspect_ratios?.includes(i.aspectRatio ?? "")
		)
			throw new Error(
				"Selected video model does not support these settings. Refresh the model list.",
			);
		body = {
			model: i.model,
			prompt: i.prompt,
			duration: i.duration,
			resolution: i.resolution,
			aspect_ratio: i.aspectRatio,
			generate_audio: !i.seamless && !i.replacement,
			...(i.seamless
				? {
						frame_images: bindings.map((image, index) => ({
							...image,
							frame_type: index === 0 ? "first_frame" : "last_frame",
						})),
					}
				: bindings.length ? { input_references: bindings } : {}),
		};
	} else if (chatgpt) {
		body = {
			model: CHATGPT_STORYBOARD_ORCHESTRATOR,
			input: [
				{
					role: "system",
					content:
						"Use the image_generation tool to create exactly one PNG storyboard sheet from the brief. Use the attached images as visual references only. Do not return prose, SVG or a URL in place of the image.",
				},
				{
					role: "user",
					content: [
						{ type: "input_text", text: i.prompt },
						...imageUrls.map((image_url) => ({
							type: "input_image",
							image_url,
						})),
					],
				},
			],
			tools: [{ type: "image_generation", output_format: "png" }],
		};
	} else {
		body = {
			model: i.model,
			modalities: ["image", "text"],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: i.prompt }, ...bindings],
				},
			],
		};
	}
	const bytes = JSON.stringify(body),
		j: DirectorJob = {
			id: store.id(),
			projectId: i.projectId,
			kind: i.kind,
			status: "review",
			digest: store.sha(bytes),
			prompt: i.prompt,
			model: chatgpt ? CHATGPT_STORYBOARD_ORCHESTRATOR : i.model,
			...(chatgpt ? { provider: "chatgpt" as const } : {}),
			...(i.seamless ? { seamless: i.seamless } : {}),
			...(i.replacement ? { replacement: i.replacement } : {}),
			...(i.referenceImage ? { referenceImage: i.referenceImage } : {}),
			duration: i.duration,
			resolution: i.resolution,
			aspectRatio: i.aspectRatio,
			references: refs,
			createdAt: Date.now(),
			message: chatgpt
				? "Review the exact prompt and references before approving one image through your ChatGPT/Codex connection."
				: "Review the exact request, references and cost before approving with your PIN.",
		};
	const directory = store.jobRoot({ root: root, jobId: j.id });
	await store.saveJson({ root: directory, name: "payload.json", value: body });
	await store.saveJson({ root: directory, name: "review.json", value: j });
	return j;
}

type ChatGptGenerator = (body: Record<string, unknown>) => Promise<Buffer>;

export class ChatGptStoryboardRejected extends Error {}

export async function approve({
	root,
	projectId,
	jobId,
	pin,
	digest,
	authorizeChatGpt,
	net = fetch,
}: {
	root: string;
	projectId: string;
	jobId: string;
	pin: unknown;
	digest: string;
	authorizeChatGpt?: () => Promise<ChatGptGenerator>;
	net?: Fetcher;
}) {
	const token = root + "/" + jobId;
	if (approvals.has(token))
		throw new Error("Approval is already being processed");
	approvals.add(token);
	try {
		const directory = store.jobRoot({ root: root, jobId: jobId }),
			j = await store.json<DirectorJob>({
				root: directory,
				name: "review.json",
			});
		if (
			j.projectId !== projectId ||
			j.status !== "review" ||
			j.digest !== digest
		)
			throw new Error("Request changed or already handled");
		const body = await store.json<Record<string, unknown>>({
			root: directory,
			name: "payload.json",
		});
		if (Date.now() - j.createdAt > 55 * 60_000)
			throw new Error(
				"Request review expired; prepare a fresh media link and request",
			);
		if (store.sha(JSON.stringify(body)) !== digest)
			throw new Error("Frozen request changed");
		for (const ref of j.references)
			await store.fileBytes({
				root: root,
				fileId: ref.id,
				projectId: projectId,
			});
		const chatgpt = j.provider === "chatgpt";
		const generate = chatgpt ? await authorizeChatGpt?.() : undefined;
		if (chatgpt && !generate)
			throw new Error("Connect ChatGPT/Codex to approve this storyboard");
		if (generate) {
			// Claim on disk before calling the provider, including across host restarts.
			try {
				await writeFile(join(directory, "chatgpt-approval"), digest, {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "EEXIST"
				)
					throw new Error(
						"This storyboard was already approved. Check its status before starting another.",
					);
				throw error;
			}
		} else {
			await vault.unlock({ root: root, pin: pin });
		}
		j.status = "submitting";
		j.message = generate
			? "Generating with ChatGPT Image…"
			: "Sending once to OpenRouter…";
		await store.saveJson({ root: directory, name: "review.json", value: j });
		workers.add(token);
		const submission = generate
			? submitChatGpt({ root, job: j, body, generate })
			: submit({ root, j, body, net });
		void submission
			.finally(() => workers.delete(token))
			.catch(() => {
				// The durable submitting state is reconciled on the next status read.
			});
		return j;
	} finally {
		approvals.delete(token);
	}
}
async function submitChatGpt({
	root,
	job,
	body,
	generate,
}: {
	root: string;
	job: DirectorJob;
	body: Record<string, unknown>;
	generate: ChatGptGenerator;
}) {
	try {
		job.output = await store.artifact({
			root,
			projectId: job.projectId,
			name: "Director storyboard.png",
			mime: "image/png",
			bytes: await generate(body),
			storyboard: true,
		});
		job.status = "ready";
		job.message = "Storyboard ready. Review it before preparing the video.";
	} catch (error) {
		job.status =
			error instanceof ChatGptStoryboardRejected ? "error" : "uncertain";
		job.message =
			error instanceof ChatGptStoryboardRejected
				? error.message
				: "ChatGPT Image did not return a verified storyboard. Check your account before starting another request.";
	}
	await store.saveJson({
		root: store.jobRoot({ root, jobId: job.id }),
		name: "review.json",
		value: job,
	});
}
async function submit({
	root,
	j,
	body,
	net,
}: {
	root: string;
	j: DirectorJob;
	body: unknown;
	net: Fetcher;
}) {
	const directory = store.jobRoot({ root: root, jobId: j.id });
	try {
		const response = await provider({
			root: root,
			path: j.kind === "video" ? "/videos" : "/chat/completions",
			body: body,
			net: net,
		});
		const result = JSON.parse(
			(await bodyBytes({ r: response, max: 16 * 1024 * 1024 })).toString(),
		);
		if (j.kind === "storyboard") {
			const url = result.choices?.[0]?.message?.images?.[0]?.image_url?.url;
			const image =
				typeof url === "string" &&
				/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
			if (!image)
				throw new Error("Image provider returned no inline image");
			const imageName = j.referenceImage ? "Replace reference image" : "Director storyboard";
			j.output = await store.artifact({
				root: root,
				projectId: j.projectId,
				name: `${imageName}.${image[1] === "image/jpeg" ? "jpg" : image[1] === "image/webp" ? "webp" : "png"}`,
				mime: image[1],
				bytes: Buffer.from(image[2], "base64"),
				storyboard: !j.referenceImage,
			});
			j.status = "ready";
			j.message = "Storyboard ready. Review it before preparing the video.";
			j.cost =
				typeof result.usage?.cost === "number" ? result.usage.cost : undefined;
		} else {
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id))
				throw new Error("Provider returned no valid job ID");
			j.providerId = result.id;
			j.submittedAt = Date.now();
			j.providerStatus = "pending";
			j.providerStatusAt = j.submittedAt;
			j.status = "pending";
			j.message = "Accepted by the provider; waiting for generation.";
			await store.saveJson({ root: directory, name: "review.json", value: j });
			await monitor({ root: root, j: j, net: net });
			return;
		}
	} catch {
		j.status = "uncertain";
		j.message =
			"The paid request did not finish reliably. No automatic paid retry. Check provider activity before preparing another request.";
	}
	await store.saveJson({ root: directory, name: "review.json", value: j });
}
async function monitor({
	root,
	j,
	net,
}: {
	root: string;
	j: DirectorJob;
	net: Fetcher;
}) {
	const directory = store.jobRoot({ root: root, jobId: j.id });
	while (j.providerId) {
		try {
			vault.keyFor(root);
			const r = await provider({
					root: root,
					path: "/videos/" + j.providerId,
					body: undefined,
					net: net,
				}),
				result = JSON.parse(
					(await bodyBytes({ r: r, max: 1024 * 1024 })).toString(),
				);
			const providerStatus = videoStatusSchema.parse(
				result.status === "processing" ? "in_progress" : result.status,
			);
			if (
				j.providerStatus !== providerStatus ||
				j.providerStatusAt === undefined
			) {
				j.providerStatusAt =
					j.providerStatus === undefined && providerStatus === "pending"
						? (j.submittedAt ?? Date.now())
						: Date.now();
			}
			j.providerStatus = providerStatus;
			if (providerStatus === "completed") {
				j.status = "processing";
				j.message = "Video generated; downloading from OpenRouter.";
				await store.saveJson({
					root: directory,
					name: "review.json",
					value: j,
				});
				const response = await provider({
					root: root,
					path: "/videos/" + j.providerId + "/content?index=0",
					body: undefined,
					net: net,
				});
				const bytes = await bodyBytes({ r: response });
				if (!bytes.subarray(0, 64).includes(Buffer.from("ftyp")))
					throw new Error("Provider returned invalid MP4");
				j.output = await store.artifact({
					root: root,
					projectId: j.projectId,
					name: `${j.replacement ? "Replace" : j.seamless ? "Seamless-Connect" : "Director"}-${j.id.slice(0, 8)}.mp4`,
					mime: "video/mp4",
					bytes: bytes,
				});
				j.status = "ready";
				j.message = "Video ready. It will be added to project Media.";
				j.cost =
					typeof result.usage?.cost === "number"
						? result.usage.cost
						: undefined;
				await store.saveJson({
					root: directory,
					name: "review.json",
					value: j,
				});
				return;
			}
			if (providerStatus !== "pending" && providerStatus !== "in_progress") {
				j.status = "error";
				j.message = "Provider generation ended: " + providerStatus;
				await store.saveJson({
					root: directory,
					name: "review.json",
					value: j,
				});
				return;
			}
			j.status = providerStatus === "in_progress" ? "processing" : "pending";
			j.message = "Provider status: " + providerStatus;
			await store.saveJson({ root: directory, name: "review.json", value: j });
		} catch {
			j.status = vault.seconds(root) > 0 ? "error" : "session_expired";
			j.message =
				j.status === "session_expired"
					? "Unlock with PIN to resume free checks for this existing job."
					: "Status/download failed. Resume this existing job; no paid retry was sent.";
			await store.saveJson({ root: directory, name: "review.json", value: j });
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 15_000));
	}
}
export async function resume({
	root,
	projectId,
}: {
	root: string;
	projectId: string;
}) {
	for (const j of await store.jobs({ root: root, projectId: projectId })) {
		const token = root + "/" + j.id;
		if (workers.has(token)) continue;
		if (
			failedVideoStatuses.some(
				(status) =>
					j.providerStatus === status ||
					j.message === "Provider generation ended: " + status,
			)
		)
			continue;
		if (
			j.providerId &&
			["pending", "processing", "error"].includes(j.status) &&
			vault.seconds(root) === 0
		) {
			j.status = "session_expired";
			j.message =
				"Unlock with PIN to resume free checks for this existing job.";
			await store.saveJson({
				root: store.jobRoot({ root, jobId: j.id }),
				name: "review.json",
				value: j,
			});
			continue;
		}
		if (
			j.providerId &&
			["pending", "processing", "session_expired", "error"].includes(j.status)
		) {
			workers.add(token);
			void monitor({ root: root, j: j, net: fetch }).finally(() =>
				workers.delete(token),
			);
		} else if (j.status === "submitting") {
			j.status = "uncertain";
			j.message =
				"App restarted during submission. Check provider activity; no paid retry.";
			await store.saveJson({
				root: store.jobRoot({ root: root, jobId: j.id }),
				name: "review.json",
				value: j,
			});
		}
	}
}
export async function reject({
	root,
	projectId,
	jobId,
}: {
	root: string;
	projectId: string;
	jobId: string;
}) {
	if (approvals.has(root + "/" + jobId))
		throw new Error("Approval is already being processed");
	const dir = store.jobRoot({ root: root, jobId: jobId }),
		j = await store.json<DirectorJob>({ root: dir, name: "review.json" });
	if (j.projectId !== projectId || j.status !== "review")
		throw new Error("Only pending review can be rejected");
	j.status = "rejected";
	j.message =
		j.provider === "chatgpt"
			? "Rejected. No image request sent."
			: "Rejected. No paid request sent.";
	await store.saveJson({ root: dir, name: "review.json", value: j });
	return j;
}
