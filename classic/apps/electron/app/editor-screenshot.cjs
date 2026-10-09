"use strict";

const { nativeImage } = require("electron");
const { connectOwnedWindow } = require("./owned-playwright.cjs");

function validateRequest(request) {
	if (
		!request ||
		typeof request !== "object" ||
		Array.isArray(request) ||
		Object.keys(request).some(
			(key) => !["accountId", "projectId"].includes(key),
		) ||
		![request.accountId, request.projectId].every(
			(value) =>
				typeof value === "string" && value.length > 0 && value.length <= 256,
		)
	)
		throw new Error("Invalid editor screenshot scope");
}

// Called only by a fixed, authenticated main-frame IPC handler. No supplied JS,
// selector, URL, path or CDP method crosses this boundary.
async function captureOwnedEditor(webContents, { appOrigin, request }) {
	validateRequest(request);
	const connection = await connectOwnedWindow(webContents, { appOrigin });
	try {
		const { page } = connection;
		const scope = async () =>
			page.evaluate(({ accountId, projectId }) => {
				if (
					decodeURIComponent(location.pathname.split("/")[2] ?? "") !==
					projectId
				)
					throw new Error("Editor route changed");
				if ((window.__opencutAccountId ?? "local") !== accountId)
					throw new Error("Account changed");
				const roots = [
					...document.querySelectorAll("[data-opencut-editor-project]"),
				];
				if (
					roots.length !== 1 ||
					roots[0].getAttribute("data-opencut-editor-project") !== projectId
				)
					throw new Error("Project changed");
				const rect = roots[0].getBoundingClientRect();
				const x = Math.max(0, rect.left),
					y = Math.max(0, rect.top);
				const width = Math.min(innerWidth, rect.right) - x;
				const height = Math.min(innerHeight, rect.bottom) - y;
				if (width < 1 || height < 1 || width > 8192 || height > 8192)
					throw new Error("Editor viewport unavailable");
				return { x, y, width, height };
			}, request);
		const clip = await scope();
		const png = await page.screenshot({
			type: "png",
			clip,
			timeout: 5000,
			mask: [
				page.locator(
					"[data-editor-agent-private], [data-testid='editor-agent'], input, textarea, [contenteditable]",
				),
			],
			maskColor: "#111111",
		});
		await scope();
		let image = nativeImage.createFromBuffer(png);
		let { width, height } = image.getSize();
		const scale = Math.min(1, 2048 / Math.max(width, height));
		if (scale < 1)
			image = image.resize({
				width: Math.max(1, Math.round(width * scale)),
				height: Math.max(1, Math.round(height * scale)),
			});
		({ width, height } = image.getSize());
		const bytes = image.toJPEG(80);
		if (!width || !height || bytes.length > 2_000_000)
			throw new Error("Screenshot exceeds its bound");
		return { bytes: new Uint8Array(bytes), width, height };
	} finally {
		await connection.close();
	}
}

function authorizeEditorScreenshot(event, window, appUrl) {
	if (
		!window ||
		window.isDestroyed() ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame
	)
		throw new Error("Only the owned OpenCut main frame may capture the editor");
	const url = new URL(event.senderFrame.url);
	if (
		url.origin !== new URL(appUrl).origin ||
		!/^\/editor\/[^/]+\/?$/.test(url.pathname)
	)
		throw new Error("Open the editor before capturing its interface");
}

module.exports = { captureOwnedEditor, authorizeEditorScreenshot };
