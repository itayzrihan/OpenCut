import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpRequest } from "./mcp";
import * as store from "./store";
const noShare = async () => {
	throw new Error("Unexpected share");
};
test("external MCP import/prepare/status is scoped, idempotent, visible in normal queue and never calls paid provider", async () => {
	const root = await mkdtemp(join(tmpdir(), "director-mcp-")),
		original = globalThis.fetch;
	const calls: string[] = [];
	try {
		globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
			const [input, init] = args;
			calls.push(String(input));
			expect(init?.method ?? "GET").toBe("GET");
			expect(String(input)).toEndWith("/videos/models");
			return Response.json({
				data: [
					{
						id: "test/seedance",
						supported_durations: [8],
						supported_resolutions: ["480p"],
						supported_aspect_ratios: ["9:16"],
					},
				],
			});
		};
		const bytes = Buffer.from("test-physical-storyboard");
		const raw = {
			projectId: "project-a",
			expectedRevision: 1,
			operationId: "reference-1",
			operation: {
				type: "importReference",
				name: "board.png",
				mime: "image/png",
				dataBase64: bytes.toString("base64"),
				sha256: store.sha(bytes),
				storyboard: true,
			},
		};
		const imported = await mcpRequest({ root, raw, referenceUrl: noShare });
		const replay = await mcpRequest({
			root,
			raw: { ...raw, expectedRevision: 2 },
			referenceUrl: noShare,
		});
		expect(replay.reference).toEqual(imported.reference);
		expect(replay.revision).toBe(2);
		expect(
			(await readdir(join(root, "files"))).filter((n) => !n.endsWith(".json")),
		).toHaveLength(1);
		const refs = await store.jobs({ root, projectId: "project-a" });
		expect(refs).toHaveLength(0);
		const reference = String(imported.reference.id);
		const prepare = {
			projectId: "project-a",
			expectedRevision: 2,
			operationId: "video-1",
			operation: {
				type: "prepare",
				kind: "video",
				model: "test/seedance",
				prompt: JSON.stringify({
					creative_intent: "A calm city becomes a mysterious forest",
				}),
				duration: 8,
				resolution: "480p",
				aspectRatio: "9:16",
				referenceIds: [reference],
			},
		};
		const result = await mcpRequest({
			root,
			raw: prepare,
			referenceUrl: noShare,
		});
		const again = await mcpRequest({
			root,
			raw: prepare,
			referenceUrl: noShare,
		});
		expect(again.job).toEqual(result.job);
		expect(calls).toHaveLength(1);
		const visible = await store.jobs({ root, projectId: "project-a" });
		expect(visible).toHaveLength(1);
		expect(visible[0].status).toBe("review");
		expect(visible[0].references[0].storyboard).toBe(true);
		const status = await mcpRequest({
			root,
			raw: {
				projectId: "project-a",
				expectedRevision: 3,
				operationId: "read-1",
				operation: { type: "status" },
			},
			referenceUrl: noShare,
		});
		expect(status.jobs).toHaveLength(1);
		expect(JSON.stringify(status)).not.toContain("dataBase64");
		expect(await store.jobs({ root, projectId: "project-b" })).toHaveLength(0);
		await expect(
			mcpRequest({
				root,
				raw: {
					...prepare,
					operation: {
						...prepare.operation,
						prompt: "A different request changes the immutable input",
					},
				},
				referenceUrl: noShare,
			}),
		).rejects.toThrow("different request");
		for (const type of ["approve", "unlock", "setup"])
			await expect(
				mcpRequest({
					root,
					raw: { ...raw, operation: { type, pin: "000000" } },
					referenceUrl: noShare,
				}),
			).rejects.toThrow();
	} finally {
		globalThis.fetch = original;
		await rm(root, { recursive: true, force: true });
	}
});
test("bad hashes and interrupted operations cannot be silently imported/retried", async () => {
	const root = await mkdtemp(join(tmpdir(), "director-mcp-bad-"));
	try {
		const raw = {
			projectId: "a",
			expectedRevision: 1,
			operationId: "bad-1",
			operation: {
				type: "importReference",
				name: "x.png",
				mime: "image/png",
				dataBase64: "eA==",
				sha256: "a".repeat(64),
				storyboard: true,
			},
		};
		await expect(
			mcpRequest({ root, raw, referenceUrl: noShare }),
		).rejects.toThrow("SHA256");
		await expect(
			mcpRequest({ root, raw, referenceUrl: noShare }),
		).rejects.toThrow("interrupted");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("canonical chapter host request freezes exact per-row reviews and one manifest without paid calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "director-chapter-mcp-"));
	let calls = 0;
	try {
		// Fetch ABI receives positional URL/init arguments.
		// eslint-disable-next-line opencut/prefer-object-params
		const net = async (input: string | URL | Request, init?: RequestInit) => {
			calls++;
			expect(init?.method ?? "GET").toBe("GET");
			expect(String(input)).toEndWith("/videos/models");
			return Response.json({
				data: [
					{
						id: "test/seedance",
						supported_durations: [4, 8],
						supported_resolutions: ["720p"],
						supported_aspect_ratios: ["16:9"],
					},
				],
			});
		};
		const raw = {
			projectId: "project-a",
			expectedRevision: 1,
			operationId: "chapters-free",
			operation: {
				type: "prepareChapters",
				planId: "film",
				plan: {
					id: "film",
					title: "Film",
					version: 1,
					model: "test/seedance",
					resolution: "720p",
					aspectRatio: "16:9",
					references: [],
					chapters: [
						{
							id: "one",
							title: "One",
							duration: 4,
							prompt: "Original dialogue שלום עולם",
						},
						{
							id: "two",
							title: "Two",
							duration: 8,
							prompt: "Exact second chapter dialogue",
						},
					],
				},
			},
		};
		const result = await mcpRequest({ root, raw, referenceUrl: noShare, net });
		expect(result.jobs).toHaveLength(2);
		expect(result.batch.jobIds).toEqual(
			result.jobs.map((j: { id: string }) => j.id),
		);
		const jobs = await store.jobs({ root, projectId: "project-a" });
		expect(
			jobs.every((j) => j.status === "review" && j.batchId === result.batch.id),
		).toBe(true);
		expect(jobs.some((j) => j.prompt === "Original dialogue שלום עולם")).toBe(
			true,
		);
		expect(calls).toBe(2);
		const replay = await mcpRequest({
			root,
			raw: { ...raw, expectedRevision: 2 },
			referenceUrl: noShare,
			net,
		});
		expect(replay.batch).toEqual(result.batch);
		expect(calls).toBe(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
