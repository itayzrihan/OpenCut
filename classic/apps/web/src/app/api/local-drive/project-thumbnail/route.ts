import { NextResponse } from "next/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import {
	assertLocalDriveRequest,
	getProjectThumbnail,
} from "@/services/local-drive/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(request: Request, includeBody: boolean) {
	assertLocalDriveRequest(request);
	const projectId = new URL(request.url).searchParams.get("projectId");
	if (!projectId) throw new Error("projectId is required");
	const file = await getProjectThumbnail(projectId);
	if (!file) return new NextResponse(null, { status: 404 });

	const entityTag = `"${file.stat.size}-${Math.trunc(file.stat.mtimeMs)}"`;
	const headers = new Headers({
		"Cache-Control": "private, max-age=31536000, immutable",
		"Content-Length": String(file.stat.size),
		"Content-Type": file.mimeType,
		ETag: entityTag,
		"Last-Modified": new Date(file.stat.mtimeMs).toUTCString(),
	});
	if (!includeBody) return new NextResponse(null, { headers });
	return new NextResponse(
		createCancellationSafeFileStream({
			path: file.path,
			start: 0,
			end: file.stat.size - 1,
		}),
		{ headers },
	);
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
