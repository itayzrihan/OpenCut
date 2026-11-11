import {
	readFile,
	mkdir,
	writeFile,
	copyFile,
	open,
	rename,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createCompanionServer, validatePairing, type Pairing } from "./server";
import {
	COMPANION_URL,
	SETUP_HEADER,
	SETUP_LIFETIME_MS,
	SETUP_PATH,
	companionSetupSchema,
	type CompanionSetup,
} from "./setup";
import { CodexProvider, ClaudeProvider } from "./native-providers";
import { companionHandler } from "./handler";

const dataRoot =
	process.env.OPENCUT_COMPANION_DATA_DIR ??
	join(homedir(), ".local", "share", "POCUT Companion");
const localAddress = new URL(COMPANION_URL);

function providerProfile(pair: Pairing) {
	return join(
		dataRoot,
		createHash("sha256")
			.update(JSON.stringify([pair.origin, pair.accountId]))
			.digest("hex"),
	);
}

async function readInstalledPair(path: string) {
	try {
		return validatePairing(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

async function isReady(setup: CompanionSetup) {
	try {
		const response = await fetch(COMPANION_URL + SETUP_PATH, {
			headers: { Origin: setup.origin, [SETUP_HEADER]: setup.setupId },
			signal: AbortSignal.timeout(500),
			redirect: "error",
		});
		return response.ok && (await response.json()).setupId === setup.setupId;
	} catch {
		return false;
	}
}

async function install({
	setup,
	directory,
}: {
	setup: CompanionSetup;
	directory: string;
}) {
	if (await isReady(setup)) return;
	if (
		Date.now() >= setup.expiresAt &&
		!(await readInstalledPair(join(directory, "paired.json")))
	)
		throw new Error(
			"This package expired. Download fresh pairing instructions from POCUT.",
		);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	const executable = join(directory, "pocut-companion.mjs");
	const source = fileURLToPath(import.meta.url);
	if (source !== executable) await copyFile(source, executable);
	const config = join(directory, "POCUT-Setup.json");
	await writeFile(config, JSON.stringify(setup), { mode: 0o600 });
	const log = await open(join(directory, "companion.log"), "a", 0o600);
	try {
		const child = spawn(process.execPath, [executable, config], {
			detached: true,
			stdio: ["ignore", log.fd, log.fd],
		});
		let exited = false;
		child.once("error", () => {
			exited = true;
		});
		child.once("exit", () => {
			exited = true;
		});
		child.unref();
		for (let attempt = 0; attempt < 30 && !exited; attempt++) {
			if (await isReady(setup)) return;
			await delay(150);
		}
		if (await isReady(setup)) return;
		throw new Error(
			"Could not start the local companion. Check companion.log in the local installation directory and whether an existing companion is using port 43127.",
		);
	} finally {
		await log.close();
	}
}

async function run() {
	if (Number(process.versions.node.split(".")[0]) < 22)
		throw new Error("POCUT AI companion requires Node.js 22 or later");
	const file = process.argv[2];
	if (!file || file.startsWith("--"))
		throw new Error(
			"Download the pairing instructions from POCUT Agent settings.",
		);
	const raw: unknown = JSON.parse(await readFile(file, "utf8"));
	const setup =
		raw && typeof raw === "object" && "setupId" in raw
			? companionSetupSchema.parse(raw)
			: null;
	const directory = setup
		? join(dataRoot, "installations", setup.setupId)
		: null;
	if (setup && directory && process.argv.includes("--install")) {
		await install({ setup, directory });
		console.log(
			"POCUT companion is ready. Return to the original POCUT tab to connect.",
		);
		return;
	}
	if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
	const saved = directory ? join(directory, "paired.json") : null;
	const pair = saved ? await readInstalledPair(saved) : validatePairing(raw);
	if (process.argv.includes("--login-claude")) {
		if (!pair || (setup && setup.origin !== pair.origin))
			throw new Error(
				"Click Check Claude connection in the original POCUT tab first.",
			);
		const profile = providerProfile(pair);
		await mkdir(profile, { recursive: true, mode: 0o700 });
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
		return;
	}
	if (setup && !pair && Date.now() >= setup.expiresAt)
		throw new Error(
			"This package expired. Download fresh pairing instructions from POCUT.",
		);

	function createProviders(pairing: Pairing) {
		const profile = providerProfile(pairing);
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
		return {
			handle: companionHandler({
				providers,
				imageRoot: join(profile, "images"),
			}),
			close: () => {
				providers.codex.close();
				providers.claude.close();
			},
		};
	}

	if (pair)
		await mkdir(providerProfile(pair), { recursive: true, mode: 0o700 });
	let providers = pair ? createProviders(pair) : undefined;
	const restored =
		pair && providers ? { pair, handle: providers.handle } : undefined;
	const server = createCompanionServer(
		setup && saved
			? {
					setup: {
						request: setup,
						restored,
						activate: async (browserPair) => {
							await mkdir(providerProfile(browserPair), {
								recursive: true,
								mode: 0o700,
							});
							const pending = `${saved}.${process.pid}.tmp`;
							await writeFile(pending, JSON.stringify(browserPair), {
								mode: 0o600,
							});
							await rename(pending, saved);
							providers = createProviders(browserPair);
							return providers.handle;
						},
					},
				}
			: restored!,
	).listen(Number(localAddress.port), localAddress.hostname, () => {
		console.log("POCUT companion is listening on this device.");
	});
	const stop = () => {
		providers?.close();
		server.closeAllConnections();
		server.close();
	};
	if (setup && !pair) {
		const expire = setTimeout(
			() => {
				if (!providers) stop();
			},
			Math.max(0, Math.min(setup.expiresAt - Date.now(), SETUP_LIFETIME_MS)),
		);
		expire.unref();
	}
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

await run();
