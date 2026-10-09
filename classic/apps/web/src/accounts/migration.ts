/** Copy-only local-host import. Never mutates the pre-account installation. */
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	constants,
	existsSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	accountDataRoot,
	accountsRoot,
	canImportLegacy,
	requireAccount,
} from "./server";
type Entry = {
	source: string;
	relativePath: string;
	bytes: number;
	mtimeMs: number;
};
type Verified = Entry & { sha256: string };
export function legacyRoot() {
	return resolve(
		process.env.POCUT_PROJECTS_DIR ||
			join(homedir(), "Movies", "PoCut Projects"),
	);
}
function legacyPublicRoot() {
	const portable = join(homedir(), "Movies", "OpenCut Legacy Assets");
	return resolve(
		process.env.OPENCUT_LEGACY_PUBLIC_DIR ||
			(existsSync(portable) ? portable : "") ||
			join(process.cwd(), "../../../.local/legacy-public"),
	);
}
async function walk({
	root,
	prefix = "",
}: {
	root: string;
	prefix?: string;
}): Promise<Entry[]> {
	const result: Entry[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const source = join(root, entry.name),
			relativePath = join(prefix, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`Symbolic link requires review: ${relativePath}`);
		if (entry.isDirectory())
			result.push(...(await walk({ root: source, prefix: relativePath })));
		else if (entry.isFile()) {
			const info = await stat(source);
			result.push({
				source,
				relativePath,
				bytes: info.size,
				mtimeMs: info.mtimeMs,
			});
		}
	}
	return result;
}
async function optionalWalk({
	root,
	prefix = "",
}: {
	root: string;
	prefix?: string;
}) {
	try {
		return await walk({ root: root, prefix: prefix });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
export async function hashFile({
	path,
	signal,
}: {
	path: string;
	signal?: AbortSignal;
}) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path, { signal }))
		hash.update(bytes);
	return hash.digest("hex");
}
async function copyVerified({
	source,
	target,
	signal,
}: {
	source: string;
	target: string;
	signal?: AbortSignal;
}) {
	const before = await stat(source);
	await pipeline(
		createReadStream(source),
		createWriteStream(target, { flags: "wx" }),
		{ signal },
	);
	const sourceHash = await hashFile({ path: source, signal: signal }),
		targetHash = await hashFile({ path: target, signal: signal }),
		after = await stat(source);
	if (
		sourceHash !== targetHash ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs
	)
		throw new Error(
			`Source changed during import: ${basename(source)}. Staging preserved for recovery.`,
		);
	return { sha256: sourceHash, bytes: before.size, mtimeMs: before.mtimeMs };
}
function contained({ root, name }: { root: string; name: string }) {
	const target = resolve(root, name),
		rel = relative(root, target);
	if (rel.startsWith("..") || isAbsolute(rel) || !rel)
		throw new Error("Invalid migration path");
	return target;
}
async function inventory() {
	if (!(await canImportLegacy()))
		throw new Error(
			"Legacy import belongs to the first account created on this installation",
		);
	const entries = await optionalWalk({ root: legacyRoot() });
	for (const name of ["shared-library", "project-fonts"])
		entries.push(
			...(await optionalWalk({
				root: join(legacyPublicRoot(), name),
				prefix: name,
			})),
		);
	const paths = new Set<string>();
	for (const item of entries) {
		const key = item.relativePath.toLowerCase();
		if (paths.has(key))
			throw new Error(
				`Legacy sources conflict at ${item.relativePath}; review before import`,
			);
		paths.add(key);
	}
	const linked: {
		projectId: string;
		mediaId: string;
		source: string;
		bytes: number;
		mtimeMs: number;
		missing: boolean;
	}[] = [];
	for (const item of entries.filter((e) =>
		/^projects[\\/][^\\/]+[\\/]media[\\/]index\.json$/.test(e.relativePath),
	)) {
		const records = JSON.parse(await readFile(item.source, "utf8"));
		for (const record of records)
			if (!record.unifiedAngles) {
				const source =
					record.storageKind === "linked"
						? record.sourcePath
						: contained({
								root: dirname(dirname(item.source)),
								name:
									record.storedPath ||
									`media/files/${record.id}--${record.fileName || record.name}`,
							});
				const info = await stat(source).catch((error) => {
					if (error.code === "ENOENT") return null;
					throw error;
				});
				if (record.storageKind !== "linked" && info?.isFile()) continue;
				linked.push({
					projectId: item.relativePath.split(/[\\/]/)[1],
					mediaId: record.id,
					source,
					bytes: info?.size ?? record.size ?? 0,
					mtimeMs: info?.mtimeMs ?? 0,
					missing: !info?.isFile(),
				});
			}
	}
	return { entries, linked };
}
export async function inspectLegacyImport() {
	const { entries, linked } = await inventory();
	return {
		projects: entries.filter((e) =>
			/^projects[\\/][^\\/]+[\\/]project\.json$/.test(e.relativePath),
		).length,
		files: entries.length,
		bytes:
			entries.reduce((n, e) => n + e.bytes, 0) +
			linked.reduce((n, e) => n + e.bytes, 0),
		missing: linked
			.filter((e) => e.missing)
			.map((e) => ({
				projectId: e.projectId,
				fileName: basename(e.source),
				source: e.source,
			})),
		source: legacyRoot(),
	};
}
function rewritePrivateUrls(value: unknown): unknown {
	if (
		typeof value === "string" &&
		/^\/(shared-library|project-fonts)\//.test(value)
	)
		return `/api/account-assets${value}`;
	if (Array.isArray(value)) return value.map(rewritePrivateUrls);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				rewritePrivateUrls(item),
			]),
		);
	return value;
}
export async function importLegacyAccount({
	onProgress = () => {},
	signal,
}: {
	onProgress?: (files: number, total: number) => void;
	signal?: AbortSignal;
}) {
	const { entries, linked } = await inventory();
	if (!entries.length) throw new Error("No legacy data found");
	// Offline references are part of the project, not a reason to discard it.
	const missing = linked.filter((item) => item.missing);
	const available = linked.filter((item) => !item.missing);
	const destination = accountDataRoot();
	if ((await optionalWalk({ root: destination })).length)
		throw new Error(
			"Import requires an empty account. Existing account data will not be overwritten.",
		);
	const staging = join(
		accountsRoot(),
		"imports",
		`${requireAccount().id}-${randomUUID()}`,
	);
	await mkdir(staging, { recursive: true });
	const verified: Verified[] = [];
	for (const entry of entries) {
		signal?.throwIfAborted();
		const target = contained({ root: staging, name: entry.relativePath });
		await mkdir(dirname(target), { recursive: true });
		const copied = await copyVerified({
			source: entry.source,
			target: target,
			signal: signal,
		});
		if (entry.bytes !== copied.bytes || entry.mtimeMs !== copied.mtimeMs)
			throw new Error(
				`Source changed during import: ${entry.relativePath}. Staging preserved for recovery.`,
			);
		verified.push({ ...entry, sha256: copied.sha256 });
		onProgress(verified.length, entries.length + available.length);
	}
	for (const entry of available) {
		signal?.throwIfAborted();
		const target = contained({
			root: staging,
			name: join(
				"projects",
				entry.projectId,
				"media",
				"files",
				`${entry.mediaId}--${basename(entry.source)}`,
			),
		});
		await mkdir(dirname(target), { recursive: true });
		const copied = await copyVerified({
			source: entry.source,
			target: target,
			signal: signal,
		});
		if (entry.bytes !== copied.bytes || entry.mtimeMs !== copied.mtimeMs)
			throw new Error("Linked source changed during import");
		const indexPath = join(
			staging,
			"projects",
			entry.projectId,
			"media",
			"index.json",
		);
		const records = JSON.parse(await readFile(indexPath, "utf8"));
		const originalIndex = contained({
			root: staging,
			name: join(
				"migration-originals",
				"projects",
				entry.projectId,
				"media",
				"index.json",
			),
		});
		await mkdir(dirname(originalIndex), { recursive: true });
		await copyFile(indexPath, originalIndex, constants.COPYFILE_EXCL).catch(
			(error) => {
				if (error.code !== "EEXIST") throw error;
			},
		);
		for (const record of records)
			if (record.id === entry.mediaId) {
				record.legacySourcePath = record.sourcePath;
				delete record.sourcePath;
				record.storageKind = "copied";
				record.storedPath = relative(
					join(staging, "projects", entry.projectId),
					target,
				);
			}
		await writeFile(indexPath, JSON.stringify(records));
		verified.push({
			source: entry.source,
			relativePath: relative(staging, target),
			...copied,
		});
		onProgress(verified.length, entries.length + available.length);
	}
	// Retain exact pre-transform JSON for reversibility; only private URL routing changes.
	for (const entry of entries.filter((e) => e.relativePath.endsWith(".json"))) {
		signal?.throwIfAborted();
		const target = contained({ root: staging, name: entry.relativePath }),
			raw = await readFile(target, "utf8");
		const value = JSON.parse(raw),
			updated = rewritePrivateUrls(value);
		if (JSON.stringify(value) !== JSON.stringify(updated)) {
			await mkdir(
				dirname(
					contained({
						root: staging,
						name: join("migration-originals", entry.relativePath),
					}),
				),
				{ recursive: true },
			);
			await copyFile(
				entry.source,
				contained({
					root: staging,
					name: join("migration-originals", entry.relativePath),
				}),
				constants.COPYFILE_EXCL,
			).catch((error) => {
				if (error.code !== "EEXIST") throw error;
			});
			await writeFile(target, JSON.stringify(updated));
		}
	}
	const activated = [];
	for (const entry of await walk({ root: staging }))
		activated.push({
			relativePath: entry.relativePath,
			bytes: entry.bytes,
			sha256: await hashFile({ path: entry.source, signal: signal }),
		});
	await writeFile(
		join(staging, "migration-receipt.json"),
		JSON.stringify(
			{
				version: 2,
				accountId: requireAccount().id,
				importedAt: new Date().toISOString(),
				verified,
				activated,
				missing,
			},
			null,
			2,
		),
		{ flag: "wx" },
	);
	const finalInventory = await inventory();
	if (JSON.stringify(finalInventory) !== JSON.stringify({ entries, linked }))
		throw new Error(
			"Legacy data changed during import; verified staging retained. Retry when editing is stopped.",
		);
	signal?.throwIfAborted();
	// Never remove even an empty destination: retain it under a recoverable name.
	if ((await optionalWalk({ root: destination })).length)
		throw new Error("Account changed during import; verified staging retained");
	await mkdir(dirname(destination), { recursive: true });
	try {
		await rename(destination, `${destination}.before-import-${randomUUID()}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await rename(staging, destination);
	return {
		files: verified.length,
		missing,
		projects: entries.filter((e) =>
			/^projects[\\/][^\\/]+[\\/]project\.json$/.test(e.relativePath),
		).length,
	};
}

/** Recover omitted private assets after projects were already migrated. Only
 * the legacy owner may copy them; existing libraries are never overwritten. */
export async function recoverMissingLegacyAssets({
	publicRoot = legacyPublicRoot(),
	signal,
}: { publicRoot?: string; signal?: AbortSignal } = {}) {
	if (!(await canImportLegacy()))
		throw new Error("Legacy assets belong to the first account");
	const recovered: string[] = [];
	for (const name of ["shared-library", "project-fonts"]) {
		const target = join(accountDataRoot(), name);
		if ((await optionalWalk({ root: target })).length) continue;
		const entries = await optionalWalk({ root: join(publicRoot, name) });
		if (!entries.length) continue;
		const staging = join(
			accountsRoot(),
			"imports",
			`${requireAccount().id}-assets-${randomUUID()}`,
		);
		await mkdir(staging, { recursive: true });
		for (const entry of entries) {
			signal?.throwIfAborted();
			const destination = contained({
				root: staging,
				name: entry.relativePath,
			});
			await mkdir(dirname(destination), { recursive: true });
			await copyVerified({ source: entry.source, target: destination, signal });
			if (entry.relativePath.endsWith(".json")) {
				const value = JSON.parse(await readFile(destination, "utf8"));
				await writeFile(destination, JSON.stringify(rewritePrivateUrls(value)));
			}
		}
		signal?.throwIfAborted();
		if ((await optionalWalk({ root: target })).length)
			throw new Error(
				"Account assets changed during recovery; staged copy retained",
			);
		await mkdir(dirname(target), { recursive: true });
		try {
			await rename(target, `${target}.before-recovery-${randomUUID()}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rename(staging, target);
		recovered.push(name);
	}
	return { recovered };
}
