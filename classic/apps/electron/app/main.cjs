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

// The local Production launcher owns this profile and the external server.
const profilePath = process.env.OPENCUT_ELECTRON_USER_DATA ?? app.getPath("userData");
app.setName("POCUT");
app.setPath("userData", profilePath);

let mainWindow = null;
let mainAppUrl = null;
let webServer = null;
let packagedBridge = null;
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
	const bridgeDirectory = join(profilePath, "mcp-bridge");
	const bridgeExecutable = join(process.resourcesPath, "control-plane",
		process.platform === "win32" ? "opencut-mcp.exe" : "opencut-mcp");
	if (existsSync(bridgeExecutable)) {
		packagedBridge = spawn(bridgeExecutable, [], {
			cwd: server.root,
			env: {
				...process.env,
				OPENCUT_CLASSIC_BRIDGE_DIRECTORY: bridgeDirectory,
				OPENCUT_CLASSIC_BRIDGE_ADDR: "127.0.0.1:0",
			},
			stdio: ["pipe", "ignore", "inherit"],
			windowsHide: true,
		});
		packagedBridge.on("error", () => console.warn("POCUT MCP bridge could not start"));
		packagedBridge.on("exit", () => { packagedBridge = null; });
	}

	webServer = spawn(process.execPath, [server.entry], {
		cwd: server.root,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			HOSTNAME: "127.0.0.1",
			OPENCUT_DELEGATED_MCP_LOCAL: "1",
			OPENCUT_CLASSIC_BRIDGE_DIRECTORY: bridgeDirectory,
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
		packagedBridge?.kill();
		if (!isQuitting && code !== 0) {
			dialog.showErrorBox(
				"POCUT stopped unexpectedly",
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
ipcMain.handle("opencut:pick-media-files", async (event, labels) => {
	const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
	const label = (key, fallback) => {
		const value = labels?.[key];
		return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value)
			? value
			: fallback;
	};
	const result = await dialog.showOpenDialog(window, {
		title: label("title", "Import media into POCUT"),
		properties: ["openFile", "multiSelections"],
		filters: [
			{ name: label("media", "Media"), extensions: MEDIA_FILE_EXTENSIONS },
			{ name: label("allFiles", "All Files"), extensions: ["*"] },
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
	mainAppUrl = appUrl;
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 700,
		show: true,
		autoHideMenuBar: true,
		backgroundColor: "#0d0a16",
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
	window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
		if (isMainFrame) computerService.revoke();
	});
	window.webContents.on("render-process-gone", () => computerService.revoke());
	window.webContents.on("destroyed", () => computerService.revoke());
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

const { createComputerService } = require("./agent-computer.cjs");
const computerService = createComputerService({
	confirm: async ({ title, message, detail }) => {
		const result = await dialog.showMessageBox(mainWindow, {
			type: "warning",
			title,
			message,
			detail: detail.slice(0, 200000),
			buttons: [
				"Cancel",
				title === "Enable computer access?" ? "Enable access" : "Allow once",
			],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		});
		return result.response === 1;
	},
	assertScope: async (scope) => {
		if (!mainWindow || mainWindow.isDestroyed())
			throw Error("Editor window closed");
		const current = await mainWindow.webContents.executeJavaScript(
			`({accountId:window.__opencutAccountId??"local",projectId:document.querySelector("[data-opencut-editor-project]")?.getAttribute("data-opencut-editor-project"),route:decodeURIComponent(location.pathname.split("/")[2]??"")})`,
		);
		if (
			current.accountId !== scope.accountId ||
			current.projectId !== scope.projectId ||
			current.route !== scope.projectId
		) {
			computerService.revoke();
			throw Error("Computer operation account or project changed");
		}
	},
});
function authorizeComputer(event) {
	require("./editor-screenshot.cjs").authorizeEditorScreenshot(
		event,
		mainWindow,
		mainAppUrl,
	);
}
ipcMain.handle("opencut:chatgpt-sign-in", async (event, candidate) => {
	authorizeComputer(event);
	const url = new URL(candidate);
	if (
		url.origin !== "https://auth.openai.com" ||
		url.pathname !== "/api/accounts/authorize" ||
		url.username ||
		url.password
	) throw new Error("Invalid ChatGPT authorization URL");
	await shell.openExternal(url.href);
});
ipcMain.handle("opencut:agent-computer-permissions", async (event, scope) => {
	authorizeComputer(event);
	return computerService.setAccess(scope);
});
ipcMain.handle("opencut:agent-computer-execute", async (event, request) => {
	authorizeComputer(event);
	try {
		return { type: "success", data: await computerService.execute(request) };
	} catch (error) {
		return {
			type: error.computerEffectStarted ? "uncertain" : "rejected",
			message: String(error.message || error),
		};
	}
});
ipcMain.handle("opencut:agent-computer-cancel", async (event) => {
	authorizeComputer(event);
	computerService.cancel();
});
ipcMain.handle("opencut:agent-computer-revoke", async (event) => {
	authorizeComputer(event);
	computerService.revoke();
});

ipcMain.handle("opencut:editor-screenshot", async (event, request) => {
	const { captureOwnedEditor, authorizeEditorScreenshot } = require("./editor-screenshot.cjs");
	try {
		authorizeEditorScreenshot(event, mainWindow, mainAppUrl);
		return await captureOwnedEditor(event.sender, { appOrigin: new URL(mainAppUrl).origin, request });
	} catch {
		// CDP/Playwright errors can contain connection headers or page data.
		throw new Error("The editor screenshot is unavailable. Keep the same account and project open and close DevTools before retrying.");
	}
});

ipcMain.handle("opencut:editor-ui-control", async (event, request) => {
	const { authorizeEditorScreenshot } = require("./editor-screenshot.cjs");
	const { controlOwnedEditor } = require("./editor-ui-control.cjs");
	try {
		authorizeEditorScreenshot(event, mainWindow, mainAppUrl);
		await controlOwnedEditor(event.sender, { appOrigin: new URL(mainAppUrl).origin, request });
	} catch {
		throw new Error("The owned editor UI gesture failed or its scope changed. Inspect the interface again before retrying.");
	}
});

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
	packagedBridge?.kill();
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
			"POCUT could not start",
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
		if (process.platform !== "darwin" || process.env.OPENCUT_ELECTRON_EXIT_ON_CLOSE === "1") app.quit();
	});
}
