"use strict";

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { app, BrowserWindow, nativeImage, ipcMain } = require("electron");
const { join } = require("node:path");
const {
	captureOwnedEditor,
	authorizeEditorScreenshot,
} = require("../app/editor-screenshot.cjs");
const { WebSocket } = require("../app/node_modules/ws");
const { connectOwnedWindow } = require("../app/owned-playwright.cjs");
const { createOwnedCdpTransport } = require("../app/owned-cdp-transport.cjs");

let checks = 0;
function check(condition, message) {
	assert.ok(condition, message);
	checks++;
}
async function rejectConnection(endpoint, headers) {
	await new Promise((resolve, reject) => {
		const socket = new WebSocket(endpoint, { headers });
		socket.on("open", () => {
			socket.close();
			reject(new Error("Unauthorized connection accepted"));
		});
		socket.on("error", (error) => {
			try {
				check(error.message.includes("403"), "Unauthorized handshake rejected");
				resolve();
			} catch (failure) {
				reject(failure);
			}
		});
	});
}

async function run() {
	await app.whenReady();
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			`<!doctype html><title>OpenCut fixture</title><style>body{margin:0}main{width:100vw;height:100vh;background:white}[data-editor-agent-private]{position:absolute;left:100px;top:100px;width:100px;height:100px;background:red}</style><main data-opencut-editor-project="project-a"><button onclick="this.setAttribute('aria-pressed','true')" aria-pressed="false">השתק רצועה</button><p>${request.url === "/other" ? "OTHER WINDOW PRIVATE" : "Owned editor"}</p><div data-editor-agent-private>SECRET</div></main>`,
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const appOrigin = `http://127.0.0.1:${server.address().port}`;
	const options = {
		show: false,
		width: 800,
		height: 600,
		webPreferences: {
			preload: join(__dirname, "../app/preload.cjs"),
			offscreen: true,
			backgroundThrottling: false,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	};
	const owned = new BrowserWindow(options);
	const other = new BrowserWindow(options);
	ipcMain.handle("opencut:editor-screenshot", async (event, request) => {
		authorizeEditorScreenshot(event, owned, appOrigin);
		return captureOwnedEditor(event.sender, { appOrigin, request });
	});
	try {
		await Promise.all([
			owned.loadURL(`${appOrigin}/editor/project-a`),
			other.loadURL(`${appOrigin}/other`),
		]);
		const transport = await createOwnedCdpTransport(owned.webContents, {
			appOrigin,
		});
		await rejectConnection(transport.endpoint, {});
		await rejectConnection(transport.endpoint, {
			Authorization: "Bearer wrong",
		});
		await rejectConnection(transport.endpoint, {
			Authorization: `Bearer ${transport.token}`,
			Origin: appOrigin,
		});
		check(
			(await fetch(transport.endpoint.replace("ws:", "http:"))).status === 404,
			"No discovery HTTP endpoint",
		);
		const raw = new WebSocket(transport.endpoint, {
			headers: { Authorization: `Bearer ${transport.token}` },
		});
		await once(raw, "open");
		let id = 0;
		async function command(method, params, sessionId) {
			const response = once(raw, "message");
			raw.send(JSON.stringify({ id: ++id, method, params, sessionId }));
			return JSON.parse((await response)[0].toString());
		}
		for (const method of [
			"Target.getTargets",
			"Target.createTarget",
			"Target.attachToTarget",
			"Target.createBrowserContext",
			"Browser.close",
			"Storage.getCookies",
			"Runtime.evaluate",
		]) {
			check(
				!!(await command(method, {})).error,
				`Reject browser-wide ${method}`,
			);
		}
		check(
			!!(
				await command(
					"Runtime.evaluate",
					{ expression: "location.href" },
					"another-window",
				)
			).error,
			"Unknown target session rejected",
		);
		await rejectConnection(transport.endpoint, {
			Authorization: `Bearer ${transport.token}`,
		});
		transport.close();
		check(
			!owned.webContents.debugger.isAttached(),
			"Transport detaches debugger",
		);
		const connection = await connectOwnedWindow(owned.webContents, {
			appOrigin,
		});
		check(
			connection.page.context().pages().length === 1,
			"Other window not exposed",
		);
		check(
			!(await connection.page.locator("body").innerText()).includes(
				"OTHER WINDOW PRIVATE",
			),
			"Only owned page visible",
		);
		await connection.page
			.getByRole("button", { name: "השתק רצועה", exact: true })
			.click();
		check(
			(await connection.page
				.getByRole("button")
				.getAttribute("aria-pressed")) === "true",
			"Real Playwright Hebrew locator clicks owned control",
		);
		check(
			(await other.webContents.executeJavaScript(
				"document.querySelector('button').getAttribute('aria-pressed')",
			)) === "false",
			"Other window remains unchanged",
		);
		const screenshot = await connection.page.screenshot({
			type: "png",
			timeout: 5000,
		});
		const dimensions = nativeImage.createFromBuffer(screenshot).getSize();
		check(
			dimensions.width > 0 && dimensions.height > 0 && screenshot.length > 100,
			"Real Playwright PNG screenshot",
		);
		await connection.close();
		check(
			!owned.isDestroyed() && !other.isDestroyed(),
			"Disconnect preserves windows",
		);
		const capture = await owned.webContents.executeJavaScript(
			"window.opencutElectron.captureEditorScreenshot({accountId:'local',projectId:'project-a'})",
		);
		const capturedImage = nativeImage.createFromBuffer(
			Buffer.from(capture.bytes),
		);
		check(
			capture.width === capturedImage.getSize().width &&
				capture.height === capturedImage.getSize().height,
			"Production preload returns real bounded JPEG dimensions",
		);
		const pixel = capturedImage
			.crop({ x: 150, y: 150, width: 1, height: 1 })
			.toBitmap();
		check(
			pixel[0] < 30 && pixel[1] < 30 && pixel[2] < 30,
			"Private red region is masked in actual pixels",
		);
		for (const request of [
			{ accountId: "other", projectId: "project-a" },
			{ accountId: "local", projectId: "other" },
			{ accountId: "local", projectId: "project-a", selector: "body" },
		]) {
			await assert.rejects(
				owned.webContents.executeJavaScript(
					`window.opencutElectron.captureEditorScreenshot(${JSON.stringify(request)})`,
				),
			);
			checks++;
		}
		await assert.rejects(
			other.webContents.executeJavaScript(
				"window.opencutElectron.captureEditorScreenshot({accountId:'local',projectId:'project-a'})",
			),
		);
		checks++;
		check(
			!owned.webContents.debugger.isAttached(),
			"Capture and rejected scope release debugger",
		);
		const again = await connectOwnedWindow(owned.webContents, { appOrigin });
		await owned.loadURL(`${appOrigin}/next`);
		check(
			!owned.webContents.debugger.isAttached(),
			"Navigation revokes transport",
		);
		await assert.rejects(again.page.getByRole("button").click());
		checks++;
		await again.close();
		const closing = await connectOwnedWindow(owned.webContents, { appOrigin });
		owned.destroy();
		await assert.rejects(closing.page.getByRole("button").click());
		checks++;
		await closing.close();
		console.log(JSON.stringify({ type: "owned-playwright-pass", checks }));
	} finally {
		if (!owned.isDestroyed()) owned.destroy();
		other.destroy();
		server.close();
	}
}

run().then(
	() => app.exit(0),
	(error) => {
		console.error(error, error.cause);
		app.exit(1);
	},
);
