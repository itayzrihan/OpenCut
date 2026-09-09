/* eslint-disable opencut/prefer-object-params -- Route helpers mirror URL parameter access. */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import {
	assertLocalDriveRequest,
	getSharedFile,
	storeSharedFile,
} from "@/services/local-drive/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function required(params: URLSearchParams, key: string): string {
	const value = params.get(key);
	if (!value) throw new Error(`${key} is required`);
	return value;
}

export async function GET(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const params = new URL(request.url).searchParams;
		const file = await getSharedFile(
			required(params, "kind"),
			required(params, "id"),
		);
		if (!file) return new NextResponse(null, { status: 404 });
		const etag = `W/"${file.stat.size}-${Math.trunc(file.stat.mtimeMs)}"`;
		if (request.headers.get("if-none-match") === etag) {
			return new NextResponse(null, {
				status: 304,
				headers: { ETag: etag },
			});
		}
		return new NextResponse(
			Readable.toWeb(createReadStream(file.path)) as unknown as BodyInit,
			{
				headers: {
					"Cache-Control": "private, max-age=31536000, immutable",
					"Content-Length": String(file.stat.size),
					"Content-Type": params.get("mimeType") || "application/octet-stream",
					ETag: etag,
				},
			},
		);
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
		if (!request.body) throw new Error("File request body is required");
		const params = new URL(request.url).searchParams;
		await storeSharedFile({
			kind: required(params, "kind"),
			id: required(params, "id"),
			body: request.body,
		});
		return NextResponse.json({ ok: true });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
