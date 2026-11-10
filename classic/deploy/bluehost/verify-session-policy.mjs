#!/usr/bin/env node
// Pure stdin/stdout release gate: never touches account storage or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const [binaryArgument, fixtureArgument] = process.argv.slice(2);
if (!binaryArgument || process.argv.length > 4)
	throw new Error(
		"Usage: node verify-session-policy.mjs /absolute/path/opencut-session-policy [fixture.json]",
	);
assert.ok(
	isAbsolute(binaryArgument),
	"Use the exact absolute candidate binary path",
);
const binary = resolve(binaryArgument);
const fixtureBytes = await readFile(
	fixtureArgument || new URL("session-policy-v6.fixture.json", import.meta.url),
);
const fixture = JSON.parse(fixtureBytes);
assert.equal(fixture.archives.length, 3);
const accountId = "qa-release-policy-account";
const projectId = fixture.projectId;
let calls = 0;
function run(record, request, nowMs, overrides = {}, expectedError) {
	const child = spawnSync(binary, [], {
		input: JSON.stringify({
			record,
			accountId,
			projectId,
			request,
			nowMs,
			...overrides,
		}),
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	calls++;
	if (child.error) throw child.error;
	assert.equal(child.signal, null, "Native policy terminated unexpectedly");
	if (expectedError) {
		assert.notEqual(
			child.status,
			0,
			"Native policy accepted a forbidden transition",
		);
		assert.match(child.stderr, expectedError);
		assert.equal(
			child.stdout,
			"",
			"Rejected transition emitted a persistable record",
		);
		return;
	}
	assert.equal(
		child.status,
		0,
		`Native policy failed: ${child.stderr.slice(0, 4000)}`,
	);
	return JSON.parse(child.stdout);
}
function assertSaved(output, archive) {
	assert.equal(output.result.saved.editorRevision, archive.revision);
	assert.deepEqual(
		output.result.saved.bundle.archive,
		archive,
		"Reopened archive or undo/redo data changed",
	);
	const extensions =
		output.result.saved.bundle.archive.classic.projectExtensions;
	const row = extensions.productionStudio.scriptRows[0];
	assert.equal(row.currentVersion, 2);
	assert.equal(row.versions.length, 2);
	assert.equal(row.versions[1].sourceText, fixture.expected.sourceText);
	assert.equal(
		row.versions[1].latinTransliteration,
		fixture.expected.latinTransliteration,
	);
	assert.equal(
		extensions.productionStudio.referenceSlots[0].approvedVersion,
		1,
	);
	assert.equal(
		extensions.productionStudio.referenceSlots[0].versions[0].referenceId,
		fixture.expected.referenceId,
	);
	assert.equal(
		extensions.generative.productionHandoff.id,
		fixture.expected.handoffId,
	);
}
for (const { name, archive } of fixture.archives) {
	assert.equal(archive.schemaVersion, 6);
	assert.equal(archive.historyEncoding, name);
	const acquire = run(
		"",
		{
			type: "acquire",
			sessionId: "qa-tab-a",
			expectedGeneration: 0,
			takeOver: false,
		},
		1000,
	);
	const commit = {
		type: "commit",
		sessionId: "qa-tab-a",
		generation: 1,
		expectedStorageRevision: 0,
		requestId: `qa-${name}-save`,
		bundle: { archive, agentCheckpoint: null },
	};
	const saved = run(acquire.record, commit, 1001);
	assert.equal(saved.result.storageRevision, 1);
	assert.equal(saved.result.editorRevision, archive.revision);
	const read = run(saved.record, { type: "read" }, 1002);
	assertSaved(read, archive);
	const retry = run(read.record, commit, 1003);
	assert.deepEqual(
		retry.result,
		saved.result,
		"Identical save replay duplicated a revision",
	);
	const released = run(
		retry.record,
		{ type: "release", sessionId: "qa-tab-a", generation: 1 },
		1004,
	);
	const reopened = run(
		released.record,
		{
			type: "acquire",
			sessionId: "qa-tab-b",
			expectedGeneration: 1,
			takeOver: false,
		},
		1005,
	);
	assert.equal(reopened.result.generation, 2);
	assertSaved(reopened, archive);
	run(
		reopened.record,
		{ type: "read" },
		1006,
		{ accountId: "qa-another-account" },
		/another account/i,
	);
	run(
		reopened.record,
		{ ...commit, requestId: "stale-writer" },
		1006,
		{},
		/ownership/i,
	);
	const invalid = structuredClone(archive);
	invalid.classic.projectExtensions.productionStudio.scriptRows[0].versions[0].endMs = 0;
	run(
		reopened.record,
		{
			...commit,
			sessionId: "qa-tab-b",
			generation: 2,
			expectedStorageRevision: 1,
			requestId: "invalid-current",
			bundle: { archive: invalid, agentCheckpoint: null },
		},
		1006,
		{},
		/invalid/i,
	);
	const final = run(reopened.record, { type: "read" }, 1007);
	assertSaved(final, archive);
	assert.equal(final.result.storageRevision, 1);
	console.log(
		`PASS native schema-v6 ${name}: save, exact reopen, history, replay, account fence, stale owner, invalid extension`,
	);
}
console.log(
	JSON.stringify({
		status: "passed",
		calls,
		binary,
		binarySha256: createHash("sha256")
			.update(await readFile(binary))
			.digest("hex"),
		fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
		fixtureWasmSha256: fixture.wasmSha256,
	}),
);
