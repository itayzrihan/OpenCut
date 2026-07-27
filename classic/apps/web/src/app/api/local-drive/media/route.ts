/* eslint-disable opencut/prefer-object-params -- HTTP range helpers mirror protocol parameters. */
import { NextResponse } from "next/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import {
	assertLocalDriveRequest,
	getMediaFile,
	storeUploadedMedia,
} from "@/services/local-drive/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function required(searchParams: URLSearchParams, key: string): string {
	const value = searchParams.get(key);
	if (!value) throw new Error(`${key} is required`);
	return value;
}

function parseRange(rangeHeader: string | null, size: number) {
	if (!rangeHeader) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match) return null;
	let start = match[1] ? Number(match[1]) : 0;
	let end = match[2] ? Number(match[2]) : size - 1;
	if (!match[1] && match[2]) {
		const suffixLength = Number(match[2]);
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	}
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0)
		return null;
	end = Math.min(end, size - 1);
	if (start > end || start >= size) return { invalid: true as const };
	return { start, end, invalid: false as const };
}

async function serve(request: Request, includeBody: boolean) {
	assertLocalDriveRequest(request);
	const url = new URL(request.url);
	const projectId = required(url.searchParams, "projectId");
	const mediaId = required(url.searchParams, "id");
	const file = await getMediaFile(projectId, mediaId);
	if (!file) return new NextResponse(null, { status: 404 });

	const range = parseRange(request.headers.get("range"), file.stat.size);
	if (range?.invalid) {
		return new NextResponse(null, {
			status: 416,
			headers: { "Content-Range": `bytes */${file.stat.size}` },
		});
	}
	const start = range?.start ?? 0;
	const end = range?.end ?? file.stat.size - 1;
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, no-cache",
		"Content-Length": String(Math.max(0, end - start + 1)),
		"Content-Type": file.record.mimeType || "application/octet-stream",
		"Last-Modified": new Date(file.stat.mtimeMs).toUTCString(),
	});
	if (range)
		headers.set("Content-Range", `bytes ${start}-${end}/${file.stat.size}`);
	if (!includeBody)
		return new NextResponse(null, { status: range ? 206 : 200, headers });
	const stream = createCancellationSafeFileStream({
		path: file.path,
		start,
		end,
	});
	return new NextResponse(stream, {
		status: range ? 206 : 200,
		headers,
	});
}

export async function GET(request: Request) {
	try {
		return await serve(request, true);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}

export async function HEAD(request: Request) {
	try {
		return await serve(request, false);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}

export async function POST(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const url = new URL(request.url);
		const body = request.body;
		if (!body) throw new Error("Media request body is required");
		const size = Number(required(url.searchParams, "size"));
		if (!Number.isFinite(size) || size < 0)
			throw new Error("Invalid media size");
		await storeUploadedMedia({
			projectId: required(url.searchParams, "projectId"),
			mediaId: required(url.searchParams, "id"),
			fileName: required(url.searchParams, "fileName"),
			mimeType: url.searchParams.get("mimeType") || "application/octet-stream",
			lastModified: Number(url.searchParams.get("lastModified")) || Date.now(),
			size,
			body,
			allowLargeCopy: url.searchParams.get("migration") === "1",
		});
		return NextResponse.json({ ok: true });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
