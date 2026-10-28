import { withAccount } from "@/accounts/server";
import { assertLocalDriveRequest } from "@/services/local-drive/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import {
	readRenderJob,
	renderSource,
	renderJobDirectory,
	reportRender,
} from "@/export/queue/server";
import { open, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function serve(request: Request, head = false) {
	try {
		assertLocalDriveRequest(request);
		const query = new URL(request.url).searchParams;
		const id = query.get("job") ?? "";
		const kind = query.get("kind");
		let path: string,
			size: number,
			mimeType: string,
			filename: string | undefined;
		if (kind === "media" || kind === "font") {
			const source = await renderSource(id, query.get("id") ?? "", kind);
			({ path, size, mimeType } = source);
		} else {
			const job = await readRenderJob(id);
			if (job.status !== "completed") throw Error("Render is not complete");
			path = join(renderJobDirectory(id), `output.${job.options.format}`);
			size = (await stat(path)).size;
			mimeType = job.options.format === "mp4" ? "video/mp4" : "video/webm";
			filename = `${job.snapshot.document.metadata.name}-${job.sceneId}.${job.options.format}`;
		}
		const range = request.headers.get("range");
		let start = 0,
			end = size - 1,
			status = 200;
		if (range) {
			const m = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!m || (!m[1] && !m[2])) throw Error("Invalid byte range");
			start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
			end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
			if (start > end || start >= size)
				return new NextResponse(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${size}` },
				});
			status = 206;
		}
		const headers = new Headers({
			"Content-Type": mimeType,
			"Content-Length": String(end - start + 1),
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
		});
		if (status === 206)
			headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		if (filename)
			headers.set(
				"Content-Disposition",
				`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
			);
		return new NextResponse(
			head ? null : createCancellationSafeFileStream({ path, start, end }),
			{ status, headers },
		);
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 400 },
		);
	}
}
async function put(request: Request) {
	let temp: string | undefined;
	try {
		assertLocalDriveRequest(request);
		const q = new URL(request.url).searchParams;
		const id = q.get("job") ?? "",
			attempt = q.get("attempt") ?? "";
		const job = await readRenderJob(id);
		if (
			job.status !== "rendering" ||
			job.attempt !== attempt ||
			job.cancelRequested
		)
			throw Error("Render attempt no longer owns the output");
		const expected = Number(request.headers.get("content-length"));
		if (
			!request.body ||
			!Number.isSafeInteger(expected) ||
			expected <= 0 ||
			expected > 250 * 1024 ** 3
		)
			throw Error("Invalid render output size");
		const final = join(renderJobDirectory(id), `output.${job.options.format}`);
		temp = join(renderJobDirectory(id), `output-${attempt}.part`);
		const file = await open(temp, "wx", 0o600);
		let size = 0;
		try {
			const reader = request.body.getReader();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					size += next.value.byteLength;
					if (size > expected)
						throw Error("Render upload exceeds expected size");
					await file.writeFile(next.value);
				}
				if (size !== expected) throw Error("Render upload was interrupted");
				await file.sync();
			} finally {
				reader.releaseLock();
			}
		} finally {
			await file.close();
		}
		const current = await readRenderJob(id);
		if (
			current.attempt !== attempt ||
			current.status !== "rendering" ||
			current.cancelRequested
		)
			throw Error("Render output was cancelled");
		await rename(temp, final);
		temp = undefined;
		const receipt = await reportRender({
			id,
			projectId: job.projectId,
			attempt,
			progress: 1,
			message: "Complete",
			status: "completed",
		});
		return NextResponse.json(receipt);
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 400 },
		);
	} finally {
		if (temp) await unlink(temp).catch(() => {});
	}
}
export const GET = withAccount((request) => serve(request));
export const HEAD = withAccount((request) => serve(request, true));
export const PUT = withAccount(put);
