import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { handleEarshotRepository } from "../earshot-repository";
const original = process.cwd();
const root = await mkdtemp(join(tmpdir(), "earshot-repository-"));
const vendor = join(root, "vendor/earshot");
await mkdir(join(root, "apps/web"), { recursive: true });
await mkdir(join(vendor, "upstream"), { recursive: true });
const content = "Earshot reference\nrender(params, r)\n";
await writeFile(join(vendor, "upstream/README.md"), content);
const unicode = "x".repeat(11999) + "שלום עולם";
await writeFile(join(vendor, "upstream/unicode.md"), unicode);
await writeFile(
	join(vendor, "manifest.json"),
	JSON.stringify([
		{
			path: "README.md",
			size: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		},
		{
			path: "unicode.md",
			size: Buffer.byteLength(unicode),
			sha256: createHash("sha256").update(unicode).digest("hex"),
		},
	]),
);
process.chdir(join(root, "apps/web"));
afterAll(async () => {
	process.chdir(original);
	await rm(root, { recursive: true, force: true });
});
const read = (query: string) =>
	handleEarshotRepository(
		new Request(`http://localhost/api/earshot/repository?${query}`),
	);
test("indexes and reads exact pinned source with provenance", async () => {
	const list = await (await read("operation=list")).json();
	expect(list.files.slice(0, 1)).toEqual([
		{ path: "README.md", size: Buffer.byteLength(content) },
	]);
	const file = await (await read("operation=read&path=README.md")).json();
	expect(file.content).toBe(content);
	expect(file.sha256).toHaveLength(64);
	expect(file.nextOffset).toBeNull();
});
test("rejects traversal and unknown source paths", async () => {
	expect((await read("operation=read&path=../../secret")).status).toBe(400);
	expect((await read("operation=read&path=/etc/passwd")).status).toBe(400);
});
test("literal search and byte pagination stay bounded", async () => {
	const search = await (await read("operation=search&query=render")).json();
	expect(search.matches[0].line).toBe(2);
	const page = await (
		await read("operation=read&path=README.md&offset=8")
	).json();
	expect(page.content).toBe(content.slice(8));
	expect((await read("operation=read&path=README.md&offset=-1")).status).toBe(
		400,
	);
});
test("UTF-8 pagination never splits a multibyte source character", async () => {
	const first = await (await read("operation=read&path=unicode.md")).json();
	expect(first.nextOffset).toBe(11999);
	const second = await (
		await read(`operation=read&path=unicode.md&offset=${first.nextOffset}`)
	).json();
	expect(first.content + second.content).toBe(unicode);
	expect(
		(await read("operation=read&path=unicode.md&offset=12000")).status,
	).toBe(400);
});
test("changed vendored files fail integrity validation", async () => {
	await writeFile(join(vendor, "upstream/README.md"), "tampered");
	expect((await read("operation=read&path=README.md")).status).toBe(400);
});
