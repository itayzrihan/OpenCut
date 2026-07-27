/* eslint-disable opencut/prefer-object-params -- Route helpers mirror URL parameter access. */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import {
	assertLocalDriveRequest,
	getFontFile,
	storeUploadedFont,
} from "@/services/local-drive/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function required(searchParams: URLSearchParams, key: string): string {
	const value = searchParams.get(key);
	if (!value) throw new Error(`${key} is required`);
	return value;
}

export async function GET(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const url = new URL(request.url);
		const file = await getFontFile(
			required(url.searchParams, "projectId"),
			required(url.searchParams, "id"),
		);
		if (!file) return new NextResponse(null, { status: 404 });
		return new NextResponse(
			Readable.toWeb(createReadStream(file.path)) as unknown as BodyInit,
			{
				headers: {
					"Cache-Control": "private, no-cache",
					"Content-Length": String(file.stat.size),
					"Content-Type": file.record.mimeType || "application/octet-stream",
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
		const url = new URL(request.url);
		if (!request.body) throw new Error("Font request body is required");
		const storedPath = await storeUploadedFont({
			projectId: required(url.searchParams, "projectId"),
			fontId: required(url.searchParams, "id"),
			fileName: required(url.searchParams, "fileName"),
			body: request.body,
		});
		return NextResponse.json({ storedPath });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
