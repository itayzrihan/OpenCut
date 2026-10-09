import { stat } from "node:fs/promises";
import { withAccount } from "@/accounts/server";
import { assertLocalDriveRequest } from "@/services/local-drive/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import {
	cancelProxy,
	prepareProxy,
	proxySource,
	proxyStatus,
} from "@/services/video-proxy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
	try {
		assertLocalDriveRequest(request);
		const url = new URL(request.url);
		const origin = request.headers.get("origin");
		if (origin && origin !== url.origin)
			return new Response(null, { status: 403 });
		const source = await proxySource({
			projectId: url.searchParams.get("projectId") ?? "",
			mediaId: url.searchParams.get("id") ?? "",
		});
		if (request.method === "DELETE") {
			cancelProxy(source);
			return Response.json({ status: "cancelled" });
		}
		const status =
			request.method === "POST"
				? await prepareProxy(source)
				: await proxyStatus(source);
		if (url.searchParams.get("content") !== "1" || request.method === "POST")
			return Response.json({ status, key: source.key });
		if (status !== "ready" || url.searchParams.get("key") !== source.key)
			return new Response(null, { status: 404 });
		const info = await stat(source.path);
		const range = request.headers.get("range");
		const match = range?.match(/^bytes=(\d+)-(\d*)$/);
		if (range && !match) return new Response(null, { status: 416 });
		const start = match ? Number(match[1]) : 0;
		const end = match?.[2]
			? Math.min(Number(match[2]), info.size - 1)
			: info.size - 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start > end ||
			start < 0
		)
			return new Response(null, { status: 416 });
		return new Response(
			request.method === "HEAD"
				? null
				: createCancellationSafeFileStream({ path: source.path, start, end }),
			{
				status: match ? 206 : 200,
				headers: {
					"Content-Type": "video/mp4",
					"Accept-Ranges": "bytes",
					"Content-Length": String(end - start + 1),
					...(match
						? { "Content-Range": `bytes ${start}-${end}/${info.size}` }
						: {}),
				},
			},
		);
	} catch {
		return Response.json({ status: "unavailable" }, { status: 400 });
	}
}

export const GET = withAccount(handle);
export const HEAD = withAccount(handle);
export const POST = withAccount(handle);
export const DELETE = withAccount(handle);
