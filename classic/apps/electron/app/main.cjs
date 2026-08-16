"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	shell,
} = require("electron");
const {
	DEFAULT_PORT,
	getAppUrl,
	getElectronUserAgent,
	getPackagedServer,
	getPerformanceProfile,
	waitForHttp,
} = require("./runtime.cjs");

let mainWindow = null;
let webServer = null;
let isQuitting = false;
const serverOutput = [];
const performanceProfile = getPerformanceProfile();

for (const [name, value] of performanceProfile.commandLineSwitches) {
	if (value === undefined) {
		app.commandLine.appendSwitch(name);
	} else {
		app.commandLine.appendSwitch(name, value);
	}
}

// There is no native application menu in this shell. Avoid constructing
// Electron's default menu during startup.
Menu.setApplicationMenu(null);

function rememberServerOutput(chunk) {
	const line = chunk.toString().trim();
	if (!line) return;

	serverOutput.push(line);
	if (serverOutput.length > 40) serverOutput.shift();
	console.log(`[web] ${line}`);
}

function startPackagedServer() {
	const server = getPackagedServer(process.resourcesPath);
	if (!existsSync(server.entry)) {
		throw new Error(`The packaged web server is missing: ${server.entry}`);
	}

	const port = Number.parseInt(
		process.env.OPENCUT_ELECTRON_PORT ?? `${DEFAULT_PORT}`,
		10,
	);
	const url = getAppUrl(port);

	webServer = spawn(process.execPath, [server.entry], {
		cwd: server.root,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			HOSTNAME: "127.0.0.1",
			PORT: `${port}`,
			NODE_ENV: "production",
			NEXT_TELEMETRY_DISABLED: "1",
			NEXT_PUBLIC_SITE_URL: url,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	webServer.stdout?.on("data", rememberServerOutput);
	webServer.stderr?.on("data", rememberServerOutput);
	webServer.on("exit", (code) => {
		webServer = null;
		if (!isQuitting && code !== 0) {
			dialog.showErrorBox(
				"OpenCut stopped unexpectedly",
				`The local web runtime exited with code ${code}.`,
			);
		}
	});

	return url;
}

function isInternalUrl(candidate, appUrl) {
	try {
		return new URL(candidate).origin === new URL(appUrl).origin;
	} catch {
		return false;
	}
}

async function openExternal(candidate) {
	if (/^https?:/i.test(candidate) || /^mailto:/i.test(candidate)) {
		await shell.openExternal(candidate);
	}
}

const MEDIA_FILE_EXTENSIONS = [
	"mp4", "mov", "mkv", "webm", "avi", "m4v",
	"mp3", "wav", "aac", "flac", "ogg", "m4a",
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
];

// Runs in the main process so the resulting dialog is owned by the app window — unlike the
// server-side PowerShell/osascript/zenity fallback in services/local-drive/server.ts, which is
// spawned from a detached background process with no window to parent itself to.
ipcMain.handle("opencut:pick-media-files", async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
	const result = await dialog.showOpenDialog(window, {
		title: "Import media into OpenCut",
		properties: ["openFile", "multiSelections"],
		filters: [
			{ name: "Media", extensions: MEDIA_FILE_EXTENSIONS },
			{ name: "All Files", extensions: ["*"] },
		],
	});
	return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("opencut:go-back", async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	if (window?.webContents.canGoBack()) {
		window.webContents.goBack();
		return true;
	}
	return false;
});

ipcMain.handle("opencut:can-go-back", async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	return window?.webContents.canGoBack() ?? false;
});

function createWindow(appUrl) {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 700,
		show: true,
		autoHideMenuBar: true,
		backgroundColor: "#09090b",
		webPreferences: {
			...performanceProfile.webPreferences,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			preload: join(__dirname, "preload.cjs"),
		},
	});

	window.webContents.setUserAgent(
		getElectronUserAgent(window.webContents.getUserAgent(), app.getVersion()),
	);
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	// The default DevTools accelerator (Ctrl/Cmd+Shift+I, F12) is normally wired through
	// Electron's default application menu roles. Menu.setApplicationMenu(null) above removes
	// that menu — and with it those default shortcuts — so they're rebound explicitly here.
	window.webContents.on("before-input-event", (event, input) => {
		const isDevToolsShortcut =
			input.type === "keyDown" &&
			(input.key === "F12" ||
				(input.key.toLowerCase() === "i" &&
				(input.control || input.meta) &&
				input.shift));
		if (isDevToolsShortcut) {
			window.webContents.toggleDevTools();
		}
	});

	// OAuth providers that are allowed to redirect within the Electron window
	const oauthProviders = [
		"auth.openai.com",
		"accounts.google.com",
		"github.com",
		"login.microsoftonline.com",
	];

	function isOAuthUrl(urlString) {
		try {
			const url = new URL(urlString);
			return oauthProviders.some((provider) =>
				url.hostname.includes(provider),
			);
		} catch {
			return false;
		}
	}

	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isInternalUrl(url, appUrl)) {
			void window.loadURL(url);
		} else if (isOAuthUrl(url)) {
			// Allow OAuth flows to navigate in-window
			void window.loadURL(url);
		} else {
			// External links open in default browser
			void openExternal(url);
		}
		return { action: "deny" };
	});

	window.webContents.on("will-navigate", (event, url) => {
		// Allow navigation to internal app or OAuth providers
		if (isInternalUrl(url, appUrl) || isOAuthUrl(url)) return;
		// Block other external navigation
		event.preventDefault();
		void openExternal(url);
	});

	void window.loadURL(appUrl);
	mainWindow = window;
}

async function boot() {
	const appUrl = app.isPackaged
		? startPackagedServer()
		: process.env.OPENCUT_ELECTRON_URL ?? getAppUrl();

	await waitForHttp({ url: appUrl });
	createWindow(appUrl);
}

function stopPackagedServer() {
	isQuitting = true;
	webServer?.kill();
	webServer = null;
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});

	app.whenReady().then(boot).catch((error) => {
		const details = serverOutput.length
			? `\n\nWeb runtime output:\n${serverOutput.join("\n")}`
			: "";
		dialog.showErrorBox(
			"OpenCut could not start",
			`${error instanceof Error ? error.message : String(error)}${details}`,
		);
		app.quit();
	});

	app.on("activate", () => {
		if (mainWindow) return;
		const appUrl = app.isPackaged
			? getAppUrl(
					Number.parseInt(
						process.env.OPENCUT_ELECTRON_PORT ?? `${DEFAULT_PORT}`,
						10,
					),
				)
			: process.env.OPENCUT_ELECTRON_URL ?? getAppUrl();
		createWindow(appUrl);
	});

	app.on("before-quit", stopPackagedServer);
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
}
