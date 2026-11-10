import { once } from "node:events";
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Synthetic fetch implementations must implement the native positional Fetch signature. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	audioRequest,
	prepareAudio,
	approveAudio,
	audioJobs,
	jobRead,
	settleAudioForTest,
	cancelAudio,
} from "./server";
import { audioDraftSchema, type AudioDraft } from "./types";
import * as vault from "@/generative/server/vault";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		vault.lock(root);
		await rm(root, { recursive: true, force: true });
	}
});
const draft: AudioDraft = {
	id: "narration",
	version: 1,
	title: "שלום",
	kind: "speech",
	modelId: "eleven_multilingual_v2",
	voiceId: "voice_1",
	text: "שלום עולם",
	dialogue: [],
	instrumental: false,
	durationSeconds: null,
};
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "pocut-audio-"));
	roots.push(root);
	await vault.setup({ root, pin: "123456", key: "synthetic-test-key" });
	return root;
}
test("audio contracts preserve original language and validate supported provider operations", () => {
	expect(audioRequest(draft)).toEqual({
		path: "/text-to-speech/voice_1",
		body: { text: "שלום עולם", model_id: "eleven_multilingual_v2" },
	});
	expect(
		audioRequest({
			...draft,
			kind: "music",
			modelId: "music_v1",
			durationSeconds: 33,
			instrumental: true,
		}).body,
	).toMatchObject({ music_length_ms: 33000, force_instrumental: true });
	expect(
		audioRequest({
			...draft,
			kind: "sound",
			modelId: "eleven_text_to_sound_v2",
			durationSeconds: 0.5,
		}).body,
	).toMatchObject({ duration_seconds: 0.5 });
	expect(() =>
		audioRequest({ ...draft, kind: "sound", durationSeconds: 31 }),
	).toThrow();
	expect(() => audioRequest({ ...draft, voiceId: "../../secrets" })).toThrow();
	expect(() =>
		audioDraftSchema.parse({
			...draft,
			kind: "dialogue",
			dialogue: Array.from({ length: 11 }, (_, i) => ({
				text: "Hi",
				voiceId: `v${i}`,
			})),
		}),
	).toThrow();
	expect(() =>
		audioDraftSchema.parse({
			...draft,
			kind: "dialogue",
			dialogue: [{ text: "a".repeat(2001), voiceId: "v" }],
		}),
	).toThrow();
});
test("preparation is idempotent, owned by project and never spends or leaks credentials", async () => {
	const root = await setup();
	const a = await prepareAudio({
		root,
		projectId: "a",
		operationId: "one",
		draft,
	});
	expect(
		await prepareAudio({ root, projectId: "a", operationId: "one", draft }),
	).toEqual(a);
	await expect(
		prepareAudio({
			root,
			projectId: "a",
			operationId: "one",
			draft: { ...draft, text: "changed" },
		}),
	).rejects.toThrow("different content");
	await expect(jobRead({ root, projectId: "b", id: a.id })).rejects.toThrow(
		"not found",
	);
	expect(
		await readFile(join(root, "jobs", a.id + ".json"), "utf8"),
	).not.toContain("synthetic-test-key");
	expect((await audioJobs({ root, projectId: "a" }))[0].status).toBe("review");
});
test("human PIN approval submits at most once, imports bounded MP3 and never replays completed work", async () => {
	const root = await setup();
	const job = await prepareAudio({
		root,
		projectId: "a",
		operationId: "once",
		draft,
	});
	let calls = 0;
	const net = (async (url: unknown, init: RequestInit) => {
		calls++;
		expect(String(url)).toBe(
			"https://api.elevenlabs.io/v1/text-to-speech/voice_1?output_format=mp3_44100_128",
		);
		expect(init.redirect).toBe("error");
		return new Response(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(48)]), {
			headers: { "Content-Type": "audio/mpeg" },
		});
	}) as typeof fetch;
	const approval = {
		root,
		projectId: "a",
		id: job.id,
		digest: job.digest,
		pin: "123456",
		confirmed: true,
		net,
	};
	await expect(approveAudio({ ...approval, confirmed: false })).rejects.toThrow(
		"Confirm",
	);
	await expect(
		approveAudio({ ...approval, digest: "changed" }),
	).rejects.toThrow("changed");
	expect(calls).toBe(0);
	await Promise.all([approveAudio(approval), approveAudio(approval)]);
	await settleAudioForTest({ root, id: job.id });
	expect(calls).toBe(1);
	const done = await jobRead({ root, projectId: "a", id: job.id });
	expect(done.status).toBe("ready");
	expect(done.output?.mime).toBe("audio/mpeg");
	await approveAudio(approval);
	expect(calls).toBe(1);
});
test("ambiguous provider failure stays uncertain and repeated approval cannot create another paid attempt", async () => {
	const root = await setup();
	const job = await prepareAudio({
		root,
		projectId: "a",
		operationId: "uncertain",
		draft,
	});
	let calls = 0;
	const net = (async () => {
		calls++;
		throw new Error("Network lost after provider accepted");
	}) as typeof fetch;
	const approval = {
		root,
		projectId: "a",
		id: job.id,
		digest: job.digest,
		pin: "123456",
		confirmed: true,
		net,
	};
	await approveAudio(approval);
	await settleAudioForTest({ root, id: job.id });
	expect((await jobRead({ root, projectId: "a", id: job.id })).status).toBe(
		"uncertain",
	);
	await approveAudio(approval);
	expect(calls).toBe(1);
});
test("cancelled review cannot be sent and non-audio provider bytes are never imported", async () => {
	const root = await setup();
	const job = await prepareAudio({
		root,
		projectId: "a",
		operationId: "cancel",
		draft,
	});
	await cancelAudio({ root, projectId: "a", id: job.id });
	let calls = 0;
	const net = (async () => {
		calls++;
		return new Response("<html>this is not audio</html>");
	}) as typeof fetch;
	const approval = {
		root,
		projectId: "a",
		id: job.id,
		digest: job.digest,
		pin: "123456",
		confirmed: true,
		net,
	};
	await approveAudio(approval);
	expect(calls).toBe(0);
	const j = await prepareAudio({
		root,
		projectId: "a",
		operationId: "bad-audio",
		draft,
	});
	await approveAudio({ ...approval, id: j.id, digest: j.digest });
	await settleAudioForTest({ root, id: j.id });
	expect((await jobRead({ root, projectId: "a", id: j.id })).status).toBe(
		"uncertain",
	);
	expect(
		(await jobRead({ root, projectId: "a", id: j.id })).output,
	).toBeUndefined();
});

test("cross-process workers reserve concurrency and storage before another paid request", async () => {
	const { spawn } = await import("node:child_process");

	const { writeFile, mkdir, open } = await import("node:fs/promises");
	const root = await setup();
	const pending = [];
	for (const operationId of ["worker-one", "worker-two", "third"]) {
		pending.push(
			await prepareAudio({ root, projectId: "a", operationId, draft }),
		);
	}
	await mkdir(join(root, "workers"), { recursive: true });
	for (const job of pending.slice(0, 2))
		await writeFile(
			join(root, "jobs", job.id + ".json"),
			JSON.stringify({ ...job, status: "submitted" }),
		);
	const script = `const lockfile=require(${JSON.stringify(import.meta.resolve("proper-lockfile").replace("file://", ""))});(async()=>{const releases=[];for(const id of ${JSON.stringify(pending.slice(0, 2).map((j) => j.id))})releases.push(await lockfile.lock(${JSON.stringify(join(root, "workers"))}+'/'+id,{realpath:false,stale:300000,retries:0}));process.stdout.write('ready\\n');process.stdin.once('data',async()=>{for(const release of releases)await release();process.exit(0);});})().catch(e=>{console.error(e);process.exit(1);});`;
	const child = spawn("node", ["-e", script], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		await once(child.stdout, "data");
		expect(
			(await audioJobs({ root, projectId: "a" })).filter(
				(j) => j.status === "submitted",
			),
		).toHaveLength(2);
		let calls = 0;
		const net = (async () => {
			calls++;
			return new Response(
				Buffer.concat([Buffer.from("ID3"), Buffer.alloc(48)]),
			);
		}) as typeof fetch;
		const approval = {
			root,
			projectId: "a",
			id: pending[2].id,
			digest: pending[2].digest,
			pin: "123456",
			confirmed: true,
			net,
		};
		await expect(approveAudio(approval)).rejects.toThrow("Two audio requests");
		expect(calls).toBe(0);
		child.stdin.end("release");
		await once(child, "exit");
		expect(
			(await audioJobs({ root, projectId: "a" })).filter(
				(j) => j.status === "uncertain",
			),
		).toHaveLength(2);
		// A sparse file tests the quota with no large allocation or provider call.
		await mkdir(join(root, "files"), { recursive: true });
		const file = await open(join(root, "files", "d".repeat(32)), "w");
		await file.truncate(2 * 1024 * 1024 * 1024 - 25 * 1024 * 1024 + 1);
		await file.close();
		await expect(approveAudio(approval)).rejects.toThrow("storage limit");
		expect(calls).toBe(0);
	} finally {
		child.kill("SIGTERM");
	}
});
