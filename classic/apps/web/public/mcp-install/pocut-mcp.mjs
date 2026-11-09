import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const versions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
let config;
try {
	config = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
	const target = new URL(config.endpoint);
	if (!["http:", "https:"].includes(target.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
		target.username || target.password || target.search || target.hash ||
		target.pathname !== "/api/editor-agent/mcp" ||
		!/^pocut-key\.[a-f0-9-]{36}\.[a-f0-9]{64}\.[\w-]{43}$/.test(config.key)) throw new Error();
} catch {
	console.error("Run the POCUT installer to repair this local MCP connection.");
	process.exit(1);
}

async function editorRequest(params) {
	const response = await fetch(config.endpoint, {
		method: params ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${config.key}`,
			...(params ? { "Content-Type": "application/json" } : {}),
		},
		body: params ? JSON.stringify(params) : undefined,
		redirect: "error",
		signal: AbortSignal.timeout(250_000),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(value.error ?? "POCUT editor request failed.");
	return value;
}

function send(id, payload) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	let request;
	try { request = JSON.parse(line); } catch {
		send(null, { error: { code: -32700, message: "Invalid JSON" } });
		continue;
	}
	if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		send(null, { error: { code: -32600, message: "Invalid request" } });
		continue;
	}
	const { id, method, params } = request;
	if (id === undefined) continue;
	try {
		switch (method) {
			case "initialize":
				send(id, { result: {
					protocolVersion: versions.has(params?.protocolVersion) ? params.protocolVersion : "2025-11-25",
					serverInfo: { name: "POCUT Editor", version: "1.0.0" },
					capabilities: { tools: {} },
					instructions: "Keep the linked project open in POCUT. Read the live project and use its project ID and revision with the registered editing tools.",
				} });
				break;
			case "ping":
				send(id, { result: {} });
				break;
			case "tools/list":
				send(id, { result: await editorRequest() });
				break;
			case "tools/call": {
				const value = await editorRequest({ name: params?.name, arguments: params?.arguments });
				send(id, { result: { content: [
					{ type: "text", text: JSON.stringify(value.result) },
					...(value.images ?? []),
				] } });
				break;
			}
			default:
				send(id, { error: { code: -32601, message: "Method not found" } });
		}
	} catch (error) {
		const message = error instanceof Error && error.message !== "fetch failed"
			? error.message : "Could not reach POCUT. Keep the project and private forward open.";
		if (method === "tools/call") send(id, { result: { isError: true, content: [{ type: "text", text: message }] } });
		else send(id, { error: { code: -32000, message } });
	}
}
