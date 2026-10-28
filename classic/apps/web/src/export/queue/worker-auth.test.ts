import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { authenticateRenderWorker } from "./worker-auth";
const root = await mkdtemp(join(tmpdir(), "render-auth-"));
const id = "11111111-1111-4111-8111-111111111111",
	token = "a".repeat(64),
	origin = "http://localhost:3211";
const dir = join(root, "data", id, "render-queue");
await mkdir(dir, { recursive: true });
await writeFile(
	join(dir, "worker.json"),
	JSON.stringify({
		origin,
		account: { id, login: "fixture", displayName: "Fixture" },
		tokenHash: createHash("sha256").update(token).digest("hex"),
	}),
);
afterAll(() => rm(root, { recursive: true, force: true }));
function req(path: string, method = "GET", body?: unknown, auth = token) {
	return new Request(origin + path, {
		method,
		headers: {
			"x-opencut-account": id,
			"x-opencut-render-worker": auth,
			"content-type": "application/json",
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}
test("renderer can consume frozen queue inputs and report an attempt", async () => {
	expect(
		(
			await authenticateRenderWorker(
				req("/api/render-queue/file?job=fixture&kind=media"),
				root,
			)
		).id,
	).toBe(id);
	expect(
		(
			await authenticateRenderWorker(
				req("/api/render-queue", "POST", {
					action: "report",
					attempt: "fixture",
				}),
				root,
			)
		).id,
	).toBe(id);
});
test("renderer token cannot edit projects, manage identity, enqueue or cancel work", async () => {
	for (const request of [
		req("/api/local-drive", "POST", { operation: "project.put" }),
		req("/api/accounts"),
		req("/api/render-queue", "POST", { action: "enqueue" }),
		req("/api/render-queue", "POST", { action: "cancel" }),
	])
		await expect(authenticateRenderWorker(request, root)).rejects.toThrow(
			"outside",
		);
	await expect(
		authenticateRenderWorker(
			req("/api/render-queue", "GET", undefined, "b".repeat(64)),
			root,
		),
	).rejects.toThrow("expired");
	await expect(
		authenticateRenderWorker(
			new Request("http://example.com/api/render-queue", {
				headers: { "x-opencut-account": id, "x-opencut-render-worker": token },
			}),
			root,
		),
	).rejects.toThrow("origin");
});

test("uses actual Host when Next normalizes a loopback alias", async () => {
	const request = new Request("http://127.0.0.1:3211/api/render-queue", {
		headers: {
			host: "localhost:3211",
			"x-opencut-account": id,
			"x-opencut-render-worker": token,
		},
	});
	expect((await authenticateRenderWorker(request, root)).id).toBe(id);
	const hostile = new Request(origin + "/api/render-queue", {
		headers: {
			host: "example.com:3211",
			"x-opencut-account": id,
			"x-opencut-render-worker": token,
		},
	});
	await expect(authenticateRenderWorker(hostile, root)).rejects.toThrow(
		"origin",
	);
});
