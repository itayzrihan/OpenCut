/** Host lifecycle only. Jobs/snapshots and transitions stay in OpenCutRuntime. */
import { spawn } from "node:child_process";
import {
	access,
	mkdir,
	readFile,
	writeFile,
	rename,
	open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { readRenderQueue } from "./server";
import type { RenderQueueView } from "./types";
const launches = new Map<string, Promise<RenderQueueView["worker"]>>();
const failures = new Map<string, { at: number; message: string }>();
async function executable() {
	const release = resolve(process.cwd(), "../../..");
	const choices = [
		[
			process.env.OPENCUT_RENDER_WORKER_ELECTRON,
			process.env.OPENCUT_RENDER_WORKER_APP,
		],
		[
			join(release, "Electron.app/Contents/MacOS/Electron"),
			join(release, "electron/render-worker.cjs"),
		],
		[
			resolve(
				process.cwd(),
				"../electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
			),
			resolve(process.cwd(), "../electron/app/render-worker.cjs"),
		],
	];
	for (const [binary, entry] of choices)
		if (binary && entry) {
			try {
				await access(binary);
				await access(entry);
				return { binary, entry };
			} catch {}
		}
	throw Error(
		"Background renderer is not installed. Update the local OpenCut app.",
	);
}
export function ensureRenderWorker(
	origin: string,
): Promise<RenderQueueView["worker"]> {
	const account = requireAccount();
	const key = account.id;
	const pending = launches.get(key);
	if (pending) return pending;
	const launch = (async () => {
		const queue = await readRenderQueue();
		if (
			!queue.jobs.some(
				(j) =>
					j.delivery !== "direct" && ["queued", "rendering"].includes(j.status),
			)
		)
			return {
				status: "idle" as const,
				message: "Queue complete. You can close this view.",
			};
		const root = join(accountDataRoot(), "render-queue");
		await mkdir(root, { recursive: true, mode: 0o700 });
		// proper-lockfile keys ownership by target, even with a custom lockfilePath.
		// Never share the canonical queue transaction target with the host lease.
		const release = await lockfile.lock(join(root, "worker-host"), {
			realpath: false,
			lockfilePath: join(root, "worker-host.lock"),
			retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
			stale: 30000,
		});
		try {
			const old = await readFile(join(root, "worker.json"), "utf8")
				.then(JSON.parse)
				.catch(() => null);
			if (
				old?.origin &&
				new URL(old.origin).port === new URL(origin).port &&
				Number.isSafeInteger(old.pid)
			) {
				try {
					process.kill(old.pid, 0);
					return {
						status: "running" as const,
						message: "Rendering in the background. You can close this view.",
					};
				} catch {}
			}
			const failure = failures.get(key);
			if (failure && Date.now() - failure.at < 60000)
				return { status: "unavailable" as const, message: failure.message };
			const { binary, entry } = await executable();
			const token = randomBytes(32).toString("hex");
			const log = await open(join(root, "worker.log"), "a", 0o600);
			const child = spawn(binary, [entry], {
				stdio: ["pipe", log.fd, log.fd],
				detached: true,
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: undefined,
					OPENCUT_RENDER_WORKER_PROFILE: join(root, "worker-profile"),
				},
				windowsHide: true,
			});
			const spawned = new Promise<void>((ok, fail) => {
				child.once("spawn", ok);
				child.once("error", fail);
			});
			try {
				await spawned;
			} finally {
				await log.close();
			}
			child.stdin!.on("error", () => {
				failures.set(key, {
					at: Date.now(),
					message:
						"Background renderer could not start. Retry after updating the local app.",
				});
				child.kill();
			});
			const temp = join(root, `worker-${randomUUID()}.tmp`);
			await writeFile(
				temp,
				JSON.stringify({
					pid: child.pid,
					origin,
					account,
					tokenHash: createHash("sha256").update(token).digest("hex"),
					createdAtMs: Date.now(),
				}),
				{ mode: 0o600 },
			);
			await rename(temp, join(root, "worker.json"));
			child.stdin!.end(
				JSON.stringify({
					origin,
					accountId: account.id,
					token,
					profile: join(root, "worker-profile"),
				}),
			);
			child.unref();
			child.once("exit", (code) => {
				if (code)
					failures.set(key, {
						at: Date.now(),
						message:
							"Background renderer stopped. Open the queue to retry its saved snapshot.",
					});
			});
			return {
				status: "starting" as const,
				message: "Starting background renderer. You can close this view.",
			};
		} finally {
			await release();
		}
	})()
		.catch((error) => ({
			status: "unavailable" as const,
			message: error instanceof Error ? error.message : String(error),
		}))
		.finally(() => launches.delete(key));
	launches.set(key, launch);
	return launch;
}
