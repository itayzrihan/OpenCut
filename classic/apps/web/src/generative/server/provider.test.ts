import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vault from "./vault";
import * as store from "./store";
import { prepare, approve, reject, resume, type Fetcher } from "./provider";
import type { DirectorJob } from "../types";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		vault.lock(root);
		await rm(root, { recursive: true, force: true });
	}
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "director-test-"));
	roots.push(root);
	const ref = await store.artifact({
		root: root,
		projectId: "project-a",
		name: "board.png",
		mime: "image/png",
		bytes: Buffer.from("fake-board"),
		storyboard: true,
	});
	const calls: string[] = [];
	// Fetch is a platform ABI with positional Request/init arguments.
	// eslint-disable-next-line opencut/prefer-object-params
	const net: Fetcher = async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push(method + " " + url);
		if (String(url).endsWith("/models"))
			return Response.json({
				data: [
					{
						id: "bytedance/seedance-2.5",
						supported_durations: [8],
						supported_resolutions: ["480p"],
						supported_aspect_ratios: ["9:16"],
					},
				],
			});
		if (method === "POST") return Response.json({ id: "job123" });
		if (String(url).includes("/content"))
			return new Response(
				Buffer.concat([Buffer.from("\0\0\0\x20ftypisom"), Buffer.alloc(100)]),
			);
		return Response.json({ status: "completed", usage: { cost: 0.83 } });
	};
	const input = {
		projectId: "project-a",
		kind: "video",
		model: "bytedance/seedance-2.5",
		prompt: JSON.stringify({
			direction: "Original anime scene preserving exact dialogue and lip sync",
		}),
		duration: 8,
		resolution: "480p",
		aspectRatio: "9:16",
		referenceIds: [ref.id],
	};
	return { root, ref, calls, net, input };
}
async function settled({ root, j }: { root: string; j: DirectorJob }) {
	for (let n = 0; n < 100; n++) {
		const x = await store.json<DirectorJob>({
			root: store.jobRoot({ root: root, jobId: j.id }),
			name: "review.json",
		});
		if (["ready", "uncertain", "error", "session_expired"].includes(x.status))
			return x;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("Not settled");
}
test("prepare/reject do not submit and rejected request cannot be approved", async () => {
	const f = await fixture(),
		j = await prepare({
			root: f.root,
			raw: f.input,
			referenceUrl: async () => "",
			net: f.net,
		});
	await reject({ root: f.root, projectId: "project-a", jobId: j.id });
	await expect(
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net: f.net,
		}),
	).rejects.toThrow();
	expect(f.calls.filter((x) => x.startsWith("POST"))).toHaveLength(0);
});
test("active lease does not permit wrong-PIN paid approval", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	await vault.unlock({ root: f.root, pin: "87654321" });
	const j = await prepare({
		root: f.root,
		raw: f.input,
		referenceUrl: async () => "",
		net: f.net,
	});
	await expect(
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "11111111",
			digest: j.digest,
			net: f.net,
		}),
	).rejects.toThrow("Incorrect PIN");
	expect(f.calls.filter((x) => x.startsWith("POST"))).toHaveLength(0);
});
test("concurrent approval submits once and automatically downloads without more PINs", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const j = await prepare({
		root: f.root,
		raw: f.input,
		referenceUrl: async () => "",
		net: f.net,
	});
	const result = await Promise.allSettled([
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net: f.net,
		}),
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net: f.net,
		}),
	]);
	expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	const done = await settled({ root: f.root, j: j });
	expect(done.status).toBe("ready");
	expect(done.output?.kind).toBe("video");
	expect(done.cost).toBe(0.83);
	expect(f.calls.filter((x) => x.startsWith("POST"))).toHaveLength(1);
	expect(f.calls.some((x) => x.includes("/content"))).toBe(true);
	const persistent = await readFile(
		join(store.jobRoot({ root: f.root, jobId: j.id }), "review.json"),
		"utf8",
	);
	expect(persistent).not.toContain("fake-key");
	expect(persistent).not.toContain("87654321");
});
test("cross-project approval and changed reference blocked before network", async () => {
	const f = await fixture(),
		j = await prepare({
			root: f.root,
			raw: f.input,
			referenceUrl: async () => "",
			net: f.net,
		});
	await expect(
		approve({
			root: f.root,
			projectId: "project-b",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net: f.net,
		}),
	).rejects.toThrow();
	await writeFile(join(f.root, "files", f.ref.id), "changed");
	await expect(
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net: f.net,
		}),
	).rejects.toThrow();
	expect(f.calls.filter((x) => x.startsWith("POST"))).toHaveLength(0);
});
test("physical storyboard and supported live duration mandatory", async () => {
	const f = await fixture();
	await expect(
		prepare({
			root: f.root,
			raw: { ...f.input, referenceIds: [] },
			referenceUrl: async () => "",
			net: f.net,
		}),
	).rejects.toThrow("physical storyboard");
	await expect(
		prepare({
			root: f.root,
			raw: { ...f.input, duration: 29 },
			referenceUrl: async () => "",
			net: f.net,
		}),
	).rejects.toThrow("does not support");
});
test("audio hosting requires HTTPS and exact original bytes", async () => {
	const f = await fixture(),
		audio = await store.artifact({
			root: f.root,
			projectId: "project-a",
			name: "voice.mp3",
			mime: "audio/mpeg",
			bytes: Buffer.from("original-voice"),
		});
	const input = { ...f.input, referenceIds: [f.ref.id, audio.id] };
	await expect(
		prepare({
			root: f.root,
			raw: input,
			referenceUrl: async () => {
				throw new Error("HTTPS required");
			},
			net: f.net,
		}),
	).rejects.toThrow("HTTPS required");
	// Fetch is a platform ABI with positional Request/init arguments.
	// eslint-disable-next-line opencut/prefer-object-params
	const net: Fetcher = async (url, init) =>
		String(url).includes("pocast.co.il")
			? new Response("original-voice")
			: f.net(url, init);
	const j = await prepare({
		root: f.root,
		raw: {
			...input,
			httpsReferences: {
				[audio.id]: "https://pocast.co.il/api/files/test/download?share=test",
			},
		},
		referenceUrl: async () => "",
		net: net,
	});
	const payload = await store.json<{
		input_references: Array<{ type: string }>;
	}>({
		root: store.jobRoot({ root: f.root, jobId: j.id }),
		name: "payload.json",
	});
	expect(payload.input_references.map((x) => x.type)).toEqual([
		"image_url",
		"audio_url",
	]);
});
test("uncertain paid POST never auto-retries", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const j = await prepare({
		root: f.root,
		raw: f.input,
		referenceUrl: async () => "",
		net: f.net,
	});
	let count = 0;
	const fail: Fetcher = async () => {
		count++;
		throw new Error("failure");
	};
	await approve({
		root: f.root,
		projectId: "project-a",
		jobId: j.id,
		pin: "87654321",
		digest: j.digest,
		net: fail,
	});
	expect((await settled({ root: f.root, j: j })).status).toBe("uncertain");
	await resume({ root: f.root, projectId: "project-a" });
	expect(count).toBe(1);
});
test("encrypted vault lease expires without activity extending it", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const raw = await readFile(join(f.root, "vault.json"), "utf8");
	expect(raw).not.toContain("fake-key");
	expect(raw).not.toContain("87654321");
	await vault.unlock({ root: f.root, pin: "87654321" });
	const original = performance.now();
	const clock = spyOn(performance, "now").mockReturnValue(original + 901_000);
	try {
		expect(() => vault.keyFor(f.root)).toThrow("expired");
		expect(vault.seconds(f.root)).toBe(0);
	} finally {
		clock.mockRestore();
	}
});

test("storyboard uses separate PIN-approved image call and returns a physical image", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const j = await prepare({
		root: f.root,
		raw: {
			projectId: "project-a",
			kind: "storyboard",
			model: "test/image",
			prompt:
				"Draw a four-panel physical storyboard with our actual references",
			referenceIds: [f.ref.id],
		},
		referenceUrl: async () => "",
		net: f.net,
	});
	let paid = 0;
	const net: Fetcher = async () => {
		paid++;
		return Response.json({
			choices: [
				{
					message: {
						images: [
							{
								image_url: {
									url:
										"data:image/png;base64," +
										Buffer.from("fake-physical-board").toString("base64"),
								},
							},
						],
					},
				},
			],
			usage: { cost: 0.1 },
		});
	};
	expect(paid).toBe(0);
	await approve({
		root: f.root,
		projectId: "project-a",
		jobId: j.id,
		pin: "87654321",
		digest: j.digest,
		net,
	});
	const done = await settled({ root: f.root, j });
	expect(paid).toBe(1);
	expect(done.output?.storyboard).toBe(true);
	expect(done.output?.kind).toBe("image");
	expect(done.status).toBe("ready");
});
