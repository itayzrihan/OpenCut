/** Host IO adapter: bounded, immutable, allowlisted upstream context. No user paths or execution. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const REVISION = "591fa3e028032e6dce56620a20e932e35667e8d8";
interface Entry {
	path: string;
	size: number;
	sha256: string;
}
let loaded: Promise<{ root: string; files: Entry[] }> | undefined;
async function repository() {
	return (loaded ??= (async () => {
		const root = resolve(process.cwd(), "../../vendor/earshot");
		const raw: unknown = JSON.parse(
			await readFile(join(root, "manifest.json"), "utf8"),
		);
		const entries: unknown = Array.isArray(raw)
			? raw
			: typeof raw === "object" && raw !== null && "files" in raw
				? raw.files
				: undefined;
		if (!Array.isArray(entries) || entries.length > 2000)
			throw new Error("Invalid pinned Earshot manifest");
		const files: Entry[] = entries.map((entry: unknown) => {
			if (
				typeof entry !== "object" ||
				entry === null ||
				!("path" in entry) ||
				typeof entry.path !== "string" ||
				!entry.path ||
				entry.path.startsWith("/") ||
				entry.path.split("/").includes("..") ||
				!("size" in entry) ||
				typeof entry.size !== "number" ||
				!Number.isSafeInteger(entry.size) ||
				entry.size < 0 ||
				!("sha256" in entry) ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.sha256)
			)
				throw new Error("Invalid pinned Earshot manifest");
			return { path: entry.path, size: entry.size, sha256: entry.sha256 };
		});
		return { root, files };
	})());
}
async function content(path: string) {
	const { root, files } = await repository();
	const entry = files.find((f) => f.path === path);
	if (!entry)
		throw new Error("Choose an exact path from the pinned repository index");
	const data = await readFile(join(root, "upstream", entry.path));
	if (
		data.length !== entry.size ||
		createHash("sha256").update(data).digest("hex") !== entry.sha256
	)
		throw new Error("Earshot source integrity check failed");
	return { entry, data };
}
export async function handleEarshotRepository(
	request: Request,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const operation = url.searchParams.get("operation") ?? "list";
		const path = url.searchParams.get("path") ?? "";
		const offset = Number(url.searchParams.get("offset") ?? 0);
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new Error("Invalid byte offset");
		const { files } = await repository();
		if (operation === "list")
			return Response.json({
				revision: REVISION,
				files: files
					.slice(offset, offset + 80)
					.map((f) => ({ path: f.path, size: f.size })),
				total: files.length,
				nextOffset: offset + 80 < files.length ? offset + 80 : null,
			});
		if (operation === "read") {
			const { entry, data } = await content(path);
			const binary = data.includes(0);
			if (offset > data.length) throw new Error("Offset is outside the file");
			if (!binary && offset < data.length && (data[offset] & 0xc0) === 0x80)
				throw new Error("Offset must begin at a UTF-8 character boundary");
			let end = Math.min(offset + 12000, data.length);
			if (!binary)
				while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
			const chunk = data.subarray(offset, end);
			return Response.json({
				revision: REVISION,
				path: entry.path,
				sha256: entry.sha256,
				offset,
				totalBytes: data.length,
				nextOffset:
					offset + chunk.length < data.length ? offset + chunk.length : null,
				encoding: binary ? "base64" : "utf8",
				content: chunk.toString(binary ? "base64" : "utf8"),
			});
		}
		if (operation === "search") {
			const query = url.searchParams.get("query") ?? "";
			if (!query.trim() || query.length > 200)
				throw new Error("Search needs 1–200 characters");
			const matches: Array<{ path: string; line: number; text: string }> = [];
			for (const file of files) {
				if (path && !file.path.startsWith(path)) continue;
				if (file.size > 2000000) continue;
				const { data } = await content(file.path);
				if (data.includes(0)) continue;
				const lines = data.toString("utf8").split("\n");
				for (let i = 0; i < lines.length; i++)
					if (lines[i].toLowerCase().includes(query.toLowerCase())) {
						matches.push({
							path: file.path,
							line: i + 1,
							text: lines[i].slice(0, 300),
						});
						if (matches.length === 30)
							return Response.json({
								revision: REVISION,
								matches,
								truncated: true,
							});
					}
			}
			return Response.json({ revision: REVISION, matches, truncated: false });
		}
		throw new Error("Unsupported repository operation");
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : "Repository read failed",
			},
			{ status: 400 },
		);
	}
}
