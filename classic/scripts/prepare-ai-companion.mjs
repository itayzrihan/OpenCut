import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
const directory = join(web, "public/downloads");
mkdirSync(directory, { recursive: true });
const filename = "pocut-companion-v4.mjs";
const result = spawnSync(
	"bun",
	[
		"build",
		"src/ai/companion/main.ts",
		"--target=node",
		"--env=disable",
		`--outfile=public/downloads/${filename}`,
	],
	{ cwd: web, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const bytes = readFileSync(join(directory, filename));
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(
	join(directory, "pocut-companion-v4.json"),
	JSON.stringify(
		{ version: 4, filename, sha256, bytes: bytes.length, nodeMajorMinimum: 22 },
		null,
		2,
	) + "\n",
);
console.log(`POCUT companion v4: ${bytes.length} bytes; SHA-256 ${sha256}`);
