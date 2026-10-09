import { readFile, stat } from "node:fs/promises";
import { replaceProjectRecord } from "@/services/local-drive/project-transaction";

/** Renewal journal, anchored to the exact atomic project file. It can extend
 * time only; acquire/release/commit still replace the canonical project record.
 * Every caller must hold the existing process-safe project storage lock. */
export async function projectFileIdentity(path: string): Promise<string> {
	const info = await stat(path, { bigint: true });
	return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function readRenewal({
	path,
	identity,
}: {
	path: string;
	identity: string;
}): Promise<string | null> {
	try {
		const file = `${path}.renewal.json`;
		if ((await stat(file)).size > 1_000_000)
			throw new Error("Invalid renewal journal size");
		const journal = JSON.parse(await readFile(file, "utf8"));
		if (journal.identity !== identity) return null;
		if (
			journal.version !== 1 ||
			typeof journal.record !== "string" ||
			JSON.parse(journal.record).saved !== null
		)
			throw new Error("Invalid renewal journal");
		return journal.record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function metadataOnly(record: string): string {
	return JSON.stringify({ ...JSON.parse(record), saved: null });
}

export async function mergeRenewal({
	path,
	record,
}: {
	path: string;
	record: string;
}): Promise<string> {
	const renewal = await readRenewal({
		path,
		identity: await projectFileIdentity(path),
	});
	if (!renewal) return record;
	const original = JSON.parse(record),
		metadata = JSON.parse(renewal);
	// A journal never owns edits or changes a fence/revision. Rust checks scope,
	// expiry, monotonic time and authority again for the actual operation.
	for (const key of [
		"schemaVersion",
		"accountId",
		"projectId",
		"generation",
		"storageRevision",
	])
		if (metadata[key] !== original[key])
			throw new Error("Renewal journal does not match project");
	return JSON.stringify({ ...metadata, saved: original.saved });
}

export async function writeRenewal({
	path,
	identity,
	record,
	assertLock,
}: {
	path: string;
	identity: string;
	record: string;
	assertLock: () => void;
}) {
	if ((await projectFileIdentity(path)) !== identity)
		throw new Error("Project changed during renewal");
	await replaceProjectRecord({
		path: `${path}.renewal.json`,
		value: { version: 1, identity, record },
		assertLock,
	});
}
