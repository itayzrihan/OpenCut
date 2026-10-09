import {
	withAccount,
	canImportLegacy,
	accountDataRoot,
	importLocked,
	requireAccount,
} from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { mkdir, rename, writeFile, stat } from "node:fs/promises";
import { inspectLegacyImport } from "@/accounts/migration";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const CHUNK = 8 * 1024 * 1024;
async function handle(request: Request) {
	try {
		if (!(await canImportLegacy()))
			throw new Error("This account does not own the legacy browser import");
		if (await importLocked(requireAccount().id))
			throw new Error("Wait for the current storage operation to finish");
		const url = new URL(request.url),
			run = url.searchParams.get("run"),
			id = url.searchParams.get("id");
		if (!run || !/^[a-f0-9-]{36}$/.test(run))
			throw new Error("Invalid browser archive identifier");
		const root = join(accountDataRoot(), "browser-archives", run);
		if (
			!(await stat(root)
				.then(() => true)
				.catch((error) => {
					if (error.code === "ENOENT") return false;
					throw error;
				}))
		) {
			const imported = await stat(
				join(accountDataRoot(), "migration-receipt.json"),
			)
				.then(() => true)
				.catch((error) => {
					if (error.code === "ENOENT") return false;
					throw error;
				});
			if (!imported && (await inspectLegacyImport()).files)
				throw new Error(
					"Complete the drive import before copying browser data",
				);
		}
		await mkdir(join(root, "objects"), { recursive: true });
		if (request.method === "POST") {
			const raw = await readBoundedBody({ request: request, maximumBytes: 128 * 1024 * 1024 }),
				manifest = JSON.parse(new TextDecoder().decode(raw));
			if (manifest.format !== "opencut-browser-archive-v1")
				throw new Error("Invalid browser archive manifest");
			await writeFile(join(root, "manifest.json"), Buffer.from(raw), {
				flag: "wx",
			});
			return Response.json({ verified: true, run });
		}
		if (!id || !/^[a-f0-9-]{36}$/.test(id) || !request.body)
			throw new Error("Invalid browser archive object");
		let bytes = 0,
			chunkBytes = 0,
			hash = createHash("sha256");
		const chunks: string[] = [];
		const verify = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				bytes += chunk.length;
				if (bytes > 128 * 1024 ** 3) {
					done(new Error("Browser archive object exceeds 128 GiB"));
					return;
				}
				for (let offset = 0; offset < chunk.length; ) {
					const length = Math.min(CHUNK - chunkBytes, chunk.length - offset);
					hash.update(chunk.subarray(offset, offset + length));
					offset += length;
					chunkBytes += length;
					if (chunkBytes === CHUNK) {
						chunks.push(hash.digest("hex"));
						hash = createHash("sha256");
						chunkBytes = 0;
					}
				}
				done(null, chunk);
			},
		});
		const target = join(root, "objects", id),
			temporary = `${target}.partial`;
		await pipeline(
			Readable.fromWeb(request.body as never),
			verify,
			createWriteStream(temporary, { flags: "wx" }),
			{ signal: request.signal },
		);
		if (chunkBytes) chunks.push(hash.digest("hex"));
		await rename(temporary, target);
		await writeFile(
			`${target}.receipt.json`,
			JSON.stringify({ bytes, chunks }),
			{ flag: "wx" },
		);
		return Response.json({ bytes, chunks });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
export const PUT = withAccount(handle);
export const POST = withAccount(handle);
