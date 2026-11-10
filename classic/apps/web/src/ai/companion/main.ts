import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createCompanionServer, validatePairing } from "./server";
import { CodexProvider, ClaudeProvider } from "./native-providers";
import { companionHandler } from "./handler";

if (Number(process.versions.node.split(".")[0]) < 22)
	throw new Error("POCUT AI companion requires Node.js 22 or later");

const pairingFile = process.argv.find(
	(value, index) => index > 1 && !value.startsWith("--"),
);
if (!pairingFile)
	throw new Error(
		"Download POCUT-AI-Pairing.json from Agent settings, then run: node pocut-companion.mjs /path/to/POCUT-AI-Pairing.json",
	);
const pair = validatePairing(JSON.parse(await readFile(pairingFile, "utf8")));
const profile = join(
	process.env.OPENCUT_COMPANION_DATA_DIR ??
		join(homedir(), ".local", "share", "POCUT Companion"),
	createHash("sha256")
		.update(JSON.stringify([pair.origin, pair.accountId]))
		.digest("hex"),
);
await mkdir(profile, { recursive: true, mode: 0o700 });
if (process.argv.includes("--login-claude")) {
	const child = spawn(
		process.env.OPENCUT_CLAUDE_PATH ?? "claude",
		["auth", "login"],
		{
			stdio: "inherit",
			shell: false,
			env: { ...process.env, CLAUDE_CONFIG_DIR: join(profile, "claude") },
		},
	);
	child.on("error", () => {
		console.error("Install Claude Code CLI before signing in.");
		process.exitCode = 1;
	});
	child.on("exit", (code) => {
		process.exitCode = code ?? 1;
	});
} else {
	const providers = {
		codex: new CodexProvider({
			root: profile,
			executable: process.env.OPENCUT_CODEX_PATH,
		}),
		claude: new ClaudeProvider({
			root: profile,
			executable: process.env.OPENCUT_CLAUDE_PATH,
		}),
	};
	const server = createCompanionServer({
		pair,
		handle: companionHandler({ providers, imageRoot: join(profile, "images") }),
	}).listen(43127, "127.0.0.1", () => {
		console.log(
			`POCUT companion is paired with ${pair.origin}. Return to that workspace to connect a provider. Credentials remain on this device.`,
		);
	});
	const stop = () => {
		providers.codex.close();
		providers.claude.close();
		server.closeAllConnections();
		server.close();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
