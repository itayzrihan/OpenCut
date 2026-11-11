import { createHash, randomBytes, webcrypto } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { registerMcpClient } from "./client-cli.mjs";

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const encryptedPath = join(bundleDirectory, "POCUT-MCP-ENCRYPTED-DO-NOT-READ.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function endpoint(raw) {
	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw new Error("Use the loopback POCUT origin or a private SSH forward.");
	return new URL("/api/editor-agent/mcp", url);
}

async function readCode() {
	if (!process.stdin.isTTY)
		throw new Error("Run this installer in an interactive terminal and let the owner enter the code.");
	process.stderr.write("Paste the one-time code from POCUT and press Enter (hidden): ");
	const hidden = new Writable({ write(_chunk, _encoding, done) { done(); } });
	const terminal = createInterface({ input: process.stdin, output: hidden, terminal: true });
	try {
		return (await terminal.question("")).trim();
	} finally {
		terminal.close();
		process.stderr.write("\n");
	}
}

async function unseal(code) {
	if (!/^[\w-]{43}$/.test(code)) throw new Error("The one-time code is invalid.");
	const envelope = JSON.parse(await readFile(encryptedPath, "utf8"));
	if (envelope.version !== 1) throw new Error("Unsupported POCUT bundle.");
	try {
		const key = await webcrypto.subtle.importKey("raw", Buffer.from(code, "base64url"), "AES-GCM", false, ["decrypt"]);
		const plain = await webcrypto.subtle.decrypt(
			{ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") },
			key,
			Buffer.from(envelope.encrypted, "base64url"),
		);
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		throw new Error("The code did not unlock this bundle.");
	}
}

async function verify(url, key) {
	return fetch(url, {
		headers: { Authorization: `Bearer ${key}` },
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
	});
}

async function install() {
	const args = process.argv.slice(2);
	let client, originOverride;
	for (let i = 0; i < args.length; i += 2) {
		const [option, value] = args.slice(i, i + 2);
		if (option === "--client" && !client && ["codex", "claude"].includes(value)) client = value;
		else if (option === "--origin" && !originOverride && value && !value.startsWith("--")) originOverride = value;
		else throw new Error("Usage: node install.mjs [--client codex|claude] [--origin http://127.0.0.1:43123]");
	}
	const { activation, origin } = await unseal(await readCode());
	const match = /^pocut-setup\.([a-f0-9-]{36})\.([a-f0-9]{64})\.[\w-]{43}$/.exec(activation);
	if (!match) throw new Error("Invalid encrypted POCUT bundle.");
	const url = endpoint(originOverride ?? origin);
	const account = match[1];
	const project = match[2];
	const configRoot = process.platform === "win32"
		? (process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"))
		: process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
		: (process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
	const installDir = resolve(configRoot, "POCUT", "MCP", account, project);
	await mkdir(installDir, { recursive: true, mode: 0o700 });
	const pendingFile = join(installDir, "config.pending.json");
	const configFile = join(installDir, "config.json");
	const relay = join(installDir, "pocut-mcp.mjs");
	const activationHash = hash(activation);
	let config;
	for (const path of [pendingFile, configFile]) {
		const saved = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
		if (saved?.activationHash === activationHash && saved.endpoint === url.href) {
			config = saved;
			break;
		}
	}
	if (!config) {
		config = {
			endpoint: url.href,
			key: `pocut-key.${account}.${project}.${randomBytes(32).toString("base64url")}`,
			activationHash,
		};
		await writeFile(pendingFile, JSON.stringify(config), { mode: 0o600, flag: "w" });
	}
	await copyFile(join(bundleDirectory, "pocut-mcp.mjs"), relay);
	let status = await verify(url, config.key);
	if (!status.ok) {
		await status.body?.cancel();
		const activationUrl = new URL(url.href + "/activate");
		const result = await fetch(activationUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${activation}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ keyHash: hash(config.key) }),
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
		await result.body?.cancel();
		if (!result.ok) throw new Error("Installation expired or was already used. Generate a fresh ZIP in POCUT.");
		status = await verify(url, config.key);
	}
	await status.body?.cancel();
	if (!status.ok) throw new Error("Keep the linked project open in POCUT and rerun this installer to verify the connection.");
	await writeFile(pendingFile, JSON.stringify(config), { mode: 0o600, flag: "w" });
	await rename(pendingFile, configFile);
	const name = `pocut-${project.slice(0, 8)}`;
	if (client) await registerMcpClient({ client, name, command: process.execPath, relay });
	await rm(encryptedPath, { force: true });
	if (client) {
		console.log(`Connection verified and ${name} registered in ${client}. Restart or reload the client, then check tools/list for the linked project.`);
	} else {
		console.log(JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [relay] } } }, null, 2));
		console.error("Connection verified. Add the printed configuration to the MCP client, restart it and verify tools/list.");
	}
	console.error("Delete the original ZIP and the extracted setup folder after the client connects.");
}

install().catch((error) => {
	console.error(error instanceof Error ? error.message : "Installation failed.");
	process.exitCode = 1;
});
