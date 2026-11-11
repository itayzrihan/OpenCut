import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const name = "POCUT Companion";
const label = "me.vxu.pocut.companion";

export async function exists(path: string) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

function xml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
function sh(value: string) {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function psString(value: string) {
	return "'" + value.replaceAll("'", "''") + "'";
}

function windowsPowerShell() {
	return win32.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

type RunDesktopCommand = (request: {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string }>;

const runDesktopCommand: RunDesktopCommand = ({ file, args, env }) =>
	exec(file, args, { env, windowsHide: true });

function plist(fields: string) {
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
		'<plist version="1.0"><dict>' +
		fields +
		"</dict></plist>\n"
	);
}

export async function desktopIntegration({
	node,
	executable,
	config,
	dataRoot,
	platform = process.platform,
	home = homedir(),
	run = runDesktopCommand,
}: {
	node: string;
	executable: string;
	config: string;
	dataRoot: string;
	platform?: NodeJS.Platform;
	home?: string;
	run?: RunDesktopCommand;
}) {
	const args = [node, executable, config];
	const environment: Record<string, string> = {
		OPENCUT_COMPANION_DATA_DIR: dataRoot,
	};
	for (const key of ["PATH", "OPENCUT_CODEX_PATH", "OPENCUT_CLAUDE_PATH"]) {
		const value = process.env[key];
		if (value) environment[key] = value;
	}
	if (platform === "darwin") {
		const shortcut = join(home, "Desktop", name + ".app");
		const startup = join(home, "Library", "LaunchAgents", label + ".plist");
		return {
			shortcut,
			startupEnabled: () => exists(startup),
			async setStartup(enabled: boolean) {
				if (!enabled) {
					await rm(startup, { force: true });
					return;
				}
				await mkdir(dirname(startup), { recursive: true });
				const program = args
					.map((arg) => `<string>${xml(arg)}</string>`)
					.join("");
				const env = Object.entries(environment)
					.map(
						([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`,
					)
					.join("");
				await writeFile(
					startup,
					plist(
						`<key>Label</key><string>${label}</string><key>RunAtLoad</key><true/>` +
							`<key>ProgramArguments</key><array>${program}</array><key>EnvironmentVariables</key><dict>${env}</dict>`,
					),
				);
			},
			async createShortcut() {
				const contents = join(shortcut, "Contents");
				const macOS = join(contents, "MacOS");
				await mkdir(macOS, { recursive: true });
				await writeFile(
					join(contents, "Info.plist"),
					plist(
						`<key>CFBundleIdentifier</key><string>${label}.manager</string>` +
							`<key>CFBundleName</key><string>${name}</string>` +
							"<key>CFBundlePackageType</key><string>APPL</string>" +
							"<key>CFBundleExecutable</key><string>manage</string><key>LSUIElement</key><true/>",
					),
				);
				const env = Object.entries(environment)
					.map(([key, value]) => `export ${key}=${sh(value)}\n`)
					.join("");
				await writeFile(
					join(macOS, "manage"),
					`#!/bin/sh\n${env}exec ${args.map(sh).join(" ")} --manage\n`,
					{ mode: 0o700 },
				);
			},
		};
	}
	if (platform === "win32") {
		const powershell = windowsPowerShell();
		const ps = ({
			command,
			env = {},
		}: {
			command: string;
			env?: Record<string, string>;
		}) =>
			run({
				file: powershell,
				args: ["-NoProfile", "-NonInteractive", "-Command", command],
				env: { ...process.env, ...env },
			});
		const { stdout } = await ps({
			command:
				"[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
				"[Environment]::GetFolderPath('DesktopDirectory'); [Environment]::GetFolderPath('Startup')",
		});
		const [desktop, startupDirectory] = stdout.trimEnd().split(/\r?\n/);
		if (!desktop || !startupDirectory)
			throw new Error("Windows desktop or Startup folder is unavailable.");
		const shortcut = join(desktop, name + ".lnk");
		const startup = join(startupDirectory, name + ".lnk");
		async function createLink({
			path,
			mode,
		}: {
			path: string;
			mode: "manage" | "start";
		}) {
			const env = Object.entries(environment)
				.filter(([key]) => key !== "PATH")
				.map(([key, value]) => `$env:${key} = ${psString(value)}; `)
				.join("");
			const command =
				env +
				"& " +
				args.map(psString).join(" ") +
				(mode === "manage" ? " --manage" : "");
			await ps({
				command:
					"$ErrorActionPreference = 'Stop'; " +
					"$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:POCUT_LINK); " +
					"$link.TargetPath = $env:POCUT_POWERSHELL; $link.Arguments = $env:POCUT_LINK_ARGS; $link.Save()",
				env: {
					POCUT_LINK: path,
					POCUT_POWERSHELL: powershell,
					POCUT_LINK_ARGS: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${command}"`,
				},
			});
		}
		return {
			shortcut,
			startupEnabled: () => exists(startup),
			async setStartup(enabled: boolean) {
				if (!enabled) return rm(startup, { force: true });
				await mkdir(startupDirectory, { recursive: true });
				await createLink({ path: startup, mode: "start" });
			},
			async createShortcut() {
				await mkdir(desktop, { recursive: true });
				await createLink({ path: shortcut, mode: "manage" });
			},
		};
	}
	return null;
}

export async function openLocalManager(url: string) {
	if (process.platform === "darwin") {
		await exec("/usr/bin/open", [url]);
		return;
	}
	if (process.platform === "win32") {
		await exec(
			windowsPowerShell(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Start-Process -FilePath $env:POCUT_MANAGER_URL",
			],
			{
				env: { ...process.env, POCUT_MANAGER_URL: url },
				windowsHide: true,
			},
		);
	}
}
