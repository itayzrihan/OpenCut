import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { withAccount } from "@/accounts/server";
import { globalAudioFile } from "@/shared-library/global-library";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import { readByteRange } from "@/services/local-drive/http-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const types: Record<string, string> = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".aif": "audio/aiff",
	".aiff": "audio/aiff",
	".webm": "audio/webm",
};
const serve = withAccount(
	async (
		request: Request,
		context: { params: Promise<{ path: string[] }> },
	) => {
		const file = await globalAudioFile((await context.params).path);
		if (!file) return new Response(null, { status: 404 });
		const type = types[extname(file).toLowerCase()];
		if (!type) return new Response(null, { status: 404 });
		const info = await stat(file);
		const range = readByteRange({
			header: request.headers.get("range"),
			size: info.size,
		});
		if (range?.invalid)
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${info.size}` },
			});
		const start = range?.start ?? 0,
			end = range?.end ?? info.size - 1;
		const headers = new Headers({
			"Content-Type": type,
			"Content-Length": String(Math.max(0, end - start + 1)),
			"Accept-Ranges": "bytes",
			"Content-Security-Policy": "sandbox",
		});
		if (range)
			headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
		return new Response(
			request.method === "HEAD" || info.size === 0
				? null
				: createCancellationSafeFileStream({ path: file, start, end }),
			{ status: range ? 206 : 200, headers },
		);
	},
);
export const GET = serve;
export const HEAD = serve;
