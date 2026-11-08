/** Authenticated local IO coordinator. Canonical editor state is untouched until
 * the existing fenced relink transaction publishes a verified local original. */
import { mkdir, readFile, stat, realpath, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
	accountDataRoot,
	accountsRoot,
	accountScope,
	requireAccount,
	accountDataLocked,
	type LocalAccount,
} from "@/accounts/server";
import { getProject, listMedia } from "@/services/local-drive/server";
import {
	peerDeviceIdentity,
	peerIdentityProof,
	peerSharingEnabled,
	setPeerSharingEnabled,
	configuredRelayUrl,
} from "./identity";
import { PeerTransport } from "./transport";
import { PeerSource } from "./source";
import {
	downloadOriginal,
	pullRequestSchema,
	transferDirectory,
} from "./download";
import type { PullJob, PeerStatus } from "./types";
import { onAccountDisconnect } from "@/accounts/lifecycle";

type Runtime = {
	account: LocalAccount;
	lease: number;
	transport: PeerTransport | null;
	connecting: Promise<void> | null;
	retryAt: number;
	error: string | null;
	jobs: Map<string, { job: PullJob; controller: AbortController }>;
};
const globalHost = globalThis as typeof globalThis & {
	__opencutPeerSync?: Map<string, Runtime>;
};
const runtimes = (globalHost.__opencutPeerSync ??= new Map<string, Runtime>());
onAccountDisconnect({
	name: "peer-sync",
	listener: (accountId) => {
		const state = runtimes.get(`${accountsRoot()}:${accountId}`);
		if (!state) return;
		state.lease = 0;
		state.transport?.close();
		for (const live of state.jobs.values()) live.controller.abort();
	},
});
function runtime() {
	const account = requireAccount(),
		key = `${accountsRoot()}:${account.id}`;
	let value = runtimes.get(key);
	if (!value) {
		value = {
			account,
			lease: 0,
			transport: null,
			connecting: null,
			retryAt: 0,
			error: null,
			jobs: new Map(),
		};
		runtimes.set(key, value);
	}
	return value;
}
function root() {
	return join(accountDataRoot(), "peer-transfers");
}
async function ensureConnected({
	state,
	touch,
}: {
	state: Runtime;
	touch: boolean;
}) {
	if (touch) state.lease = Date.now() + 120_000;
	if (
		state.transport?.connected ||
		state.connecting ||
		state.retryAt > Date.now()
	) {
		await state.connecting;
		return;
	}
	state.connecting = (async () => {
		if (!(await peerSharingEnabled())) return;
		const url = configuredRelayUrl();
		if (!url)
			throw new Error(
				"The device relay is not configured on this OpenCut host",
			);
		const proof = await peerIdentityProof(),
			identity = await peerDeviceIdentity(),
			source = new PeerSource();
		state.transport?.close();
		const transport = new PeerTransport({
			url,
			identity,
			...proof,
			active: () => state.lease > Date.now(),
			handle: (request) =>
				accountScope.run(state.account, async () => {
					if (!(await peerSharingEnabled()))
						throw new Error("Device sharing is off");
					if (await accountDataLocked(state.account.id))
						throw new Error("Account restore is in progress");
					return source.handle(request);
				}),
		});
		state.transport = transport;
		await transport.connect();
		state.error = null;
		state.retryAt = 0;
	})()
		.catch((error) => {
			state.error = error instanceof Error ? error.message : String(error);
			state.retryAt = Date.now() + 30_000;
		})
		.finally(() => {
			state.connecting = null;
		});
	await state.connecting;
}
export async function readPeerStatus({
	touch = false,
}: { touch?: boolean } = {}): Promise<PeerStatus> {
	const state = runtime(),
		enabled = await peerSharingEnabled(),
		identity = await peerDeviceIdentity();
	const configured = configuredRelayUrl() !== null;
	if (!enabled) {
		state.lease = 0;
		state.transport?.close();
	}
	const linked = await peerIdentityProof().then(
		() => true,
		() => false,
	);
	if (enabled && touch) await ensureConnected({ state, touch: true });
	let devices: PeerStatus["devices"] = [];
	if (state.transport?.connected && enabled) {
		try {
			devices = await state.transport.devices();
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			state.transport.close();
		}
	}
	return {
		enabled,
		configured,
		linked,
		connected: enabled && !!state.transport?.connected,
		deviceId: identity.id,
		deviceName: identity.name,
		devices,
		error: enabled ? (state.error ?? state.transport?.error ?? null) : null,
	};
}
export async function configurePeerSharing(enabled: boolean) {
	if (enabled) {
		if (!configuredRelayUrl())
			throw new Error(
				"Configure the shared device relay before enabling transfers",
			);
		await peerIdentityProof();
	}
	await setPeerSharingEnabled(enabled);
	const state = runtime();
	state.retryAt = 0;
	state.error = null;
	if (!enabled) {
		state.lease = 0;
		state.transport?.close();
		for (const live of state.jobs.values()) live.controller.abort();
	}
	return readPeerStatus({ touch: enabled });
}
export function disconnectPeerPresence() {
	const state = runtime();
	state.lease = 0;
	state.transport?.close();
	for (const live of state.jobs.values()) live.controller.abort();
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export async function readPullJob({
	projectId,
	operationId,
}: {
	projectId: string;
	operationId: string;
}): Promise<PullJob | null> {
	id.parse(projectId);
	id.parse(operationId);
	if (!(await getProject(projectId)))
		throw new Error("Target project is not owned by this account");
	const current = runtime().jobs.get(`${projectId}:${operationId}`);
	if (current) return { ...current.job };
	const path = join(root(), projectId, operationId, "journal.json");
	try {
		if ((await stat(path)).size > 64_000)
			throw new Error("Invalid transfer journal");
		const journal = JSON.parse(await readFile(path, "utf8"));
		const request = pullRequestSchema.parse(journal.request);
		if (
			request.projectId !== projectId ||
			request.operationId !== operationId ||
			journal.job.projectId !== projectId ||
			journal.job.operationId !== operationId
		)
			throw new Error("Transfer journal scope differs");
		const job = journal.job as PullJob;
		if (job.status === "running")
			return {
				...job,
				status: "failed",
				error:
					"This host stopped during transfer. Resume the same download to retain its partial bytes.",
			};
		return { ...job };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function listPullJobs(projectId: string) {
	id.parse(projectId);
	if (!(await getProject(projectId)))
		throw new Error("Target project is not owned by this account");
	const directory = join(root(), projectId);
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const jobs: PullJob[] = [];
	for (const entry of entries
		.filter((e) => e.isDirectory() && id.safeParse(e.name).success)
		.slice(-1000)) {
		const job = await readPullJob({ projectId, operationId: entry.name });
		if (job) jobs.push(job);
	}
	return jobs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}
export async function startMediaPull({
	input: raw,
	resume = false,
}: {
	input: unknown;
	resume?: boolean;
}): Promise<PullJob> {
	const input = pullRequestSchema.parse(raw),
		state = runtime();
	if (!(await getProject(input.projectId)))
		throw new Error("Target project is not owned by this account");
	const local = (await listMedia(input.projectId)).find(
		(m) => m.id === input.mediaId,
	);
	if (
		!local?.missing ||
		local.unifiedAngles ||
		(local.bindingRevision ?? 0) !== input.expectedBindingRevision
	)
		throw new Error(
			"The original is available, compound, or its binding changed",
		);
	const existing = await readPullJob(input);
	if (existing) {
		for (const key of [
			"mediaId",
			"deviceId",
			"expectedBindingRevision",
		] as const)
			if (existing[key] !== input[key])
				throw new Error(
					"operationId belongs to a different original-file transfer",
				);
		if (existing.status === "running" || existing.status === "ready")
			return existing;
		if (!resume) return existing;
	}
	if (
		[...state.jobs.values()].filter((value) => value.job.status === "running")
			.length >= 2
	)
		throw new Error("At most two original-file downloads can run at once");
	if (!(await peerSharingEnabled()))
		throw new Error("Enable device transfers in account settings first");
	await ensureConnected({ state, touch: true });
	const transport = state.transport;
	if (!transport?.connected)
		throw new Error(state.error || "This device is not connected to the relay");
	const controller = new AbortController();
	const job: PullJob = {
		...input,
		status: "running",
		phase: "checking-source",
		receivedBytes: 0,
		totalBytes: local.size,
		updatedAt: Date.now(),
	};
	const directory = transferDirectory({ root: root(), input });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const bounded = relative(
		await realpath(accountDataRoot()),
		await realpath(directory),
	);
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Transfer staging left this account directory");
	const release = await lockfile.lock(directory, {
		realpath: true,
		retries: 0,
		stale: 60_000,
		update: 10_000,
		onCompromised: () => controller.abort(),
	});
	// Capture account-owned root before the asynchronous job starts. Each callback
	// explicitly restores authenticated scope rather than trusting request IDs.
	const destination = root();
	state.jobs.set(`${input.projectId}:${input.operationId}`, {
		job,
		controller,
	});
	void accountScope.run(state.account, async () => {
		try {
			const { validateMediaPull } = await import("opencut-editor-runtime-wasm");
			await downloadOriginal({
				root: destination,
				input,
				localRecord: local as unknown as Record<string, unknown>,
				job,
				signal: controller.signal,
				validate: validateMediaPull,
				requestPeer: (request) =>
					transport.request({ deviceId: input.deviceId, ...request }),
			});
		} catch (error) {
			job.status = controller.signal.aborted ? "cancelled" : "failed";
			job.error = error instanceof Error ? error.message : String(error);
		} finally {
			await release().catch(() => {});
		}
	});
	return { ...job };
}
export async function cancelMediaPull(input: {
	projectId: string;
	operationId: string;
}) {
	const job = await readPullJob(input);
	if (!job) throw new Error("Original-file transfer does not exist");
	runtime()
		.jobs.get(`${input.projectId}:${input.operationId}`)
		?.controller.abort();
	return job;
}
export async function verifiedPullSource(input: {
	projectId: string;
	operationId: string;
}) {
	const job = await readPullJob(input);
	if (!job || job.status !== "ready" || !job.manifest || !job.source)
		throw new Error("Original download is not verified and ready");
	const request = pullRequestSchema.parse({
		projectId: job.projectId,
		mediaId: job.mediaId,
		deviceId: job.deviceId,
		operationId: job.operationId,
		expectedBindingRevision: job.expectedBindingRevision,
	});
	const base = await realpath(
			transferDirectory({ root: root(), input: request }),
		),
		source = await realpath(job.source);
	const bounded = relative(base, source);
	if (
		!bounded ||
		bounded.startsWith("..") ||
		isAbsolute(bounded) ||
		!(await stat(source)).isFile()
	)
		throw new Error("Downloaded original left its staging scope");
	const expected = join(
		base,
		`verified-original${job.manifest.fileName.slice(job.manifest.fileName.lastIndexOf(".")).toLowerCase()}`,
	);
	if (source !== (await realpath(expected)))
		throw new Error("Downloaded original differs from its manifest path");
	const current = await stat(source),
		previous = job.sourceVersion;
	if (
		!previous ||
		current.size !== previous.size ||
		current.mtimeMs !== previous.mtimeMs ||
		current.ctimeMs !== previous.ctimeMs ||
		current.ino !== previous.ino
	)
		throw new Error(
			"Verified original changed after downloading; resume verification before linking",
		);
	return { job, source };
}
