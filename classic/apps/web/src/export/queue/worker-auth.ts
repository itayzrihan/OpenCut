/** A background renderer may read frozen inputs and report/upload its queue
 * attempts. It cannot edit projects, enqueue work, manage accounts or run IO tools. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type { LocalAccount } from "@/accounts/server";
export const RENDER_WORKER_HEADER = "x-opencut-render-worker";
export async function authenticateRenderWorker(
	request: Request,
	accountsRoot: string,
): Promise<LocalAccount> {
	const accountId = request.headers.get("x-opencut-account") ?? "";
	const token = request.headers.get(RENDER_WORKER_HEADER) ?? "";
	if (!/^[a-f0-9-]{36}$/.test(accountId) || !/^[a-f0-9]{64}$/.test(token))
		throw Error("Invalid renderer session");
	const lease = JSON.parse(
		await readFile(
			join(accountsRoot, "data", accountId, "render-queue", "worker.json"),
			"utf8",
		),
	);
	const url = new URL(request.url);
	// Next may normalize request.url to localhost even when the browser used
	// 127.0.0.1. The account adapter already validates the actual Host.
	const actualOrigin = new URL(
		`${url.protocol}//${request.headers.get("host") ?? url.host}`,
	);
	if (
		![url, actualOrigin].every((u) =>
			["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
		) ||
		actualOrigin.origin !== lease.origin ||
		lease.account?.id !== accountId
	)
		throw Error("Renderer origin mismatch");
	const actual = Buffer.from(createHash("sha256").update(token).digest("hex"));
	const expected = Buffer.from(lease.tokenHash ?? "");
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		throw Error("Renderer session expired");
	let allowed = false;
	if (url.pathname === "/api/render-queue") {
		allowed = request.method === "GET";
		if (request.method === "POST") {
			const body = await request.clone().json();
			allowed = ["claim", "report"].includes(body.action);
		}
	} else if (url.pathname === "/api/render-queue/file")
		allowed = ["GET", "HEAD", "PUT"].includes(request.method);
	else if (
		url.pathname.startsWith("/api/account-assets/") ||
		url.pathname.startsWith("/api/global-assets/")
	)
		allowed = ["GET", "HEAD"].includes(request.method);
	else if (url.pathname === "/api/hyperframes")
		allowed = ["GET", "POST", "DELETE"].includes(request.method);
	if (!allowed) throw Error("This API is outside the renderer session");
	return lease.account;
}
