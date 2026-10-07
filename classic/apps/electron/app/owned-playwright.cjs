"use strict";

const { chromium } = require("playwright-core");
const { createOwnedCdpTransport } = require("./owned-cdp-transport.cjs");

/** Host-only connection. Never return Page/Browser or the transport to IPC.
 * Callers supply fixed operations, scope guards and canonical edit contracts. */
async function connectOwnedWindow(webContents, { appOrigin }) {
	const transport = await createOwnedCdpTransport(webContents, { appOrigin });
	try {
		const browser = await chromium.connectOverCDP(transport.endpoint, {
			headers: { Authorization: `Bearer ${transport.token}` },
			noDefaults: true,
			timeout: 8000,
		});
		const pages = browser.contexts().flatMap((context) => context.pages());
		if (pages.length !== 1)
			throw new Error("Expected exactly one owned OpenCut page");
		const page = pages[0];
		page.setDefaultTimeout(5000);
		return {
			page,
			async close() {
				transport.close();
				await browser.close();
			},
		};
	} catch (error) {
		transport.close();
		// Playwright errors may contain its endpoint/headers. Keep them host-only.
		throw new Error("Could not connect to the owned OpenCut window", {
			cause: error,
		});
	}
}

module.exports = { connectOwnedWindow };
