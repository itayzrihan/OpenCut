import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

type Controls = {
	isRunning: () => Promise<boolean>;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	startupEnabled: () => Promise<boolean>;
	setStartup: (enabled: boolean) => Promise<void>;
};

function page({
	path,
	running,
	startup,
	error,
}: {
	path: string;
	running: boolean;
	startup: boolean;
	error: boolean;
}) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>POCUT Companion</title>
<style>
:root{color-scheme:dark;font:16px system-ui,sans-serif;color:#f7f3ff;background:#100e17}
body{min-height:100dvh;display:grid;place-items:center;margin:0}
main{box-sizing:border-box;width:min(calc(100% - 2rem),28rem);padding:1.75rem;border:1px solid #393044;border-radius:1rem;background:#1a1524}
h1{margin:0 0 1.5rem;font-size:1.4rem}
form{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.9rem 0;border-top:1px solid #393044}
.status{display:block;margin-top:.25rem;font-size:.85rem;color:#c4bacf}
.on{color:#86efac}
button{font:inherit;font-size:.9rem;padding:.45rem .75rem;border:1px solid #695580;border-radius:.5rem;background:#30243f;color:inherit;cursor:pointer}
button:hover{background:#49335e}button:focus-visible{outline:2px solid #d1aeff;outline-offset:3px}
[role=alert]{color:#fda4af}
</style></head><body><main><h1>POCUT Companion</h1>
${error ? '<p role="alert">Could not update the Companion. Try again from the desktop shortcut.</p>' : ""}
<form method="post" action="${path}"><div>Companion <span class="status ${running ? "on" : ""}" role="status">${running ? "Running" : "Stopped"}</span></div>
<button name="action" value="${running ? "stop" : "start"}">${running ? "Turn off" : "Turn on"}</button></form>
<form method="post" action="${path}"><div>Start when I sign in <span class="status ${startup ? "on" : ""}">${startup ? "On" : "Off"}</span></div>
<button name="action" value="${startup ? "disable-startup" : "enable-startup"}">${startup ? "Disable" : "Enable"}</button></form>
</main></body></html>`;
}

/** Opens a short-lived, private loopback page from the installed desktop shortcut. */
export async function serveManager(controls: Controls) {
	const key = randomBytes(32).toString("hex");
	const path = "/" + key;
	let origin = "";
	let working = false;
	const actions = new Map([
		["start", controls.start],
		["stop", controls.stop],
		["enable-startup", () => controls.setStartup(true)],
		["disable-startup", () => controls.setStartup(false)],
	]);
	const server = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		// Keep the Origin header on same-origin browser form submissions.
		res.setHeader("Referrer-Policy", "same-origin");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		if (
			`http://${req.headers.host}` !== origin ||
			(req.url !== path && req.url !== path + "?error=1")
		) {
			res.writeHead(404).end();
			return;
		}
		if (req.method === "POST") {
			if (
				req.headers.origin !== origin ||
				req.url !== path ||
				req.headers["content-type"] !== "application/x-www-form-urlencoded"
			) {
				res.writeHead(403).end();
				return;
			}
			let body = "";
			try {
				for await (const chunk of req) {
					body += String(chunk);
					if (body.length > 128) {
						res.writeHead(413).end();
						return;
					}
				}
			} catch {
				res.writeHead(400).end();
				return;
			}
			const action = actions.get(new URLSearchParams(body).get("action") ?? "");
			if (!action || working) {
				res.writeHead(409).end();
				return;
			}
			working = true;
			try {
				await action();
				res.writeHead(303, { Location: path }).end();
			} catch {
				res.writeHead(303, { Location: path + "?error=1" }).end();
			} finally {
				working = false;
			}
		} else if (req.method === "GET") {
			try {
				const [running, startup] = await Promise.all([
					controls.isRunning(),
					controls.startupEnabled(),
				]);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page({ path, running, startup, error: req.url !== path }));
			} catch {
				res
					.writeHead(503)
					.end("Open the POCUT Companion desktop shortcut again.");
			}
		} else {
			res.writeHead(405).end();
		}
		idle.refresh();
	});
	const idle = setTimeout(() => server.close(), 15 * 60_000);
	idle.unref();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Manager listener unavailable");
	origin = `http://127.0.0.1:${address.port}`;
	server.on("close", () => clearTimeout(idle));
	return { url: origin + path, server };
}
