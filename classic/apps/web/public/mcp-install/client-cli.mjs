import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npmEntry = {
	codex: ["@openai", "codex", "bin", "codex.js"],
	claude: ["@anthropic-ai", "claude-code", "cli.js"],
};

/** Launch Windows native executables or known npm entry points without cmd.exe. */
export async function resolveClientCli(client, executable = client) {
	if (process.platform !== "win32") return { file: executable, prefix: [] };
	const absolute = win32.isAbsolute(executable);
	const where = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
	const candidates = absolute ? [executable] : await exec(where, [`$PATH:${executable}`], {
		windowsHide: true, timeout: 5_000,
	}).then(({ stdout }) => stdout.trim().split(/\r?\n/), () => []);
	for (const path of candidates) {
		if (!win32.isAbsolute(path)) continue;
		if (/\.(?:exe|com)$/i.test(path)) return { file: path, prefix: [] };
		if (absolute && /\.(?:js|mjs|cjs)$/i.test(path)) return { file: process.execPath, prefix: [path] };
		if (!/\.cmd$/i.test(path) || !Object.hasOwn(npmEntry, client)) continue;
		const entry = win32.join(win32.dirname(path), "node_modules", ...npmEntry[client]);
		if (await access(entry).then(() => true, () => false)) return { file: process.execPath, prefix: [entry] };
	}
	throw new Error(`Install or update the official ${client === "codex" ? "Codex" : "Claude Code"} CLI, then run setup again.`);
}

export async function registerMcpClient({ client, name, command, relay, executable, run = exec }) {
	const { file, prefix } = await resolveClientCli(client, executable);
	const options = { windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 };
	const invoke = (...args) => run(file, [...prefix, ...args], options);
	const add = client === "claude" ? ["--scope", "user", "--transport", "stdio"] : [];
	try {
		await invoke("mcp", "add", ...add, name, "--", command, relay);
	} catch {
		// Claude rejects duplicate names. Accept only an already installed relay
		// with these exact paths; never remove another server to force an update.
		const known = client === "claude" && await invoke("mcp", "get", name)
			.then(({ stdout }) => {
				const lines = stdout.split(/\r?\n/).map(line => line.trim());
				return lines.includes(`Command: ${command}`) && lines.includes(`Args: ${relay}`);
			}, () => false);
		if (!known) throw new Error(`POCUT verified the relay, but could not register ${name} in ${client}. Check the local CLI and rerun this installer with the same --client option.`);
	}
	await invoke("mcp", "get", name).catch(() => {
		throw new Error(`Could not verify registration of ${name} in ${client}. Check the local CLI and rerun this installer.`);
	});
}
