import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import * as store from "@/generative/server/store";
import * as vault from "@/generative/server/vault";
import { audioDraftSchema, type AudioDraft, type AudioJob } from "./types";
const API = "https://api.elevenlabs.io/v1";
const active = new Map<string, Promise<void>>();
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_ACCOUNT = 2 * 1024 * 1024 * 1024;
const WORKER_STALE_MS = 300_000;
const workerPath = ({ root, id }: { root: string; id: string }) =>
	join(root, "workers", store.validId(id));
async function workerActive({ root, id }: { root: string; id: string }) {
	return lockfile.check(workerPath({ root, id }), {
		realpath: false,
		stale: WORKER_STALE_MS,
	});
}
type Fetcher = typeof fetch;
export function audioRequest(draft: AudioDraft) {
	const d = audioDraftSchema.parse(draft);
	switch (d.kind) {
		case "speech":
			return {
				path: `/text-to-speech/${d.voiceId}`,
				body: { text: d.text, model_id: d.modelId },
			};
		case "dialogue":
			return {
				path: "/text-to-dialogue",
				body: {
					inputs: d.dialogue.map((l) => ({
						text: l.text,
						voice_id: l.voiceId,
					})),
					model_id: d.modelId,
				},
			};
		case "sound":
			return {
				path: "/sound-generation",
				body: {
					text: d.text,
					model_id: d.modelId,
					...(d.durationSeconds == null
						? {}
						: { duration_seconds: d.durationSeconds }),
				},
			};
		case "music":
			return {
				path: "/music",
				body: {
					prompt: d.text,
					model_id: d.modelId,
					...(d.durationSeconds == null
						? {}
						: { music_length_ms: Math.round(d.durationSeconds * 1000) }),
					force_instrumental: d.instrumental,
				},
			};
	}
}
async function locked<T>({
	root,
	task,
}: {
	root: string;
	task: () => Promise<T>;
}) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(root, {
		realpath: false,
		stale: 300000,
		retries: { retries: 20, minTimeout: 30, maxTimeout: 150 },
	});
	try {
		return await task();
	} finally {
		await release();
	}
}
const save = ({ root, job }: { root: string; job: AudioJob }) =>
	store.saveJson({
		root: join(root, "jobs"),
		name: job.id + ".json",
		value: job,
	});
export async function jobRead({
	root,
	projectId,
	id,
}: {
	root: string;
	projectId: string;
	id: string;
}) {
	store.validProject(projectId);
	store.validId(id);
	const job = await store.json<AudioJob>({
		root: join(root, "jobs"),
		name: id + ".json",
	});
	if (job.projectId !== projectId) throw new Error("Audio request not found");
	return job;
}
export async function audioJobs({
	root,
	projectId,
}: {
	root: string;
	projectId: string;
}) {
	store.validProject(projectId);
	const names = await readdir(join(root, "jobs")).catch(() => [] as string[]);
	const jobs: AudioJob[] = [];
	for (const name of names.filter((n) => /^[a-f0-9]{32}\.json$/.test(n))) {
		const job = await store.json<AudioJob>({ root: join(root, "jobs"), name });
		if (job.projectId === projectId)
			jobs.push(
				job.status === "submitted" &&
					!(await workerActive({ root, id: job.id }))
					? {
							...job,
							status: "uncertain",
							message:
								"The provider request may have completed. Check ElevenLabs history before creating another request.",
						}
					: job,
			);
	}
	return jobs.sort((a, b) => b.createdAt - a.createdAt);
}
export async function prepareAudio({
	root,
	projectId,
	operationId,
	draft,
}: {
	root: string;
	projectId: string;
	operationId: string;
	draft: unknown;
}) {
	store.validProject(projectId);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
		throw new Error("Invalid audio operation ID");
	const checked = audioDraftSchema.parse(draft);
	const digest = store.sha(JSON.stringify({ projectId, draft: checked }));
	const id = store.sha(projectId + ":" + operationId).slice(0, 32);
	return locked({
		root,
		task: async () => {
			const existing = await jobRead({ root, projectId, id }).catch((error) => {
				if (
					(error instanceof Error && "code" in error
						? error.code
						: undefined) !== "ENOENT"
				)
					throw error;
				return null;
			});
			if (existing) {
				if (existing.digest !== digest)
					throw new Error(
						"Audio operation already exists with different content",
					);
				return existing;
			}
			const names = await readdir(join(root, "jobs")).catch(
				() => [] as string[],
			);
			if (names.length >= 400)
				throw new Error("Audio request limit reached for this account");
			const job: AudioJob = {
				id,
				projectId,
				digest,
				draft: checked,
				status: "review",
				createdAt: Date.now(),
			};
			await save({ root, job });
			return job;
		},
	});
}
async function audioBytes(response: Response) {
	if (
		Number(response.headers.get("content-length")) > MAX_AUDIO ||
		!response.body
	)
		throw new Error("Audio output exceeds 25 MiB");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_AUDIO) throw new Error("Audio output exceeds 25 MiB");
			parts.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const bytes = Buffer.concat(parts);
	if (bytes.length < 16) throw new Error("Empty audio response");
	if (
		!(
			bytes.subarray(0, 3).toString() === "ID3" ||
			(bytes[0] === 255 && (bytes[1] & 224) === 224)
		)
	)
		throw new Error("Provider did not return valid MP3 audio");
	return bytes;
}
async function quota({ root, reserved }: { root: string; reserved: number }) {
	const files = await readdir(join(root, "files")).catch(() => [] as string[]);
	let total = 0;
	for (const name of files.filter((n) => /^[a-f0-9]{32}$/.test(n)))
		total += (await stat(join(root, "files", name))).size;
	if (total + MAX_AUDIO * (reserved + 1) > MAX_ACCOUNT)
		throw new Error("Audio storage limit reached");
}
/** Human approval is the only paid boundary; durable claim precedes one HTTP attempt. */
export async function approveAudio({
	root,
	projectId,
	id,
	digest,
	pin,
	confirmed,
	net = fetch,
}: {
	root: string;
	projectId: string;
	id: string;
	digest: string;
	pin: unknown;
	confirmed: unknown;
	net?: Fetcher;
}) {
	if (confirmed !== true)
		throw new Error("Confirm the audio request before generation");
	await vault.unlock({ root, pin });
	const key = vault.keyFor(root);
	const claim = await locked({
		root,
		task: async () => {
			const j = await jobRead({ root, projectId, id });
			if (j.digest !== digest) throw new Error("Audio review changed");
			if (j.status !== "review") return { job: j, claimed: false };
			const names = await readdir(join(root, "jobs"));
			let running = 0;
			for (const name of names.filter((n) => /^[a-f0-9]{32}\.json$/.test(n))) {
				const pending = await store.json<AudioJob>({
					root: join(root, "jobs"),
					name,
				});
				if (
					pending.status === "submitted" &&
					(await workerActive({ root, id: pending.id }))
				)
					running++;
			}
			if (running >= 2)
				throw new Error("Two audio requests are already running");
			await quota({ root, reserved: running });
			await mkdir(join(root, "workers"), { recursive: true, mode: 0o700 });
			const releaseWorker = await lockfile.lock(
				workerPath({ root, id: j.id }),
				{ realpath: false, stale: WORKER_STALE_MS, retries: 0 },
			);
			try {
				j.status = "submitted";
				await save({ root, job: j });
				return { job: j, claimed: true, releaseWorker };
			} catch (error) {
				await releaseWorker();
				throw error;
			}
		},
	});
	const job = claim.job;
	const workKey = root + job.id;
	if (!claim.claimed || !claim.releaseWorker) return job;
	// A saved submitted request is never retried after a lost reply or server restart.
	// The one claimant starts only when the durable claim was made in this invocation.
	return startClaimedAudio({
		root,
		job,
		key,
		net,
		workKey,
		releaseWorker: claim.releaseWorker,
	});
}
function startClaimedAudio({
	root,
	job,
	key,
	net,
	workKey,
	releaseWorker,
}: {
	root: string;
	job: AudioJob;
	key: string;
	net: Fetcher;
	workKey: string;
	releaseWorker: () => Promise<void>;
}) {
	const work = (async () => {
		try {
			const request = audioRequest(job.draft);
			const response = await net(
				API + request.path + "?output_format=mp3_44100_128",
				{
					method: "POST",
					headers: { "xi-api-key": key, "Content-Type": "application/json" },
					body: JSON.stringify(request.body),
					redirect: "error",
					signal: AbortSignal.timeout(240000),
				},
			);
			if (!response.ok) {
				await response.body?.cancel();
				job.status =
					response.status >= 400 && response.status < 500
						? "failed"
						: "uncertain";
				job.message = `ElevenLabs returned HTTP ${response.status}. Check provider usage before retrying.`;
			} else {
				const bytes = await audioBytes(response);
				job.output = await store.artifact({
					root,
					projectId: job.projectId,
					name: job.draft.title + ".mp3",
					mime: "audio/mpeg",
					bytes,
				});
				job.status = "ready";
				job.message = "Audio ready to import";
			}
		} catch {
			job.status = "uncertain";
			job.message =
				"Audio result could not be confirmed. Check ElevenLabs history; this request will not be retried automatically.";
		} finally {
			await save({ root, job }).finally(async () => {
				active.delete(workKey);
				await releaseWorker();
			});
		}
	})();
	active.set(workKey, work);
	void work.catch(() => {});
	return { ...job };
}
export async function settleAudioForTest({
	root,
	id,
}: {
	root: string;
	id: string;
}) {
	await active.get(root + id);
}
export async function cancelAudio({
	root,
	projectId,
	id,
}: {
	root: string;
	projectId: string;
	id: string;
}) {
	return locked({
		root,
		task: async () => {
			const j = await jobRead({ root, projectId, id });
			if (j.status !== "review")
				throw new Error("Only an unsubmitted audio request can be cancelled");
			j.status = "cancelled";
			await save({ root, job: j });
			return j;
		},
	});
}
export async function audioCatalog({
	root,
	net = fetch,
}: {
	root: string;
	net?: Fetcher;
}) {
	const key = vault.keyFor(root);
	const read = async (path: string) => {
		const r = await net(API + path, {
			headers: { "xi-api-key": key },
			signal: AbortSignal.timeout(15000),
			redirect: "error",
		});
		if (!r.ok) throw new Error(`ElevenLabs catalog returned HTTP ${r.status}`);
		return r.json() as Promise<unknown>;
	};
	const [models, voices] = await Promise.all([
		read("/models"),
		read("/voices"),
	]);
	return {
		models: z
			.array(
				z.object({
					model_id: z.string(),
					name: z.string(),
					can_do_text_to_speech: z.boolean().optional(),
				}),
			)
			.parse(models),
		voices: z
			.object({
				voices: z.array(z.object({ voice_id: z.string(), name: z.string() })),
			})
			.parse(voices).voices,
	};
}
