"use strict";
// Isolated GPU/decoder realm, without an editor window or project persistence.
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require("electron");
const { join } = require("node:path");
if (process.env.OPENCUT_RENDER_WORKER_PROFILE)
	app.setPath("userData", process.env.OPENCUT_RENDER_WORKER_PROFILE);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let config = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (b) => (config += b));
process.stdin.on("end", async () => {
	try {
		const boot = JSON.parse(config);
		config = "";
		const origin = new URL(boot.origin);
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
			origin.protocol !== "http:" ||
			!/^[a-f0-9-]{36}$/.test(boot.accountId) ||
			!/^[a-f0-9]{64}$/.test(boot.token)
		)
			throw Error("Invalid background renderer bootstrap");
		app.setPath("userData", boot.profile);
		await app.whenReady();
		app.dock?.hide();
		const blocker = powerSaveBlocker.start("prevent-app-suspension");
		const win = new BrowserWindow({
			show: false,
			width: 1280,
			height: 720,
			webPreferences: {
				preload: join(__dirname, "render-worker-preload.cjs"),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
				additionalArguments: [`--opencut-render-account=${boot.accountId}`],
			},
		});
		win.webContents.session.setPermissionRequestHandler(
			(_contents, _permission, callback) => callback(false),
		);
		win.webContents.session.webRequest.onBeforeSendHeaders(
			{ urls: [`${origin.origin}/*`] },
			(details, callback) => {
				const headers = { ...details.requestHeaders };
				if (
					new URL(details.url).origin === origin.origin &&
					new URL(details.url).pathname.startsWith("/api/")
				) {
					for (const name of Object.keys(headers))
						if (
							["x-opencut-render-worker", "x-opencut-account"].includes(
								name.toLowerCase(),
							)
						)
							delete headers[name];
					headers["x-opencut-render-worker"] = boot.token;
					headers["x-opencut-account"] = boot.accountId;
				}
				callback({ requestHeaders: headers });
			},
		);
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("will-navigate", (event, url) => {
			if (
				new URL(url).origin !== origin.origin ||
				new URL(url).pathname !== "/render-worker"
			)
				event.preventDefault();
		});
		win.webContents.on("render-process-gone", () => app.exit(1));
		ipcMain.on("opencut-render-worker-idle", (event) => {
			if (event.sender === win.webContents) {
				powerSaveBlocker.stop(blocker);
				app.quit();
			}
		});
		win.webContents.on("console-message", (_event, level, message) => {
			if (level >= 2) console.error("[renderer]", message);
		});
		await win.loadURL(
			`${origin.origin}/render-worker?account=${boot.accountId}`,
		);
	} catch (error) {
		console.error("Background renderer startup failed:", error.message);
		app.exit(1);
	}
});
app.on("window-all-closed", () => app.quit());
