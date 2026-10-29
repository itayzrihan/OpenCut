const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createComputerService } = require("../app/agent-computer.cjs");
const scope = {
	accountId: "alice",
	projectId: "film",
	generation: 1,
	mode: "askDestructive",
};
async function fixture(t, options = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencut-computer-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const prompts = [];
	let allowed = true,
		valid = true;
	const service = createComputerService({
		confirm: async (info) => {
			prompts.push(info);
			return allowed;
		},
		assertScope: async () => {
			if (!valid) throw Error("Scope changed");
		},
		...options,
	});
	t.after(() => service.revoke());
	const execute = (operation, id = "op-1", extra = {}) =>
		service.execute({ ...scope, operationId: id, operation, ...extra });
	return {
		dir,
		service,
		prompts,
		execute,
		deny: () => {
			allowed = false;
		},
		invalidate: () => {
			valid = false;
		},
	};
}
test("computer is disabled by default, grants are scoped and revocation fences IO", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.execute({ type: "list", path: f.dir }), /off/);
	await f.service.setAccess({ ...scope, enabled: true });
	await assert.rejects(
		f.execute({ type: "list", path: f.dir }, "other", { projectId: "other" }),
		/off/,
	);
	f.service.revoke();
	await assert.rejects(f.execute({ type: "list", path: f.dir }), /off/);
});
test("inspection and optimistic writes ask exact native approval; replay is idempotent", async (t) => {
	const f = await fixture(t);
	await f.service.setAccess({ ...scope, enabled: true });
	const file = path.join(f.dir, "notes.txt"),
		op = { type: "write", path: file, content: "hello", expectedSha256: null };
	const result = await f.execute(op);
	assert.equal(await fs.readFile(file, "utf8"), "hello");
	assert.equal(f.prompts.length, 2);
	assert.match(f.prompts[1].detail, /hello/);
	assert.deepEqual(await f.execute(op), result);
	assert.equal(f.prompts.length, 2);
	await assert.rejects(f.execute({ ...op, content: "changed" }), /identity/);
	const read = JSON.parse(
		(await f.execute({ type: "read", path: file, offset: 0 }, "read")).text,
	);
	assert.equal(read.text, "hello");
	assert.equal(f.prompts.length, 2);
	await f.execute(
		{ ...op, content: "world", expectedSha256: read.sha256 },
		"update",
	);
	const failed = await f
		.execute({ ...op, content: "stale", expectedSha256: read.sha256 }, "stale")
		.catch((e) => e);
	assert.match(failed.message, /changed/);
	assert.equal(await fs.readFile(file, "utf8"), "world");
});
test("plan allows reads but blocks changes and all shell commands", async (t) => {
	const f = await fixture(t),
		plan = { ...scope, mode: "plan" };
	await f.service.setAccess({ ...plan, enabled: true });
	await f.execute({ type: "list", path: f.dir }, "list", plan);
	await assert.rejects(
		f.execute({ type: "mkdir", path: path.join(f.dir, "bad") }, "mkdir", plan),
		/Plan/,
	);
	await assert.rejects(
		f.execute(
			{ type: "shell", command: "pwd", cwd: f.dir, timeoutMs: 1000 },
			"shell",
			plan,
		),
		/Plan/,
	);
	assert.equal(f.prompts.length, 1);
});
test("full access permits file operations and shell without per-operation prompts", async (t) => {
	const f = await fixture(t),
		full = { ...scope, mode: "fullAccess" };
	await f.service.setAccess({ ...full, enabled: true });
	await f.execute(
		{ type: "mkdir", path: path.join(f.dir, "new") },
		"mkdir",
		full,
	);
	const result = JSON.parse(
		(
			await f.execute(
				{
					type: "shell",
					command: "printf agent-ok",
					cwd: f.dir,
					timeoutMs: 2000,
				},
				"shell",
				full,
			)
		).text,
	);
	assert.equal(result.output, "agent-ok");
	assert.equal(result.exitCode, 0);
	assert.equal(f.prompts.length, 1);
});
test("denied destructive actions never execute", async (t) => {
	const f = await fixture(t);
	await f.service.setAccess({ ...scope, enabled: true });
	f.deny();
	await assert.rejects(
		f.execute({
			type: "write",
			path: path.join(f.dir, "denied"),
			content: "no",
			expectedSha256: null,
		}),
		/denied/,
	);
	assert.deepEqual(await fs.readdir(f.dir), []);
});
test("cancellation while approval is open prevents subsequent execution", async (t) => {
	let resolve, started;
	const pending = new Promise((r) => {
		started = r;
	});
	let calls = 0;
	const f = await fixture(t, {
		confirm: async () => {
			if (++calls === 1) return true;
			started();
			return new Promise((r) => {
				resolve = r;
			});
		},
	});
	await f.service.setAccess({ ...scope, enabled: true });
	const job = f.execute({
		type: "write",
		path: path.join(f.dir, "late"),
		content: "no",
		expectedSha256: null,
	});
	await pending;
	f.service.cancel();
	resolve(true);
	await assert.rejects(job, /revoked/);
	assert.deepEqual(await fs.readdir(f.dir), []);
});
test("revoking permission terminates an active shell process group", async (t) => {
	const f = await fixture(t),
		full = { ...scope, mode: "fullAccess" };
	await f.service.setAccess({ ...full, enabled: true });
	const job = f.execute(
		{ type: "shell", command: "sleep 10", cwd: f.dir, timeoutMs: 20000 },
		"long",
		full,
	);
	await new Promise((r) => setTimeout(r, 100));
	f.service.revoke();
	const result = JSON.parse((await job).text);
	assert.equal(result.stopped, "cancelled");
});
test("scope changes and binary reads fail without granting extra authority", async (t) => {
	const f = await fixture(t);
	await f.service.setAccess({ ...scope, enabled: true });
	const file = path.join(f.dir, "binary");
	await fs.writeFile(file, Buffer.from([255, 0, 128]));
	await assert.rejects(
		f.execute({ type: "read", path: file, offset: 0 }),
		/encoded data/,
	);
	f.invalidate();
	await assert.rejects(
		f.execute({ type: "list", path: f.dir }, "changed"),
		/Scope changed/,
	);
});

test("a revocation while the enable dialog is open cannot revive computer access", async (t) => {
	let resolve, opened;
	const shown = new Promise((r) => {
		opened = r;
	});
	const f = await fixture(t, {
		confirm: () => {
			opened();
			return new Promise((r) => {
				resolve = r;
			});
		},
	});
	const pending = f.service.setAccess({ ...scope, enabled: true });
	await shown;
	f.service.revoke();
	resolve(true);
	assert.deepEqual(await pending, { enabled: false });
	await assert.rejects(f.execute({ type: "list", path: f.dir }), /off/);
});

test("UTF-8 chunk boundaries and old receipts survive cancellation without redoing writes", async (t) => {
	const f = await fixture(t);
	await f.service.setAccess({ ...scope, enabled: true });
	const file = path.join(f.dir, "unicode.txt"),
		text = "x" + "א".repeat(3000) + "end";
	const op = { type: "write", path: file, content: text, expectedSha256: null };
	const receipt = await f.execute(op, "unicode");
	const first = JSON.parse(
		(await f.execute({ type: "read", path: file, offset: 0 }, "chunk1")).text,
	);
	const second = JSON.parse(
		(
			await f.execute(
				{ type: "read", path: file, offset: first.nextOffset },
				"chunk2",
			)
		).text,
	);
	assert.equal(first.text + second.text, text);
	assert.equal(first.sha256, second.sha256);
	f.service.revoke();
	assert.deepEqual(await f.execute(op, "unicode"), receipt);
	assert.equal(f.prompts.length, 2);
});
