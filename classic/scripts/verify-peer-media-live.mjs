#!/usr/bin/env node
/** Public-relay acceptance with a previously verified, private Legitate proof.
 * Uses the production transport and synthetic bytes, never project media.
 * Two logical peers on one host do not replace two-physical-device acceptance.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately no arbitrary credential destination argument.
const relay = "https://opencut-peer-sync.85-215-209-220.sslip.io";
const reportDirectory = fileURLToPath(
	new URL("../../.local/peer-sync-qa/", import.meta.url),
);
let stage = "arguments";
let source, target;
const result = {
	url: relay,
	scope:
		"real Legitate proof; production transport; two logical peers; synthetic bytes",
	passed: false,
};
async function readBoundedJson(path) {
	assert((await stat(path)).size <= 40_000);
	return JSON.parse(await readFile(path, "utf8"));
}
function identity(name) {
	const keys = generateKeyPairSync("x25519");
	return {
		id: randomUUID(),
		name,
		privateKey: keys.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
		publicKey: keys.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
	};
}
try {
	assert.equal(process.argv.length, 4);
	assert.equal(process.argv[2], "--accounts-root");
	assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
	const accountsRoot = resolve(process.argv[3]);
	stage = "account-binding";
	const binding = await readBoundedJson(
		join(accountsRoot, "legitate-primary.json"),
	);
	assert.match(binding.account?.id ?? "", /^[A-Za-z0-9_-]{1,160}$/);
	assert.match(binding.subjectHash ?? "", /^[a-f0-9]{64}$/);
	stage = "private-identity-proof";
	const proof = await readBoundedJson(
		join(accountsRoot, "peer-credentials", `${binding.account.id}.json`),
	);
	assert.equal(proof.accountId, binding.account.id);
	assert.equal(proof.subjectHash, binding.subjectHash);
	assert.equal(typeof proof.idToken, "string");
	assert(proof.idToken.length > 0 && proof.idToken.length <= 32_768);
	stage = "tls-health";
	const health = await fetch(`${relay}/health`, {
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(health.status, 200);
	assert.equal((await health.json()).service, "opencut-peer-relay");
	result.tlsVerified = true;
	await import("../apps/web/test-support/node-typescript.mjs");
	const { PeerTransport } =
		await import("../apps/web/src/peer-sync/transport.ts");
	const sender = identity("OpenCut network QA source");
	const receiver = identity("OpenCut network QA target");
	const chunkBytes = 256 * 1024;
	const original = Buffer.alloc(chunkBytes + 791);
	for (let index = 0; index < original.length; index++)
		original[index] = index % 251;
	const digest = createHash("sha256").update(original).digest("hex");
	const fixture = { projectId: randomUUID(), mediaId: randomUUID() };
	const options = {
		url: relay,
		owner: proof.subjectHash,
		idToken: proof.idToken,
		active: () => true,
	};
	source = new PeerTransport({
		...options,
		identity: sender,
		handle: async ({ peer, operation, data }) => {
			assert.equal(peer, receiver.id);
			assert.equal(data.projectId, fixture.projectId);
			assert.equal(data.mediaId, fixture.mediaId);
			if (operation === "manifest")
				return { bytes: original.length, sha256: digest };
			assert.equal(operation, "chunk");
			assert(Number.isSafeInteger(data.offset) && data.offset >= 0);
			assert(Number.isSafeInteger(data.length) && data.length > 0);
			assert(
				data.length <= chunkBytes &&
					data.offset + data.length <= original.length,
			);
			return {
				offset: data.offset,
				bytes: original
					.subarray(data.offset, data.offset + data.length)
					.toString("base64"),
			};
		},
	});
	target = new PeerTransport({
		...options,
		identity: receiver,
		handle: async () => {
			throw new Error("QA target serves no files");
		},
	});
	stage = "source-authentication";
	await source.connect();
	stage = "target-authentication";
	await target.connect();
	result.authenticatedPeers = 2;
	stage = "same-owner-discovery";
	assert((await target.devices()).some((device) => device.id === sender.id));
	stage = "encrypted-manifest";
	const signal = AbortSignal.timeout(60_000);
	const manifest = await target.request({
		deviceId: sender.id,
		operation: "manifest",
		data: fixture,
		signal,
	});
	assert.equal(manifest.bytes, original.length);
	assert.equal(manifest.sha256, digest);
	stage = "encrypted-chunks";
	const received = Buffer.alloc(original.length);
	let chunks = 0;
	for (let offset = 0; offset < original.length; offset += chunkBytes) {
		const length = Math.min(chunkBytes, original.length - offset);
		const reply = await target.request({
			deviceId: sender.id,
			operation: "chunk",
			data: { ...fixture, offset, length },
			signal,
		});
		assert.equal(reply.offset, offset);
		const bytes = Buffer.from(reply.bytes, "base64");
		assert.equal(bytes.length, length);
		bytes.copy(received, offset);
		chunks++;
	}
	stage = "checksum";
	assert(received.equals(original));
	assert.equal(createHash("sha256").update(received).digest("hex"), digest);
	Object.assign(result, {
		passed: true,
		bytes: received.length,
		chunks,
		sha256: digest,
	});
} catch (error) {
	// Never print exception messages, credential contents, JWTs or subject IDs.
	Object.assign(result, {
		failedStage: stage,
		errorKind: error instanceof Error ? error.name : "UnknownError",
	});
	process.exitCode = 1;
} finally {
	source?.close();
	target?.close();
	result.checkedAt = new Date().toISOString();
	await mkdir(reportDirectory, { recursive: true });
	await writeFile(
		join(reportDirectory, "live-authenticated-transfer.json"),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result));
}
