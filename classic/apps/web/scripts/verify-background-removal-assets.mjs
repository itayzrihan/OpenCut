import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(appRoot, "public");
const manifestPath = resolve(publicRoot, "background-removal-assets.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];

for (const asset of manifest.assets) {
	const assetPath = resolve(publicRoot, asset.path);
	if (
		assetPath !== publicRoot &&
		!assetPath.startsWith(`${publicRoot}\\`) &&
		!assetPath.startsWith(`${publicRoot}/`)
	) {
		failures.push(`${asset.path}: path escapes the public directory`);
		continue;
	}

	try {
		const assetStat = await stat(assetPath);
		if (assetStat.size !== asset.bytes) {
			failures.push(
				`${asset.path}: expected ${asset.bytes} bytes, found ${assetStat.size}`,
			);
			continue;
		}

		const hash = createHash("sha256");
		for await (const chunk of createReadStream(assetPath)) {
			hash.update(chunk);
		}
		const digest = hash.digest("hex");
		if (digest !== asset.sha256) {
			failures.push(
				`${asset.path}: expected SHA-256 ${asset.sha256}, found ${digest}`,
			);
		}
	} catch (error) {
		failures.push(
			`${asset.path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`background-removal asset verification failed: ${failure}`);
	}
	process.exitCode = 1;
} else {
	console.log(
		`verified ${manifest.assets.length} background-removal assets for ${manifest.model.id}`,
	);
}
