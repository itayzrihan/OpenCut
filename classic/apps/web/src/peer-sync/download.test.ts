// @opencut-test-wasm: real
import { afterAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	mkdtemp,
	writeFile,
	readFile,
	rm,
	readdir,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeerRelay } from "./relay.mjs";
import { PeerTransport } from "./transport";
import { PeerSource, CHUNK_BYTES } from "./source";
import {
	downloadOriginal,
	readPullJournal,
	transferDirectory,
} from "./download";
import type { PullJob, PullManifest, PullRequest } from "./types";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});
function identity(id: string) {
	const k = generateKeyPairSync("x25519");
	return {
		id,
		name: id,
		publicKey: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKey: k.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
	};
}
async function fixture({
	beforeRequest,
}: { beforeRequest?: (signal: AbortSignal) => Promise<void> } = {}) {
	const root = await mkdtemp(join(tmpdir(), "opencut-peer-transfer-"));
	roots.push(root);
	const bytes = Buffer.alloc(CHUNK_BYTES * 3 + 117);
	for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 31) % 251;
	const path = join(root, "original.mp4");
	await writeFile(path, bytes);
	const lastModified = Math.trunc((await stat(path)).mtimeMs);
	const sourceId = identity("source"),
		targetId = identity("target"),
		owner = createHash("sha256").update("verified-user").digest("hex");
	const relay = createPeerRelay({
		verifyIdentity: async (token) => {
			if (token !== "verified") throw new Error("Invalid proof");
			return { owner, expiresAt: Date.now() + 60_000 };
		},
	});
	await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
	const source = new PeerSource({
		project: async (project) => project === "project-1",
		media: async (project, id) =>
			project === "project-1" && id === "media-1"
				? {
						path,
						stat: await stat(path),
						record: {
							id,
							name: "Original",
							type: "video",
							size: bytes.length,
							lastModified,
							fileName: "original.mp4",
							mimeType: "video/mp4",
							storageKind: "linked",
							sourcePath: path,
						},
					}
				: null,
		allow: async (path) => path,
	});
	const sender = new PeerTransport({
		url,
		identity: sourceId,
		idToken: "verified",
		owner,
		active: () => true,
		handle: async (request) => {
			await beforeRequest?.(request.signal);
			return source.handle(request);
		},
	});
	const receiver = new PeerTransport({
		url,
		identity: targetId,
		idToken: "verified",
		owner,
		active: () => true,
		handle: async () => {
			throw new Error("No local originals");
		},
	});
	await sender.connect();
	await receiver.connect();
	const input: PullRequest = {
		projectId: "project-1",
		mediaId: "media-1",
		deviceId: sourceId.id,
		operationId: "pull-1",
		expectedBindingRevision: 0,
	};
	const local = {
		id: input.mediaId,
		name: "Original",
		type: "video",
		size: bytes.length,
		lastModified,
		missing: true,
		duration: 9,
		future: { keep: true },
	};
	const job = (): PullJob => ({
		...input,
		status: "running",
		phase: "checking-source",
		receivedBytes: 0,
		totalBytes: bytes.length,
		updatedAt: Date.now(),
	});
	const validate = async () => {
		// Node/Bun tests initialize the generated bundler glue explicitly. This is
		// the real compiled policy, rather than a JS copy or mock of validation.
		const runtime = await createCanonicalTestRuntime();
		runtime.free();
		return (
			await import("../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js")
		).validateMediaPull;
	};
	const requestPeer = (request: import("./download").RequestPeerInput) =>
		receiver.request({ deviceId: sourceId.id, ...request, timeoutMs: 10_000 });
	const close = async () => {
		sender.close();
		receiver.close();
		relay.closeAllConnections();
		await new Promise<void>((resolve) => relay.close(() => resolve()));
	};
	return {
		root: join(root, "downloads"),
		bytes,
		path,
		input,
		local,
		job,
		validate,
		requestPeer,
		close,
	};
}

test("two online devices transfer encrypted chunks and verify the exact original without editing metadata", async () => {
	const f = await fixture();
	try {
		const before = structuredClone(f.local),
			job = f.job();
		await downloadOriginal({
			...f,
			job,
			requestPeer: f.requestPeer,
			validate: await f.validate(),
			signal: new AbortController().signal,
			localRecord: f.local,
		});
		expect(job.status).toBe("ready");
		expect(job.receivedBytes).toBe(f.bytes.length);
		expect(await readFile(job.source!)).toEqual(f.bytes);
		expect(f.local).toEqual(before);
		const journal = await readPullJournal({ root: f.root, input: f.input });
		expect(journal?.job.status).toBe("ready");
		expect(
			(await readdir(transferDirectory(f))).some((name) =>
				name.endsWith(".partial"),
			),
		).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("cancellation retains partial bytes and explicit retry resumes the same original", async () => {
	const f = await fixture();
	try {
		const controller = new AbortController(),
			first = f.job();
		let chunks = 0;
		await expect(
			downloadOriginal({
				...f,
				job: first,
				validate: await f.validate(),
				signal: controller.signal,
				localRecord: f.local,
				requestPeer: async (request) => {
					if (request.operation === "chunk" && ++chunks === 2)
						controller.abort();
					return f.requestPeer(request);
				},
			}),
		).rejects.toThrow();
		expect(first.status).toBe("cancelled");
		const partial = await stat(join(transferDirectory(f), "original.partial"));
		expect(partial.size).toBe(CHUNK_BYTES);
		const offsets: number[] = [],
			second = f.job();
		await downloadOriginal({
			...f,
			job: second,
			validate: await f.validate(),
			signal: new AbortController().signal,
			localRecord: f.local,
			requestPeer: (request) => {
				if (request.operation === "chunk")
					offsets.push((request.data as { offset: number }).offset);
				return f.requestPeer(request);
			},
		});
		expect(second.status).toBe("ready");
		expect(offsets[0]).toBe(CHUNK_BYTES);
		expect(await readFile(second.source!)).toEqual(f.bytes);
	} finally {
		await f.close();
	}
}, 30_000);

test("cancelling a pull also aborts work on the source device", async () => {
	let started!: () => void, cancelled!: () => void;
	const sourceStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const sourceCancelled = new Promise<void>((resolve) => {
		cancelled = resolve;
	});
	const f = await fixture({
		beforeRequest: (signal) =>
			new Promise<void>((_resolve, reject) => {
				started();
				signal.addEventListener(
					"abort",
					() => {
						cancelled();
						reject(new Error("Cancelled source work"));
					},
					{ once: true },
				);
			}),
	});
	try {
		const controller = new AbortController();
		const result = f.requestPeer({
			operation: "manifest",
			data: { projectId: "project-1", mediaId: "media-1" },
			signal: controller.signal,
		});
		// Bun's .rejects assertion synchronously waits; attach a normal rejection
		// observer until the source is running and cancellation has been sent.
		const rejected = result.then(
			() => null,
			(error) => error as Error,
		);
		await Promise.race([
			sourceStarted,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("Source request never started")),
					3000,
				),
			),
		]);
		controller.abort();
		expect((await rejected)?.message).toContain("interrupted");
		await Promise.race([
			sourceCancelled,
			new Promise((_, reject) =>
				setTimeout(
					() =>
						reject(new Error("Source request did not receive cancellation")),
					3000,
				),
			),
		]);
	} finally {
		await f.close();
	}
}, 10_000);

test("corrupt chunks never publish or relink unverified media", async () => {
	const f = await fixture();
	try {
		const job = f.job();
		let corrupted = false;
		await expect(
			downloadOriginal({
				...f,
				job,
				validate: await f.validate(),
				signal: new AbortController().signal,
				localRecord: f.local,
				requestPeer: async (request) => {
					const response = await f.requestPeer(request);
					if (request.operation === "chunk" && !corrupted) {
						corrupted = true;
						const chunk = response as { data: string };
						const bytes = Buffer.from(chunk.data, "base64");
						bytes[0] ^= 1;
						chunk.data = bytes.toString("base64");
					}
					return response;
				},
			}),
		).rejects.toThrow("checksum");
		expect(job.status).toBe("failed");
		expect(job.source).toBeUndefined();
		expect(f.local.missing).toBe(true);
		const files = await readdir(transferDirectory(f));
		expect(files.some((name) => name.startsWith("verified-original"))).toBe(
			false,
		);
		expect(files.some((name) => name.startsWith("rejected-"))).toBe(true);
	} finally {
		await f.close();
	}
}, 30_000);

test("a different request cannot overwrite a durable operation journal", async () => {
	const f = await fixture();
	try {
		await downloadOriginal({
			...f,
			job: f.job(),
			validate: await f.validate(),
			signal: new AbortController().signal,
			localRecord: f.local,
		});
		const path = join(transferDirectory(f), "journal.json"),
			before = await readFile(path);
		await expect(
			downloadOriginal({
				...f,
				input: { ...f.input, mediaId: "other-media" },
				job: f.job(),
				validate: await f.validate(),
				signal: new AbortController().signal,
				localRecord: f.local,
			}),
		).rejects.toThrow("different transfer");
		expect(await readFile(path)).toEqual(before);
	} finally {
		await f.close();
	}
}, 30_000);

test("source grants cannot read another project, device or a changed source", async () => {
	const f = await fixture();
	try {
		await expect(
			f.requestPeer({
				operation: "manifest",
				data: { projectId: "other-project", mediaId: "media-1" },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
		const grant = (await f.requestPeer({
			operation: "manifest",
			data: { projectId: "project-1", mediaId: "media-1" },
			signal: new AbortController().signal,
		})) as { grantId: string; manifest: PullManifest };
		await writeFile(f.path, Buffer.alloc(f.bytes.length, 4));
		await expect(
			f.requestPeer({
				operation: "chunk",
				data: { grantId: grant.grantId, offset: 0, bytes: 10 },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
	} finally {
		await f.close();
	}
}, 30_000);
