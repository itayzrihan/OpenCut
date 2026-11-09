import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vault from "./vault";
import * as store from "./store";
import {
	prepare,
	approve,
	reject,
	resume,
	ChatGptStoryboardRejected,
	type Fetcher,
} from "./provider";
import type { DirectorJob } from "../types";
import { REPLACE_IMAGE_MODEL, REPLACE_VIDEO_MODEL } from "../replace-model";
import { directorPrompt } from "../direction-prompt";
import { directorJobProgress } from "../job-progress";
import {
	CHATGPT_STORYBOARD_MODEL,
	CHATGPT_STORYBOARD_ORCHESTRATOR,
} from "../storyboard-model";
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
async function settled({
	root,
	j,
	until = (job) =>
		["ready", "uncertain", "error", "session_expired"].includes(job.status),
	timeout = 1000,
}: {
	root: string;
	j: DirectorJob;
	until?: (job: DirectorJob) => boolean;
	timeout?: number;
}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const x = await store.json<DirectorJob>({
			root: store.jobRoot({ root: root, jobId: j.id }),
			name: "review.json",
		});
		if (until(x)) return x;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Not settled");
}

test("Wan Seamless Connect prepares exactly two ordered frame images and accepts two seconds", async () => {
	const { root, input } = await fixture();
	const frame = async (name: string) =>
		store.artifact({
			root,
			projectId: input.projectId,
			name,
			mime: "image/jpeg",
			bytes: Buffer.from(name),
			storyboard: false,
		});
	const first = await frame("outgoing.jpg");
	const last = await frame("incoming.jpg");
	const target = {
		sceneId: "scene",
		trackId: "track",
		leftId: "outgoing",
		rightId: "incoming",
		anchor: "a".repeat(64),
	};
	const raw = {
		...input,
		model: "alibaba/wan-3.0",
		duration: 2,
		resolution: "720p",
		referenceIds: [first.id, last.id],
		seamless: target,
	};
	const net: Fetcher = async (url, init) => {
		expect(String(url)).toEndWith("/videos/models");
		expect(init?.method).toBeUndefined();
		return Response.json({
			data: [
				{
					id: raw.model,
					supported_durations: [2, 3, 30],
					supported_resolutions: ["720p"],
					supported_aspect_ratios: ["9:16"],
					supported_frame_images: ["first_frame", "last_frame"],
				},
			],
		});
	};
	const referenceUrl = async () => {
		throw new Error("Boundary images must be inline");
	};
	const job = await prepare({ root, raw, net, referenceUrl });
	expect(job.seamless).toEqual(target);
	expect(job.status).toBe("review");
	const payload = await store.json({
		root: store.jobRoot({ root, jobId: job.id }),
		name: "payload.json",
	});
	expect(payload).toEqual({
		model: raw.model,
		prompt: raw.prompt,
		duration: 2,
		resolution: "720p",
		aspect_ratio: "9:16",
		generate_audio: false,
		frame_images: [first, last].map(({ name }, index) => ({
			type: "image_url",
			image_url: {
				url: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`,
			},
			frame_type: index === 0 ? "first_frame" : "last_frame",
		})),
	});
	await expect(
		prepare({ root, raw: { ...raw, duration: 1 }, net, referenceUrl }),
	).rejects.toThrow("does not support");
	await expect(
		prepare({ root, raw: { ...raw, duration: 0.1 }, net, referenceUrl }),
	).rejects.toThrow();
	await expect(
		prepare({
			root,
			raw: { ...raw, referenceIds: [first.id, first.id] },
			net,
			referenceUrl,
		}),
	).rejects.toThrow("two distinct");
});

test("Replace prepares ten chronological image references or a full text-only shot", async () => {
	const { root, input } = await fixture();
	const frames = await Promise.all(Array.from({ length: 10 }, (_, i) => store.artifact({
		root, projectId: input.projectId, name: `frame-${i}.jpg`,
		mime: "image/jpeg", bytes: Buffer.from(`original frame ${i}`), storyboard: false,
	})));
	const net: Fetcher = async (url, init) => {
		expect(String(url)).toEndWith("/videos/models");
		expect(init?.method).toBeUndefined();
		return Response.json({ data: [{
			id: REPLACE_VIDEO_MODEL, supported_durations: [2, 4],
			supported_resolutions: ["720p"], supported_aspect_ratios: ["9:16"],
		}] });
	};
	const replacement = {
		sceneId: "scene", trackId: "track", elementId: "selected",
		anchor: "a".repeat(64), durationTicks: 458400, mode: "refine",
	};
	const raw = {
		...input, replacement, model: REPLACE_VIDEO_MODEL, duration: 4, resolution: "720p",
		referenceIds: frames.map((f) => f.id),
	};
	const referenceUrl = async () => { throw new Error("Use inline reference images"); };
	const refine = await prepare({ root, raw, net, referenceUrl });
	expect(refine.replacement).toEqual(replacement);
	expect(refine.status).toBe("review");
	const payload = await store.json({
		root: store.jobRoot({ root, jobId: refine.id }), name: "payload.json",
	});
	expect(payload).toEqual({
		model: REPLACE_VIDEO_MODEL, prompt: raw.prompt, duration: 4, resolution: "720p",
		aspect_ratio: "9:16", generate_audio: false,
		input_references: frames.map((_, i) => ({
			type: "image_url", image_url: {
				url: `data:image/jpeg;base64,${Buffer.from(`original frame ${i}`).toString("base64")}`,
			},
		})),
	});
	const full = await prepare({
		root, raw: { ...raw, replacement: { ...replacement, mode: "full" }, referenceIds: [] },
		net, referenceUrl,
	});
	expect(full.references).toEqual([]);
	await expect(prepare({
		root, raw: { ...raw, referenceIds: [] }, net, referenceUrl,
	})).rejects.toThrow("distinct image references");
	const image = await prepare({
		root, referenceUrl, net, raw: {
			projectId: input.projectId, kind: "storyboard", model: REPLACE_IMAGE_MODEL,
			prompt: "A single still", referenceImage: true, referenceIds: [],
		},
	});
	expect(image.referenceImage).toBe(true);
	expect(image.status).toBe("review");
});

test("Director accepts exact plain text, Markdown, and saved JSON direction", () => {
	const context = {
		transcript: "הטקסט המקורי",
		instructions: "Keep the dialogue",
		aspectRatio: "9:16",
	};
	const direction = "Project opening\n\n**שוט ראשון**: כניסה לפריים";
	const storyboard = directorPrompt({
		...context,
		kind: "storyboard",
		direction,
	});
	expect(storyboard).toContain("9:16");
	expect(storyboard.endsWith(direction)).toBe(true);
	expect(
		JSON.parse(directorPrompt({ ...context, kind: "video", direction })),
	).toEqual({
		direction,
		priority_instructions: context.instructions,
		original_transcript: context.transcript,
	});
	const structured = {
		storyboard_prompt: "Draw a two-panel storyboard",
		spoken_script: "Legacy dialogue",
	};
	const fenced = `\`\`\`json\n${JSON.stringify(structured)}\n\`\`\``;
	expect(
		directorPrompt({ ...context, kind: "storyboard", direction: fenced }),
	).toBe(structured.storyboard_prompt);
	expect(
		JSON.parse(
			directorPrompt({
				...context,
				kind: "video",
				transcript: "",
				direction: fenced,
			}),
		),
	).toMatchObject({
		...structured,
		original_transcript: structured.spoken_script,
	});
	expect(() =>
		directorPrompt({ ...context, kind: "storyboard", direction: " \n" }),
	).toThrow("directing brief");
});

test("ChatGPT storyboard freezes the exact brief and dispatches once after connected approval without OpenRouter", async () => {
	const f = await fixture();
	const prompt = directorPrompt({
		kind: "storyboard",
		direction: "Project: שלושה פריימים ברכבת",
		aspectRatio: "9:16",
		instructions: "",
		transcript: "",
	});
	const job = await prepare({
		root: f.root,
		raw: {
			projectId: "project-a",
			kind: "storyboard",
			model: CHATGPT_STORYBOARD_MODEL,
			prompt,
			referenceIds: [f.ref.id],
		},
		referenceUrl: async () => {
			throw new Error("Storyboard image must stay inline");
		},
		net: f.net,
	});
	expect(job).toMatchObject({
		provider: "chatgpt",
		model: CHATGPT_STORYBOARD_ORCHESTRATOR,
		status: "review",
		prompt,
	});
	expect(f.calls).toHaveLength(0);
	const approval = {
		root: f.root,
		projectId: job.projectId,
		jobId: job.id,
		pin: undefined,
		digest: job.digest,
		net: f.net,
	};
	await expect(approve(approval)).rejects.toThrow("Connect ChatGPT");
	expect(
		(await store.jobs({ root: f.root, projectId: job.projectId }))[0].status,
	).toBe("review");
	let dispatched = 0;
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
		"base64",
	);
	const authorizeChatGpt =
		async () => async (body: Record<string, unknown>) => {
			dispatched++;
			expect(body.model).toBe(CHATGPT_STORYBOARD_ORCHESTRATOR);
			expect(body.tools).toEqual([
				{ type: "image_generation", output_format: "png" },
			]);
			expect(JSON.stringify(body.input)).toContain(JSON.stringify(prompt));
			expect(JSON.stringify(body.input)).toContain(
				`data:image/png;base64,${Buffer.from("fake-board").toString("base64")}`,
			);
			return png;
		};
	await expect(
		approve({ ...approval, digest: "other", authorizeChatGpt }),
	).rejects.toThrow("changed");
	const results = await Promise.allSettled([
		approve({ ...approval, authorizeChatGpt }),
		approve({ ...approval, authorizeChatGpt }),
	]);
	expect(results.map((result) => result.status).sort()).toEqual([
		"fulfilled",
		"rejected",
	]);
	const done = await settled({ root: f.root, j: job });
	expect(done.output).toMatchObject({ storyboard: true, mime: "image/png" });
	expect(
		(
			await store.fileBytes({
				root: f.root,
				projectId: job.projectId,
				fileId: done.output!.id,
			})
		).bytes,
	).toEqual(png);
	expect(dispatched).toBe(1);
	expect(f.calls).toHaveLength(0);
});

test("ChatGPT storyboard reports a declined request and never resubmits on resume", async () => {
	const f = await fixture();
	const job = await prepare({
		root: f.root,
		raw: {
			projectId: "project-a",
			kind: "storyboard",
			model: CHATGPT_STORYBOARD_MODEL,
			prompt: "Draw a skyline",
			referenceIds: [],
		},
		referenceUrl: async () => "",
		net: f.net,
	});
	let dispatched = 0;
	await approve({
		root: f.root,
		projectId: job.projectId,
		jobId: job.id,
		pin: undefined,
		digest: job.digest,
		authorizeChatGpt: async () => async () => {
			dispatched++;
			throw new ChatGptStoryboardRejected("ChatGPT Image declined (HTTP 429)");
		},
	});
	await expect(settled({ root: f.root, j: job })).resolves.toMatchObject({
		status: "error",
		message: "ChatGPT Image declined (HTTP 429)",
	});
	await resume({ root: f.root, projectId: job.projectId });
	expect(dispatched).toBe(1);
	expect(f.calls).toHaveLength(0);
});
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
test("one approved video moves through queue, in_progress, download, and ready", async () => {
	const f = await fixture();
	const queued = Promise.withResolvers<Response>();
	const download = Promise.withResolvers<void>();
	let statusPolls = 0;
	// eslint-disable-next-line opencut/prefer-object-params -- platform Fetch ABI.
	const net: Fetcher = async (url, init) => {
		if (String(url).endsWith("/videos/job123") && statusPolls++ === 0)
			return queued.promise;
		if (String(url).includes("/content")) await download.promise;
		return f.net(url, init);
	};
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
			net,
		}),
		approve({
			root: f.root,
			projectId: "project-a",
			jobId: j.id,
			pin: "87654321",
			digest: j.digest,
			net,
		}),
	]);
	expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	try {
		const pending = await settled({
			root: f.root,
			j,
			until: (job) => job.status === "pending",
		});
		expect(
			directorJobProgress({
				job: pending,
				now: pending.submittedAt! + 360_000,
			}),
		).toEqual({
			label: "Queued by provider",
			detail: "6 minutes waiting",
		});
		queued.resolve(Response.json({ status: "in_progress" }));
		const processing = await settled({
			root: f.root,
			j,
			until: (job) => job.providerStatus === "in_progress",
		});
		expect(processing.status).toBe("processing");
		expect(processing.providerStatusAt).toBeGreaterThanOrEqual(
			pending.submittedAt!,
		);
		expect(
			directorJobProgress({
				job: processing,
				now: processing.providerStatusAt! + 120_000,
			}),
		).toEqual({
			label: "Generating with provider",
			detail: "2 minutes in progress",
		});
		const downloading = await settled({
			root: f.root,
			j,
			timeout: 20_000,
			until: (job) => job.providerStatus === "completed",
		});
		expect(directorJobProgress({ job: downloading, now: Date.now() })).toEqual({
			label: "Downloading video",
		});
	} finally {
		queued.resolve(Response.json({ status: "failed" }));
		download.resolve();
	}
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
}, 26_000);

test("terminal provider failure remains terminal after the PIN lease ends", async () => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const j = await prepare({
		root: f.root,
		raw: f.input,
		referenceUrl: async () => "",
		net: f.net,
	});
	// eslint-disable-next-line opencut/prefer-object-params -- platform Fetch ABI.
	const net: Fetcher = (url, init) =>
		String(url).endsWith("/videos/job123")
			? Promise.resolve(Response.json({ status: "failed" }))
			: f.net(url, init);
	await approve({
		root: f.root,
		projectId: j.projectId,
		jobId: j.id,
		pin: "87654321",
		digest: j.digest,
		net,
	});
	await expect(settled({ root: f.root, j })).resolves.toMatchObject({
		status: "error",
		providerStatus: "failed",
	});
	vault.lock(f.root);
	await resume({ root: f.root, projectId: j.projectId });
	expect(
		(await store.jobs({ root: f.root, projectId: j.projectId }))[0],
	).toMatchObject({ status: "error", providerStatus: "failed" });
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

test.each([false, true])("a PIN-approved Director image is imported with the correct reference type (replacement=%s)", async (replacement) => {
	const f = await fixture();
	await vault.setup({ root: f.root, pin: "87654321", key: "fake-key" });
	const j = await prepare({
		root: f.root,
		raw: {
			projectId: "project-a",
			kind: "storyboard",
			model: replacement ? REPLACE_IMAGE_MODEL : "test/image",
			...(replacement ? { referenceImage: true } : {}),
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
	expect(done.output?.storyboard).toBe(!replacement);
	expect(done.output?.name).toBe(replacement ? "Replace reference image.png" : "Director storyboard.png");
	expect(done.output?.kind).toBe("image");
	expect(done.status).toBe("ready");
});
