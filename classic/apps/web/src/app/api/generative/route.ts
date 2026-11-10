import { join } from "node:path";
import type { NextRequest } from "next/server";
import {
	withAccount,
	accountDataRoot,
	assertLocalOrigin,
} from "@/accounts/server";
import { probeReference } from "@/generative/server/probe";
import { requestBytes } from "@/generative/server/request";
import * as vault from "@/generative/server/vault";
import * as store from "@/generative/server/store";
import * as provider from "@/generative/server/provider";
import * as batches from "@/generative/server/batch";
import { importArchiveReference } from "@/generative/server/archive-reference";
import { publicOrigin, share } from "@/generative/server/shares";
import { CHATGPT_STORYBOARD_MODEL } from "@/generative/storyboard-model";
export const runtime = "nodejs";

export const GET = withAccount(async (request: Request) => {
	try {
		const url = new URL(request.url),
			projectId = store.validProject(url.searchParams.get("projectId") ?? ""),
			root = join(accountDataRoot(), "generative");
		if (url.searchParams.get("imageModels") === "1")
			return Response.json({ models: await provider.imageModels() });
		if (url.searchParams.get("models") === "1")
			return Response.json({ models: await provider.models() });
		const batchId = url.searchParams.get("batch");
		if (batchId)
			return Response.json({
				batch: await batches.readBatch({ root, projectId, id: batchId }),
			});
		const fileId = url.searchParams.get("file");
		if (fileId) {
			const f = await store.fileBytes({
				root: root,
				fileId: fileId,
				projectId: projectId,
			});
			return new Response(new Uint8Array(f.bytes), {
				headers: {
					"Content-Type": f.info.mime,
					"Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${f.info.name.replace(/[^\w. -]/g, "_")}"`,
					"Cache-Control": "private, no-store",
				},
			});
		}
		await provider.resume({ root, projectId });
		return Response.json({
			configured: await vault.configured(root),
			sessionSeconds: vault.seconds(root),
			jobs: await store.jobs({ root: root, projectId: projectId }),
			publicOrigin: publicOrigin(),
		});
	} catch (e) {
		return Response.json(
			{
				error: e instanceof Error ? e.message : "Unable to read Director state",
			},
			{ status: 400 },
		);
	}
});
export const POST = withAccount(async (request: NextRequest) => {
	try {
		assertLocalOrigin(request);
		const root = join(accountDataRoot(), "generative");
		if (request.headers.get("content-type")?.includes("multipart/form-data")) {
			const length = Number(request.headers.get("content-length") ?? 0);
			if (length > 101 * 1024 * 1024)
				throw new Error("Reference exceeds100MB limit");
			const bounded = await requestBytes({ request, limit: 101 * 1024 * 1024 });
			const form = await new Request(request.url, {
					method: "POST",
					headers: request.headers,
					body: bounded,
				}).formData(),
				projectId = store.validProject(String(form.get("projectId") ?? "")),
				file = form.get("file");
			if (!(file instanceof File) || file.size > 100 * 1024 * 1024)
				throw new Error("Invalid reference file");
			if (form.get("archiveReference") === "1") {
				const reference = await importArchiveReference({
					root,
					projectId,
					reference: {
						id: form.get("id"),
						sha256: form.get("sha256"),
						name: form.get("name"),
						mime: file.type,
						storyboard: form.get("storyboard") === "true",
					},
					bytes: Buffer.from(await file.arrayBuffer()),
				});
				return Response.json({ reference });
			}
			const reference = await store.artifact({
				root: root,
				projectId: projectId,
				name: file.name,
				mime: file.type,
				bytes: Buffer.from(await file.arrayBuffer()),
				storyboard: form.get("storyboard") === "true",
			});
			const durationSeconds = await probeReference({
				root,
				projectId,
				id: reference.id,
			});
			return Response.json({ reference, durationSeconds });
		}
		const raw = new TextDecoder().decode(
			await requestBytes({ request, limit: 150_000 }),
		);
		if (raw.length > 150_000) throw new Error("Request too large");
		const body = JSON.parse(raw);
		const projectId = store.validProject(body.projectId ?? "");
		switch (body.action) {
			case "batch-status":
				return Response.json({
					batch: await batches.readBatch({ root, projectId, id: body.id }),
				});
			case "prepare-batch":
				return Response.json({
					batch: await batches.prepareBatch({
						root,
						projectId,
						raw: body.batch,
					}),
				});
			case "approve-batch":
				return Response.json({
					batch: await batches.approveBatch({
						root,
						projectId,
						id: body.id,
						digest: body.digest,
						pin: body.pin,
						confirmed: body.confirmed === true,
					}),
				});
			case "cancel-batch":
				return Response.json({
					batch: await batches.cancelBatch({ root, projectId, id: body.id }),
				});
			case "setup":
				await vault.setup({ root: root, pin: body.pin, key: body.apiKey });
				return Response.json({ ok: true });
			case "unlock":
				await vault.unlock({ root: root, pin: body.pin });
				await provider.resume({ root: root, projectId: projectId });
				return Response.json({ ok: true });
			case "lock":
				vault.lock(root);
				return Response.json({ ok: true });
			case "prepare":
				if (body.request?.projectId !== projectId)
					throw new Error("Project scope mismatch");
				if (
					body.request?.kind === "storyboard" &&
					body.request?.model === CHATGPT_STORYBOARD_MODEL
				)
					throw new Error(
						"Image generation is unavailable through the POCUT Agent ChatGPT connection.",
					);
				return Response.json({
					job: await provider.prepare({
						root: root,
						raw: body.request,
						referenceUrl: (r) => share({ projectId: projectId, reference: r }),
					}),
				});
			case "approve":
				if (body.confirmed !== true)
					throw new Error("Human confirmation required");
				return Response.json({
					job: await provider.approve({
						root: root,
						projectId: projectId,
						jobId: body.id,
						pin: body.pin,
						digest: body.digest,
						authorizeChatGpt: async () => {
							throw new Error(
								"Image generation is unavailable through the POCUT Agent ChatGPT connection.",
							);
						},
					}),
				});
			case "reject":
				return Response.json({
					job: await provider.reject({
						root: root,
						projectId: projectId,
						jobId: body.id,
					}),
				});
			default:
				throw new Error("Unsupported Director operation");
		}
	} catch (e) {
		return Response.json(
			{
				error:
					e instanceof Error
						? e.message
						: "Director operation failed; no automatic paid retry",
			},
			{ status: 400 },
		);
	}
});
