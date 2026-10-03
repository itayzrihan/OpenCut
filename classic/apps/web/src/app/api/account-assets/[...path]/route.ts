import { stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { accountDataRoot, withAccount } from "@/accounts/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import { readByteRange } from "@/services/local-drive/http-range";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const types: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".webm": "audio/webm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };
const serve = withAccount(async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
	const { path } = await context.params;
	if (!path.length || !["shared-library", "project-fonts"].includes(path[0]) || path.some((part) => !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(part))) return new Response(null, { status: 404 });
	const file = join(accountDataRoot(), ...path);
	const type = types[extname(file).toLowerCase()];
	if (!type) return new Response(null, { status: 404 });
	try {
		const info = await stat(file);
		if (!info.isFile()) return new Response(null, { status: 404 });
		const range = readByteRange(request.headers.get("range"), info.size);
		if (range?.invalid) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
		const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
		const headers = new Headers({ "Content-Type": type, "Content-Length": String(Math.max(0, end - start + 1)), "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" });
		if (range) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
		return new Response(request.method === "HEAD" || info.size === 0 ? null : createCancellationSafeFileStream({ path: file, start, end }), { status: range ? 206 : 200, headers });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response(null, { status: 404 });
		throw error;
	}
});
export const GET = serve;
export const HEAD = serve;
