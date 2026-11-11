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
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createCompanionServer, validatePairing, type Pairing } from "./server";
import {
	COMPANION_URL,
	CONTROL_PATH,
	SETUP_HEADER,
	SETUP_LIFETIME_MS,
	SETUP_PATH,
	companionSetupSchema,
	type CompanionSetup,
} from "./setup";
import { CodexProvider, ClaudeProvider } from "./native-providers";
import { companionHandler } from "./handler";
import { desktopIntegration, exists, openLocalManager } from "./desktop";
import { serveManager } from "./management";
import { resolveClientCli } from "../../../public/mcp-install/client-cli.mjs";

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

async function controlToken(directory: string) {
	const file = join(directory, "control.key");
	try {
		await writeFile(file, randomBytes(32).toString("hex"), {
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
	const token = await readFile(file, "utf8");
	if (!/^[a-f0-9]{64}$/.test(token))
		throw new Error("Invalid desktop control key.");
	return token;
}

function localControl({
	directory,
	setup,
	token,
}: {
	directory: string;
	setup: CompanionSetup;
	token: string;
}) {
	const executable = join(directory, "pocut-companion.mjs");
	const config = join(directory, "POCUT-Setup.json");
	const url = COMPANION_URL + CONTROL_PATH;
	const request = (method: "GET" | "POST") =>
		fetch(url, {
			method,
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(800),
			redirect: "error",
		}).catch(() => null);
	const isRunning = async () => (await request("GET"))?.status === 204;
	return {
		executable,
		config,
		isRunning,
		async start() {
			if (await isRunning()) return;
			if (
				Date.now() >= setup.expiresAt &&
				!(await readInstalledPair(join(directory, "paired.json")))
			)
				throw new Error(
					"This package expired. Download fresh pairing instructions from POCUT.",
				);
			const occupied = await fetch(COMPANION_URL + SETUP_PATH, {
				headers: { Origin: setup.origin, [SETUP_HEADER]: setup.setupId },
				signal: AbortSignal.timeout(800),
				redirect: "error",
			}).catch(() => null);
			if (occupied)
				throw new Error(
					"Port 43127 is already in use. Close the previous POCUT companion if it is running, then retry.",
				);
			const log = await open(join(directory, "companion.log"), "a", 0o600);
			try {
				const child = spawn(process.execPath, [executable, config], {
					detached: process.platform !== "win32",
					windowsHide: true,
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
				for (let attempt = 0; attempt < 35 && !exited; attempt++) {
					if (await isRunning()) return;
					await delay(150);
				}
				if (await isRunning()) return;
				throw new Error(
					"Could not start the local companion. Check companion.log in the local installation directory.",
				);
			} finally {
				await log.close();
			}
		},
		async stop() {
			if (!(await isRunning())) return;
			if ((await request("POST"))?.status !== 204)
				throw new Error("Could not stop the local companion.");
			for (let attempt = 0; attempt < 20; attempt++) {
				if (!(await isRunning())) return;
				await delay(100);
			}
			throw new Error("The local companion is still running.");
		},
	};
}

async function manageInstallation({
	setup,
	directory,
	install,
	start,
}: {
	setup: CompanionSetup;
	directory: string;
	install: boolean;
	start: boolean;
}) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const control = localControl({
		directory,
		setup,
		token: await controlToken(directory),
	});
	if (start) {
		await control.start();
		return;
	}
	const desktop = await desktopIntegration({
		node: process.execPath,
		executable: control.executable,
		config: control.config,
		dataRoot,
	});
	if (install) {
		const source = fileURLToPath(import.meta.url);
		const updating =
			source !== control.executable && (await exists(control.executable));
		const changed =
			updating &&
			!(await readFile(source)).equals(await readFile(control.executable));
		if (source !== control.executable && (!updating || changed)) {
			const pending = `${control.executable}.${process.pid}.tmp`;
			await copyFile(source, pending);
			await rename(pending, control.executable);
		}
		await writeFile(control.config, JSON.stringify(setup), { mode: 0o600 });
		if (changed) await control.stop();
		await control.start();
		if (!desktop) {
			console.log(
				"POCUT Companion is running. Desktop integration is available on macOS and Windows.",
			);
			return;
		}
		const marker = join(directory, "desktop-installed");
		const enabled = !(await exists(marker)) || (await desktop.startupEnabled());
		await desktop.createShortcut();
		await desktop.setStartup(enabled);
		await writeFile(marker, "", { mode: 0o600 });
		console.log(
			`POCUT Companion is running. Automatic startup at sign-in is ${enabled ? "on" : "off"}.`,
		);
		console.log(`Desktop shortcut: ${desktop.shortcut}`);
		return;
	}
	if (!desktop)
		throw new Error("Desktop controls are available on macOS and Windows.");
	const manager = await serveManager({ ...control, ...desktop });
	try {
		await openLocalManager(manager.url);
	} catch (error) {
		manager.server.close();
		throw error;
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
	const install = process.argv.includes("--install");
	const start = process.argv.includes("--start");
	if (setup && directory && (install || start || process.argv.includes("--manage"))) {
		await manageInstallation({ setup, directory, install, start });
		return;
	}
	if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
	const saved = directory ? join(directory, "paired.json") : null;
	const pair = saved ? await readInstalledPair(saved) : validatePairing(raw);
	if (process.argv.includes("--login-claude")) {
		if (!pair || (setup && setup.origin !== pair.origin))
			throw new Error(
				"Click Connect under Claude in the original POCUT tab first.",
			);
		const profile = providerProfile(pair);
		await mkdir(profile, { recursive: true, mode: 0o700 });
		const { file, prefix } = await resolveClientCli("claude", process.env.OPENCUT_CLAUDE_PATH);
		const child = spawn(
			file,
			[...prefix, "auth", "login"],
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
	const token = directory ? await controlToken(directory) : null;
	const server = createCompanionServer(
		setup && saved && token
			? {
					control: { token, stop },
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
		console.log("POCUT Companion is listening on this device.");
	});
	function stop() {
		providers?.close();
		server.closeAllConnections();
		server.close();
	}
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
