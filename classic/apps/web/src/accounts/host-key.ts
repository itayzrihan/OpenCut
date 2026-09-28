/** Persistent host secret. Never derived from a public/default configuration. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { accountsRoot } from "./server";

export function hostCookieSecret(): Buffer {
	const root = accountsRoot(),
		path = join(root, "host-cookie-key");
	mkdirSync(root, { recursive: true });
	try {
		writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const key = readFileSync(path);
	if (key.length !== 32)
		throw new Error(
			"Host cookie key is invalid. Restore it from your account backup.",
		);
	return key;
}
