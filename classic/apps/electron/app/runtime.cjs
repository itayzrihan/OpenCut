"use strict";

const { join } = require("node:path");

const DEFAULT_PORT = 3000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_DISK_CACHE_SIZE_BYTES = 512 * 1024 * 1024;
const ELECTRON_USER_AGENT_TOKEN = "OpenCutElectron";

function getAppUrl(port = DEFAULT_PORT) {
	return `http://127.0.0.1:${port}`;
}

function getPackagedServer(resourcesPath) {
	const root = join(resourcesPath, "app-server");
	return {
		root,
		entry: join(root, "apps", "web", "server.js"),
	};
}

function getPerformanceProfile(environment = process.env) {
	const configuredCacheSize = Number.parseInt(
		environment.OPENCUT_ELECTRON_DISK_CACHE_BYTES ?? "",
		10,
	);
	const diskCacheSize =
		Number.isSafeInteger(configuredCacheSize) && configuredCacheSize > 0
			? configuredCacheSize
			: DEFAULT_DISK_CACHE_SIZE_BYTES;
	const gpuMode = environment.OPENCUT_ELECTRON_GPU?.toLowerCase();
	const commandLineSwitches = [["disk-cache-size", `${diskCacheSize}`]];
	if (gpuMode !== "balanced") {
		commandLineSwitches.push(["force_high_performance_gpu"]);
	}

	return {
		commandLineSwitches,
		webPreferences: {
			// Video rendering, exports, and analysis must keep progressing when the
			// editor window temporarily loses focus.
			backgroundThrottling: false,
			// Avoid work that does not benefit a timeline editor.
			spellcheck: false,
			enableWebSQL: false,
			// Populate V8's code cache on first use instead of waiting for heat.
			v8CacheOptions: "bypassHeatCheck",
		},
	};
}

function getElectronUserAgent(userAgent, version) {
	const token = `${ELECTRON_USER_AGENT_TOKEN}/${version}`;
	return userAgent.includes(`${ELECTRON_USER_AGENT_TOKEN}/`)
		? userAgent
		: `${userAgent} ${token}`;
}

async function waitForHttp({
	url,
	timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
	request = globalThis.fetch,
	delay = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
	const deadline = Date.now() + timeoutMs;
	let lastError;

	while (Date.now() < deadline) {
		try {
			const response = await request(url, { redirect: "manual" });
			if (response.status >= 200 && response.status < 500) return;
			lastError = new Error(`OpenCut returned HTTP ${response.status}.`);
		} catch (error) {
			lastError = error;
		}

		await delay(150);
	}

	const detail =
		lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
	throw new Error(`OpenCut did not start within ${timeoutMs}ms.${detail}`);
}

module.exports = {
	DEFAULT_PORT,
	DEFAULT_STARTUP_TIMEOUT_MS,
	DEFAULT_DISK_CACHE_SIZE_BYTES,
	ELECTRON_USER_AGENT_TOKEN,
	getAppUrl,
	getElectronUserAgent,
	getPackagedServer,
	getPerformanceProfile,
	waitForHttp,
};
