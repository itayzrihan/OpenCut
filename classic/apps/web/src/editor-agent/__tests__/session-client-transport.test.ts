// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The native archive and parsed test transport envelopes are validated in the dedicated host protocol suite. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mockFetch } from "@/test-support/mock-fetch";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { CanonicalHistoryArchive } from "@/core/canonical-classic-session";
import { EditorSessionClient, EditorSessionFailure } from "../session-client";

test("account changes during response decoding cannot publish the previous account's session", async () => {
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window"),
		oldFetch = globalThis.fetch;
	const currentWindow = { __opencutAccountId: "alice" };
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: currentWindow,
	});
	class SwitchedAccountResponse extends Response {
		override async json() {
			const result: unknown = await super.json();
			currentWindow.__opencutAccountId = "bob";
			return result;
		}
	}
	globalThis.fetch = mockFetch(
		async () =>
			new SwitchedAccountResponse(
				JSON.stringify({
					storageRevision: 0,
					generation: 0,
					lease: null,
					saved: null,
					legacyProject: null,
					legacyHistory: null,
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = new EditorSessionClient({
		accountId: "alice",
		projectId: "classic-project",
	});
	try {
		await expect(client.read()).rejects.toThrow("The active account changed");
	} finally {
		client.dispose();
		globalThis.fetch = oldFetch;
		if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});

test("hung HTTP saves abort without discarding the exact pending request or capturing later edits", async () => {
	const runtime = await createCanonicalTestRuntime();
	const classic = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	runtime.invokeSync(
		"project.classic.session.attach",
		{ projectId: "classic-project", expectedRevision: 0, classic },
		null,
	);
	const archive = runtime.invokeSync(
		"project.classic.session.archive",
		{ projectId: "classic-project" },
		null,
	).result.data as CanonicalHistoryArchive;
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window"),
		oldFetch = globalThis.fetch;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "alice" },
	});
	const commits: Record<string, unknown>[] = [];
	let captures = 0;
	globalThis.fetch = mockFetch(async (_url, init) => {
		const envelope = JSON.parse(String(init?.body)) as {
			projectId: string;
			request: Record<string, unknown>;
		};
		expect(envelope.projectId).toBe("classic-project");
		const request = envelope.request;
		if (request.type === "acquire")
			return Response.json({
				storageRevision: 0,
				generation: 1,
				lease: {
					sessionId: "http-tab",
					generation: 1,
					expiresAtMs: Date.now() + 120000,
				},
				saved: null,
				legacyProject: null,
				legacyHistory: null,
			});
		expect(request.type).toBe("commit");
		commits.push(structuredClone(request));
		if (commits.length === 1)
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) throw new Error("The HTTP request must be cancellable");
				if (signal.aborted) reject(signal.reason);
				else
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
			});
		if (commits.length === 2) expect(captures).toBe(1);
		return Response.json({
			storageRevision: Number(request.expectedStorageRevision) + 1,
			editorRevision: archive.revision,
			requestId: request.requestId,
		});
	});
	const client = new EditorSessionClient({
		accountId: "alice",
		projectId: "classic-project",
		sessionId: "http-tab",
		requestTimeoutMs: 50,
	});
	try {
		await client.acquire({ expectedGeneration: 0 });
		const capture = () => {
			captures += 1;
			return { archive, agentCheckpoint: null };
		};
		let failure: unknown;
		try {
			await client.save(capture);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(EditorSessionFailure);
		expect((failure as EditorSessionFailure).definitive).toBe(false);
		expect((failure as Error).message).toContain("outcome is unknown");
		await client.save(capture);
		expect(captures).toBe(2);
		expect(commits).toHaveLength(3);
		expect(commits[1]).toEqual(commits[0]);
		expect(commits.map((request) => request.expectedStorageRevision)).toEqual([
			0, 0, 1,
		]);
		// Default leases remain short; large archive commits get a bounded
		// two-minute window. Explicit timeouts above still govern all requests.
		const originalSetTimeout = globalThis.setTimeout;
		const deadlines: number[] = [];
		const defaultClient = new EditorSessionClient({
			accountId: "alice",
			projectId: "classic-project",
			sessionId: "http-tab",
		});
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			deadlines.push(Number(args[1]));
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		try {
			await defaultClient.acquire({ expectedGeneration: 0 });
			await defaultClient.save(capture);
			expect(deadlines).toEqual([30_000, 120_000]);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			defaultClient.dispose();
		}
	} finally {
		client.dispose();
		runtime.free();
		globalThis.fetch = oldFetch;
		if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
}, 20000);
