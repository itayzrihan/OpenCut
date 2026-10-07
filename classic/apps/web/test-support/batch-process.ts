// Separate host process for batch locking integration tests. Domain transitions
// have native Rust coverage; this fixture exercises the actual queue/file IO.
import { mock } from "bun:test";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.OPENCUT_BATCH_TEST_ROOT;
if (!root) throw new Error("Missing isolated fixture root");
const input = JSON.parse(process.argv[2]);
const wait = async (name: string) => {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (
			await access(join(root, name)).then(
				() => true,
				() => false,
			)
		)
			return;
		await Bun.sleep(20);
	}
	throw new Error(`Fixture barrier timed out: ${name}`);
};
mock.module("@/services/local-drive/server", () => ({
	getLocalDriveStatus: async () => ({ rootPath: root }),
	getProject: async (id: string) => {
		// Widen a read/modify/write race without changing the queue implementation.
		await Bun.sleep(100);
		return readFile(join(root, `${id}.json`), "utf8")
			.then(JSON.parse)
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
	},
}));
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => ["preflight", "save"],
	batchEditIsLocked: ({ status }: { status: string }) =>
		["queued", "importing", "ready", "running"].includes(status),
	batchEditTransition: ({ event }: { event: string }) =>
		event === "interrupt" ? "interrupted" : "cancelled",
}));
const { createProjectEdit, withBatchProjectWrite } =
	await import("../src/batch/server");
await writeFile(join(root, `${input.id}.ready`), "ready");
if (input.gate) await wait(input.gate);
try {
	if (input.mode === "hold") {
		await withBatchProjectWrite({
			projectId: input.projectId,
			token: null,
			write: async ({ assertLock }) => {
				await writeFile(join(root, `${input.id}.entered`), "entered");
				await wait(`${input.id}.release`);
				assertLock();
				await writeFile(
					join(root, `${input.projectId}.json`),
					JSON.stringify({
						metadata: { name: "Changed by first host", updatedAt: "new" },
					}),
				);
			},
		});
		console.log(JSON.stringify({ ok: true }));
	} else {
		await createProjectEdit({
			id: input.id,
			projectId: input.projectId,
			expectedUpdatedAt: "old",
			options: {
				zoom: false,
				transitions: false,
				wordAnimation: false,
				music: false,
			},
		});
		console.log(JSON.stringify({ ok: true }));
	}
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error) }));
}
