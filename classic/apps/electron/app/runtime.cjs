"use strict";

const { join } = require("node:path");

const DEFAULT_PORT = 3000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;

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
	getAppUrl,
	getPackagedServer,
	waitForHttp,
};
