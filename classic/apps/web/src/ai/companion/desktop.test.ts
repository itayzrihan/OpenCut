import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopIntegration } from "./desktop";
import { serveManager } from "./management";

test("macOS Desktop shortcut and sign-in LaunchAgent are independent", async () => {
	const home = await mkdtemp(join(tmpdir(), "pocut-desktop-test-"));
	const dataRoot = join(home, "POCUT's & companion");
	try {
		const integration = await desktopIntegration({
			platform: "darwin",
			home,
			dataRoot,
			node: "/test/node",
			executable: join(dataRoot, "companion.mjs"),
			config: join(dataRoot, "POCUT-Setup.json"),
		});
		if (!integration) throw new Error("No desktop integration");
		await integration.createShortcut();
		const launcher = join(integration.shortcut, "Contents", "MacOS", "manage");
		expect((await stat(launcher)).mode & 0o100).toBe(0o100);
		expect(await readFile(launcher, "utf8")).toContain("' --manage");
		expect(await integration.startupEnabled()).toBe(false);
		await integration.setStartup(true);
		const startup = join(
			home,
			"Library",
			"LaunchAgents",
			"me.vxu.pocut.companion.plist",
		);
		const plist = await readFile(startup, "utf8");
		expect(plist).toContain("<key>RunAtLoad</key><true/>");
		expect(plist).toContain("POCUT's &amp; companion");
		expect(plist).not.toContain("--manage");
		expect(await integration.startupEnabled()).toBe(true);
		await integration.setStartup(false);
		expect(await integration.startupEnabled()).toBe(false);
		expect((await stat(launcher)).isFile()).toBe(true);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Windows uses the current user's Desktop and Startup folders for separate shortcuts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-win-test-"));
	const desktop = join(root, "OneDrive Desktop");
	const startup = join(root, "Startup");
	try {
		const integration = await desktopIntegration({
			platform: "win32",
			node: "C:\\Program Files\\nodejs\\node.exe",
			executable: "C:\\Users\\O'Neil\\POCUT\\companion.mjs",
			config: "C:\\Users\\O'Neil\\POCUT\\POCUT-Setup.json",
			dataRoot: "C:\\Users\\O'Neil\\POCUT",
			run: async ({ file, args, env }) => {
				expect(file.endsWith("powershell.exe")).toBe(true);
				if (args.at(-1)?.includes("GetFolderPath"))
					return { stdout: `${desktop}\r\n${startup}\r\n` };
				if (!env.POCUT_LINK || !env.POCUT_LINK_ARGS)
					throw new Error("Missing shortcut settings");
				await writeFile(env.POCUT_LINK, env.POCUT_LINK_ARGS);
				return { stdout: "" };
			},
		});
		if (!integration) throw new Error("No desktop integration");
		await integration.createShortcut();
		await integration.setStartup(true);
		const settings = await readFile(integration.shortcut, "utf8");
		expect(settings).toContain("-WindowStyle Hidden");
		expect(settings).toContain("O''Neil");
		expect(settings).toContain("--manage");
		expect(
			await readFile(join(startup, "POCUT Companion.lnk"), "utf8"),
		).not.toContain("--manage");
		expect(await integration.startupEnabled()).toBe(true);
		await integration.setStartup(false);
		expect(await integration.startupEnabled()).toBe(false);
		expect((await stat(integration.shortcut)).isFile()).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the private browser manager separates running state from startup and rejects cross-origin controls", async () => {
	let running = true;
	let startup = true;
	const { url, server } = await serveManager({
		isRunning: async () => running,
		start: async () => {
			running = true;
		},
		stop: async () => {
			running = false;
		},
		startupEnabled: async () => startup,
		setStartup: async (enabled) => {
			startup = enabled;
		},
	});
	const origin = new URL(url).origin;
	const submit = ({
		action,
		requestOrigin = origin,
	}: {
		action: string;
		requestOrigin?: string;
	}) =>
		fetch(url, {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: requestOrigin,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ action }),
		});
	try {
		expect((await fetch(origin)).status).toBe(404);
		const page = await fetch(url);
		expect(page.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(await page.text()).toContain("Turn off");
		expect(
			(
				await submit({
					action: "stop",
					requestOrigin: "https://untrusted.example",
				})
			).status,
		).toBe(403);
		expect(running).toBe(true);
		expect((await submit({ action: "stop" })).status).toBe(303);
		expect(running).toBe(false);
		expect(startup).toBe(true);
		expect((await submit({ action: "disable-startup" })).status).toBe(303);
		expect(startup).toBe(false);
		expect((await submit({ action: "start" })).status).toBe(303);
		expect(running).toBe(true);
		expect(startup).toBe(false);
		expect((await submit({ action: "enable-startup" })).status).toBe(303);
		expect(startup).toBe(true);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
