import { join } from "node:path";
import {
	withAccount,
	accountDataRoot,
	assertLocalOrigin,
} from "@/accounts/server";
import { requestBytes } from "@/generative/server/request";
import * as vault from "@/generative/server/vault";
import * as files from "@/generative/server/store";
import {
	audioJobs,
	prepareAudio,
	approveAudio,
	cancelAudio,
	audioCatalog,
} from "@/audio-production/server";
export const runtime = "nodejs";
const failure = (e: unknown) =>
	Response.json(
		{ error: e instanceof Error ? e.message : "Audio request failed" },
		{ status: 400 },
	);
export const GET = withAccount(async (request: Request) => {
	try {
		const url = new URL(request.url),
			projectId = files.validProject(url.searchParams.get("projectId") ?? ""),
			root = join(accountDataRoot(), "audio-production");
		const id = url.searchParams.get("file");
		if (id) {
			const file = await files.fileBytes({ root, projectId, fileId: id });
			return new Response(new Uint8Array(file.bytes), {
				headers: {
					"Content-Type": file.info.mime,
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}
		if (url.searchParams.get("catalog") === "1")
			return Response.json(await audioCatalog({ root }));
		return Response.json({
			configured: await vault.configured(root),
			sessionSeconds: vault.seconds(root),
			jobs: await audioJobs({ root, projectId }),
		});
	} catch (e) {
		return failure(e);
	}
});
export const POST = withAccount(async (request: Request) => {
	try {
		assertLocalOrigin(request);
		const body = JSON.parse(
				new TextDecoder().decode(await requestBytes({ request, limit: 65536 })),
			),
			root = join(accountDataRoot(), "audio-production"),
			projectId = files.validProject(body.projectId ?? "");
		switch (body.action) {
			case "setup":
				await vault.setup({ root, key: body.apiKey, pin: body.pin });
				return Response.json({ ok: true });
			case "unlock":
				await vault.unlock({ root, pin: body.pin });
				return Response.json({ ok: true });
			case "lock":
				vault.lock(root);
				return Response.json({ ok: true });
			case "prepare":
				return Response.json({
					job: await prepareAudio({
						root,
						projectId,
						operationId: body.operationId,
						draft: body.draft,
					}),
				});
			case "approve":
				return Response.json({
					job: await approveAudio({
						root,
						projectId,
						id: body.id,
						digest: body.digest,
						pin: body.pin,
						confirmed: body.confirmed,
					}),
				});
			case "cancel":
				return Response.json({
					job: await cancelAudio({ root, projectId, id: body.id }),
				});
			default:
				throw new Error("Unsupported audio operation");
		}
	} catch (e) {
		return failure(e);
	}
});
