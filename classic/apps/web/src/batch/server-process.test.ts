/* eslint-disable opencut/prefer-object-params -- Short fixture helpers bind isolated directories to child inputs. */
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "opencut-batch-process-"));
const children: ReturnType<typeof Bun.spawn>[] = [];
const fixture = fileURLToPath(
	new URL("../../test-support/batch-process.ts", import.meta.url),
);
async function setup(name: string, projects: string[]) {
	const directory = join(root, name);
	await mkdir(directory);
	for (const id of projects)
		await writeFile(
			join(directory, `${id}.json`),
			JSON.stringify({
				metadata: { name: id, updatedAt: "old" },
			}),
		);
	return directory;
}
function start(
	directory: string,
	input: { id: string; projectId: string; mode?: string; gate?: string },
) {
	const child = Bun.spawn([process.execPath, fixture, JSON.stringify(input)], {
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
		env: { ...process.env, OPENCUT_BATCH_TEST_ROOT: directory },
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const result = (async () => {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`Fixture failed: ${stderr}`);
		return z
			.object({ ok: z.boolean(), error: z.string().optional() })
			.parse(JSON.parse(stdout));
	})();
	// Keep failed child output observable even if a barrier fails first.
	void result.catch(() => {});
	return result;
}
async function waitFor(path: string) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (
			await access(path).then(
				() => true,
				() => false,
			)
		)
			return;
		await Bun.sleep(20);
	}
	throw new Error(`Barrier was not reached: ${path}`);
}
afterAll(async () => {
	for (const child of children) if (child.exitCode === null) child.kill();
	await Promise.all(children.map((child) => child.exited));
	const bounded = relative(resolve(tmpdir()), resolve(root));
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Unsafe fixture cleanup");
	await rm(root, { recursive: true, force: true });
});

test("independent hosts cannot reserve the same existing project twice", async () => {
	const directory = await setup("same-project", ["project"]);
	const inputs = ["first", "second"].map((id) => ({
		id,
		projectId: "project",
		gate: "go",
	}));
	const pending = inputs.map((input) => start(directory, input));
	await Promise.all(
		inputs.map((input) => waitFor(join(directory, `${input.id}.ready`))),
	);
	await writeFile(join(directory, "go"), "go");
	const results = await Promise.all(pending);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
	expect(results.find((result) => !result.ok)?.error).toContain(
		"active automatic edit",
	);
	const stored = JSON.parse(
		await readFile(join(directory, "batch/queue.json"), "utf8"),
	);
	expect(stored.runs).toHaveLength(1);
}, 20_000);

test("concurrent hosts preserve both unrelated queue submissions", async () => {
	const directory = await setup("distinct-projects", ["one", "two"]);
	const pending = ["one", "two"].map((id) =>
		start(directory, { id, projectId: id, gate: "go" }),
	);
	await Promise.all(
		["one", "two"].map((id) => waitFor(join(directory, `${id}.ready`))),
	);
	await writeFile(join(directory, "go"), "go");
	expect(await Promise.all(pending)).toEqual([{ ok: true }, { ok: true }]);
	const stored = JSON.parse(
		await readFile(join(directory, "batch/queue.json"), "utf8"),
	);
	expect(stored.runs.map((run: { id: string }) => run.id).sort()).toEqual([
		"one",
		"two",
	]);
}, 20_000);

test("handoff in another host waits for publication and detects its changed revision", async () => {
	const directory = await setup("handoff", ["project"]);
	const writer = start(directory, {
		id: "writer",
		projectId: "project",
		mode: "hold",
	});
	await waitFor(join(directory, "writer.entered"));
	const enqueue = start(directory, { id: "enqueue", projectId: "project" });
	await waitFor(join(directory, "enqueue.ready"));
	// Another account remains writable while the first account's IO is held.
	const other = await setup("other-account", ["project"]);
	expect(await start(other, { id: "unrelated", projectId: "project" })).toEqual(
		{ ok: true },
	);
	await writeFile(join(directory, "writer.release"), "release");
	expect(await writer).toEqual({ ok: true });
	expect((await enqueue).error).toContain("Project changed before handoff");
}, 20_000);
