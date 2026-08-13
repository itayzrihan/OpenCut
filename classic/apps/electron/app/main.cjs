"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const {
	app,
	BrowserWindow,
	dialog,
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
		},
	});

	window.webContents.setUserAgent(
		getElectronUserAgent(window.webContents.getUserAgent(), app.getVersion()),
	);
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isInternalUrl(url, appUrl)) {
			void window.loadURL(url);
		} else {
			void openExternal(url);
		}
		return { action: "deny" };
	});

	window.webContents.on("will-navigate", (event, url) => {
		if (isInternalUrl(url, appUrl)) return;
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
