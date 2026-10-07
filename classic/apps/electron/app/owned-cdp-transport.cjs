"use strict";

const { randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");

// This is a transport for trusted host code, never an agent tool. In particular,
// Runtime.evaluate is necessary for Playwright's own injected locator scripts;
// no renderer/model may supply CDP messages, scripts or this connection's token.
// Browser/Target/Storage commands are not forwarded to Electron. The synthetic
// browser contains exactly one page backed by the host-owned webContents.
const PAGE_METHODS = new Set([
	"Page.enable",
	"Page.getFrameTree",
	"Page.createIsolatedWorld",
	"Page.setLifecycleEventsEnabled",
	"Page.addScriptToEvaluateOnNewDocument",
	"Page.removeScriptToEvaluateOnNewDocument",
	"Page.getLayoutMetrics",
	"Page.captureScreenshot",
	"Runtime.enable",
	"Runtime.evaluate",
	"Runtime.callFunctionOn",
	"Runtime.releaseObject",
	"Runtime.releaseObjectGroup",
	"Runtime.getProperties",
	"Runtime.runIfWaitingForDebugger",
	"DOM.describeNode",
	"DOM.getContentQuads",
	"DOM.getBoxModel",
	"DOM.scrollIntoViewIfNeeded",
	"DOM.resolveNode",
	"Input.dispatchMouseEvent",
	"Input.dispatchKeyEvent",
	"Input.insertText",
	"Network.enable",
	"Network.disable",
	"Log.enable",
	"Emulation.setEmulatedMedia",
]);

async function createOwnedCdpTransport(webContents, { appOrigin }) {
	if (
		webContents.isDestroyed() ||
		new URL(webContents.getURL()).origin !== appOrigin
	)
		throw new Error("The owned OpenCut window is unavailable");
	const debuggerApi = webContents.debugger;
	if (debuggerApi.isAttached())
		throw new Error("The OpenCut debugger is already in use");
	debuggerApi.attach("1.3");
	const token = randomBytes(32).toString("hex");
	const sessionId = `opencut-${randomBytes(16).toString("hex")}`;
	const server = createServer((_request, response) => {
		response.writeHead(404).end();
	});
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
		perMessageDeflate: false,
	});
	let client;
	let closed = false;
	let announced = false;
	let connectionTimer;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearTimeout(connectionTimer);
		debuggerApi.removeListener("message", onMessage);
		debuggerApi.removeListener("detach", cleanup);
		webContents.removeListener("destroyed", cleanup);
		webContents.removeListener("did-start-navigation", onNavigation);
		for (const socket of sockets.clients) socket.terminate();
		sockets.close();
		server.close();
		server.closeAllConnections();
		if (!webContents.isDestroyed() && debuggerApi.isAttached())
			debuggerApi.detach();
	};
	const send = (message) => {
		if (!closed && client?.readyState === WebSocket.OPEN)
			client.send(JSON.stringify(message));
	};
	function onMessage(_event, method, params, childSession) {
		// Workers, other windows, OOPIFs and browser-level targets are not exposed.
		if (!childSession && !method.startsWith("Target."))
			send({ sessionId, method, params });
	}
	function onNavigation(_event, _url, _inPlace, isMainFrame) {
		if (isMainFrame) cleanup();
	}
	debuggerApi.on("message", onMessage);
	debuggerApi.on("detach", cleanup);
	webContents.on("destroyed", cleanup);
	webContents.on("did-start-navigation", onNavigation);
	try {
		const [{ targetInfo: actualTarget }, version] = await Promise.all([
			debuggerApi.sendCommand("Target.getTargetInfo"),
			debuggerApi.sendCommand("Browser.getVersion"),
		]);
		const targetInfo = {
			targetId: actualTarget.targetId,
			type: "page",
			title: "OpenCut",
			url: webContents.getURL(),
			attached: true,
			canAccessOpener: false,
			browserContextId: sessionId,
		};
		async function dispatch(message) {
			const { method, params = {}, sessionId: requestedSession } = message;
			if (
				closed ||
				webContents.isDestroyed() ||
				new URL(webContents.getURL()).origin !== appOrigin
			)
				throw new Error("The owned window changed");
			if (requestedSession && requestedSession !== sessionId)
				throw new Error("Unknown OpenCut session");
			if (!requestedSession) {
				if (method === "Browser.getVersion") return version;
				if (
					method === "Target.getTargetInfo" &&
					(!params.targetId || params.targetId === targetInfo.targetId)
				)
					return { targetInfo };
				if (
					method === "Target.setAutoAttach" &&
					params.autoAttach === true &&
					params.flatten === true
				) {
					if (!announced) {
						announced = true;
						send({
							method: "Target.attachedToTarget",
							params: { sessionId, targetInfo, waitingForDebugger: false },
						});
					}
					return {};
				}
				throw new Error("Browser-wide CDP is unavailable in OpenCut");
			}
			// Deliberately do not attach to child targets. The renderer's main page
			// alone is enough for editor controls and compositor screenshots.
			if (method === "Target.setAutoAttach") return {};
			if (!PAGE_METHODS.has(method))
				throw new Error(`Unsupported owned-window command: ${method}`);
			return debuggerApi.sendCommand(method, params);
		}
		server.on("upgrade", (request, socket, head) => {
			const provided = Buffer.from(request.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${token}`);
			if (
				closed ||
				client ||
				request.url !== "/opencut" ||
				request.headers.origin ||
				request.socket.remoteAddress !== "127.0.0.1" ||
				provided.length !== expected.length ||
				!timingSafeEqual(provided, expected)
			) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			sockets.handleUpgrade(request, socket, head, (connection) => {
				client = connection;
				clearTimeout(connectionTimer);
				connection.on("error", cleanup);
				connection.on("close", cleanup);
				connection.on("message", async (data, isBinary) => {
					let message;
					try {
						if (isBinary) throw new Error("JSON required");
						message = JSON.parse(data.toString());
						if (
							!Number.isSafeInteger(message.id) ||
							typeof message.method !== "string"
						)
							throw new Error("Invalid CDP request");
					} catch {
						cleanup();
						return;
					}
					try {
						const result = await dispatch(message);
						send({ id: message.id, sessionId: message.sessionId, result });
					} catch (error) {
						send({
							id: message.id,
							sessionId: message.sessionId,
							error: { code: -32000, message: error.message },
						});
					}
				});
			});
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		if (closed) {
			server.close();
			throw new Error("The owned window changed during connection");
		}
		connectionTimer = setTimeout(cleanup, 10_000);
		connectionTimer.unref();
		return {
			endpoint: `ws://127.0.0.1:${server.address().port}/opencut`,
			token,
			close: cleanup,
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}

module.exports = { createOwnedCdpTransport };
