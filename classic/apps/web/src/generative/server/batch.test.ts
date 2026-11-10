import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "./store";
import * as vault from "./vault";
import * as provider from "./provider";
import { prepareBatch, approveBatch, cancelBatch, readBatch } from "./batch";
import type { DirectorJob } from "../types";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		vault.lock(root);
		await rm(root, { recursive: true, force: true });
	}
});
async function fixture(count = 7) {
	const root = await mkdtemp(join(tmpdir(), "director-batch-"));
	roots.push(root);
	await vault.setup({ root, pin: "123456", key: "sk-or-test-only-not-real" });
	const projectId = "batch-project";
	let posts = 0;
	let active = 0;
	let peak = 0;
	let onPost: () => Promise<void> = async () => {};
	// Fetch ABI uses positional URL/init arguments.
	// eslint-disable-next-line opencut/prefer-object-params
	const net: provider.Fetcher = async (url, init) => {
		const path = String(url);
		if (path.endsWith("/models"))
			return Response.json({
				data: [
					{
						id: "bytedance/seedance-2.5",
						supported_durations: [4, 8, 30],
						supported_resolutions: ["720p"],
						supported_aspect_ratios: ["16:9"],
						supported_frame_images: ["first_frame", "last_frame"],
					},
				],
			});
		if (init?.method === "POST") {
			posts++;
			active++;
			peak = Math.max(peak, active);
			await onPost();
			return Response.json({ id: `provider-${posts}` });
		}
		if (path.includes("/content")) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
			return new Response(
				Buffer.concat([Buffer.from("\0\0\0\x20ftypisom"), Buffer.alloc(100)]),
			);
		}
		return Response.json({ status: "completed" });
	};
	const input = {
		projectId,
		kind: "video",
		model: "bytedance/seedance-2.5",
		prompt: "Exact dialogue unchanged",
		duration: 8,
		resolution: "720p",
		aspectRatio: "16:9",
		referenceIds: [],
		videoMode: "text",
	};
	const jobs: DirectorJob[] = [];
	for (let i = 0; i < count; i++)
		jobs.push(
			await provider.prepare({
				root,
				raw: { ...input, prompt: `${input.prompt} ${i}` },
				referenceUrl: async () => "",
				net,
			}),
		);
	const batch = await prepareBatch({
		root,
		projectId,
		raw: {
			id: "a".repeat(32),
			kind: "chapters",
			jobs: jobs.map((j) => ({ id: j.id, digest: j.digest })),
		},
	});
	return {
		root,
		projectId,
		net,
		input,
		jobs,
		batch,
		stats: () => ({ posts, active, peak }),
		onPost: (callback: () => Promise<void>) => {
			onPost = callback;
		},
	};
}
test("human PIN frozen batch caps concurrency at three and never pays twice", async () => {
	const f = await fixture();
	const options = {
		root: f.root,
		projectId: f.projectId,
		id: f.batch.id,
		digest: f.batch.digest,
		pin: "123456",
		net: f.net,
		wait: true,
	};
	await expect(approveBatch({ ...options, confirmed: false })).rejects.toThrow(
		"Human",
	);
	await expect(
		approveBatch({ ...options, pin: "654321", confirmed: true }),
	).rejects.toThrow();
	expect(f.stats().posts).toBe(0);
	const done = await approveBatch({ ...options, confirmed: true });
	expect(done.status).toBe("complete");
	expect(f.stats().posts).toBe(7);
	expect(f.stats().active).toBe(0);
	expect(f.stats().peak).toBeLessThanOrEqual(3);
	expect(f.stats().peak).toBeGreaterThan(1);
	await approveBatch({ ...options, confirmed: true });
	expect(f.stats().posts).toBe(7);
	expect(
		(
			await prepareBatch({
				root: f.root,
				projectId: f.projectId,
				raw: { id: f.batch.id, kind: "chapters", jobs: f.batch.jobs },
			})
		).status,
	).toBe("complete");
});
test("cancel stops unsent work; accepted requests finish and cancellation cannot restart", async () => {
	const f = await fixture();
	let cancelled = false;
	f.onPost(async () => {
		if (!cancelled) {
			cancelled = true;
			await cancelBatch({
				root: f.root,
				projectId: f.projectId,
				id: f.batch.id,
			});
		}
	});
	await approveBatch({
		root: f.root,
		projectId: f.projectId,
		id: f.batch.id,
		digest: f.batch.digest,
		pin: "123456",
		confirmed: true,
		net: f.net,
		wait: true,
	});
	expect(f.stats().posts).toBeLessThanOrEqual(3);
	expect(f.stats().posts).toBeGreaterThan(0);
	expect(
		(await readBatch({ root: f.root, projectId: f.projectId, id: f.batch.id }))
			.status,
	).toBe("cancelled");
	await expect(
		approveBatch({
			root: f.root,
			projectId: f.projectId,
			id: f.batch.id,
			digest: f.batch.digest,
			pin: "123456",
			confirmed: true,
			net: f.net,
			wait: true,
		}),
	).rejects.toThrow("cancelled");
});
test("durable claim blocks repeat POST if a crashed review still says review", async () => {
	const f = await fixture(1);
	await writeFile(
		join(
			store.jobRoot({ root: f.root, jobId: f.jobs[0].id }),
			"provider-approval",
		),
		f.jobs[0].digest,
	);
	await expect(
		provider.approve({
			root: f.root,
			projectId: f.projectId,
			jobId: f.jobs[0].id,
			digest: f.jobs[0].digest,
			pin: "123456",
			net: f.net,
			waitForCompletion: true,
		}),
	).rejects.toThrow("claimed");
	await provider.resume({ root: f.root, projectId: f.projectId, net: f.net });
	const recovered = await store.json<DirectorJob>({
		root: store.jobRoot({ root: f.root, jobId: f.jobs[0].id }),
		name: "review.json",
	});
	expect(recovered.status).toBe("uncertain");
	expect(f.stats().posts).toBe(0);
});
test("operation ID reuses exact request and rejects changed prompt", async () => {
	const f = await fixture(1);
	const args = {
		root: f.root,
		raw: { ...f.input, operationId: "native-image-1" },
		referenceUrl: async () => "",
		net: f.net,
	};
	const first = await provider.prepare(args);
	const again = await provider.prepare(args);
	expect(again.id).toBe(first.id);
	await expect(
		provider.prepare({ ...args, raw: { ...args.raw, prompt: "Different" } }),
	).rejects.toThrow("different frozen request");
	expect(f.stats().posts).toBe(0);
});
test("explicit frame mode and live duration reject unsupported settings", async () => {
	const f = await fixture(1);
	await expect(
		provider.prepare({
			root: f.root,
			raw: { ...f.input, videoMode: "frames" },
			referenceUrl: async () => "",
			net: f.net,
		}),
	).rejects.toThrow();
	await expect(
		provider.prepare({
			root: f.root,
			raw: { ...f.input, duration: 29 },
			referenceUrl: async () => "",
			net: f.net,
		}),
	).rejects.toThrow("does not support");
	await expect(
		readBatch({ root: f.root, projectId: "different", id: f.batch.id }),
	).rejects.toThrow("another project");
});

test("live image catalog supports a selected image model and one PIN for its batch", async () => {
	const f = await fixture(1);
	let paid = 0;
	// Fetch ABI receives positional URL/init arguments.
	// eslint-disable-next-line opencut/prefer-object-params
	const net: provider.Fetcher = async (url, init) => {
		if (String(url).endsWith("/models"))
			return Response.json({
				data: [
					{
						id: "selected/image",
						name: "Selected",
						architecture: {
							input_modalities: ["text", "image"],
							output_modalities: ["image"],
						},
						endpoints: ["/api/v1/chat/completions"],
					},
					{
						id: "text-only",
						architecture: {
							input_modalities: ["text"],
							output_modalities: ["text"],
						},
						endpoints: ["/api/v1/chat/completions"],
					},
				],
			});
		paid++;
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("selected/image");
		expect(body.modalities).toEqual(["image"]);
		return Response.json({
			choices: [
				{
					message: {
						images: [
							{
								image_url: {
									url:
										"data:image/png;base64," +
										Buffer.from("fixture-image").toString("base64"),
								},
							},
						],
					},
				},
			],
		});
	};
	expect((await provider.imageModels(net)).map((m) => m.id)).toEqual([
		"selected/image",
	]);
	const jobs = [];
	for (let index = 0; index < 2; index++)
		jobs.push(
			await provider.prepare({
				root: f.root,
				raw: {
					projectId: f.projectId,
					operationId: `image-${index}`,
					kind: "storyboard",
					model: "selected/image",
					prompt: `Reference portrait ${index}`,
					referenceImage: true,
					referenceIds: [],
				},
				referenceUrl: async () => "",
				net,
			}),
		);
	expect(paid).toBe(0);
	const batch = await prepareBatch({
		root: f.root,
		projectId: f.projectId,
		raw: {
			id: "b".repeat(32),
			kind: "images",
			jobs: jobs.map((j) => ({ id: j.id, digest: j.digest })),
		},
	});
	const done = await approveBatch({
		root: f.root,
		projectId: f.projectId,
		id: batch.id,
		digest: batch.digest,
		pin: "123456",
		confirmed: true,
		net,
		wait: true,
	});
	expect(done.status).toBe("complete");
	expect(paid).toBe(2);
	await expect(
		provider.prepare({
			root: f.root,
			raw: {
				projectId: f.projectId,
				kind: "storyboard",
				model: "text-only",
				prompt: "No image",
				referenceImage: true,
				referenceIds: [],
			},
			referenceUrl: async () => "",
			net,
		}),
	).rejects.toThrow("Selected image model");
	expect(paid).toBe(2);
});
