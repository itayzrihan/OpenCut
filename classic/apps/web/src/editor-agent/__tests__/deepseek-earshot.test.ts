// @opencut-test-wasm: real
import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { EditingAgentHostResult } from "@/core/agent-protocol";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { EARSHOT_BANK_REVISION } from "@/earshot/catalog";
import { driveEditorHarness } from "../harness-client";

// Only authentication, provider responses and PCM host IO are fixtures. The
// HTTP channel, DSH scheduler, contracts, transactions and artifacts are real.
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: "alice" }),
}));
const { handleHarnessRequest } = await import("../server/harness-handler");
type Runtime = Awaited<ReturnType<typeof createCanonicalTestRuntime>>;
type Step = {
	action: Record<string, unknown> | (() => Record<string, unknown>);
	inspect?: (output: unknown) => void;
	error?: string;
	host?: (effect: unknown) => EditingAgentHostResult;
};
const data = (output: unknown) =>
	z
		.object({
			result: z.object({ result: z.object({ data: z.unknown() }) }),
		})
		.parse(output).result.result.data;
const hostEffect = z.object({
	id: z.number(),
	adapter: z.literal("earshotPreview"),
	projectId: z.literal("classic-project"),
	request: z.object({
		projectId: z.literal("classic-project"),
		expectedRevision: z.number(),
		procedural: z.record(z.string(), z.unknown()),
		startFrame: z.number(),
		frames: z.number(),
	}),
});

async function setup() {
	const runtime = await createCanonicalTestRuntime();
	runtime.invokeSync(
		"project.classic.session.attach",
		{
			projectId: "classic-project",
			expectedRevision: 0,
			classic: JSON.parse(
				await readFile(
					new URL(
						"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		},
		null,
	);
	return runtime;
}

async function drive({ runtime, steps }: { runtime: Runtime; steps: Step[] }) {
	const controller = new AbortController();
	let pending: { epoch: number; response: unknown } | undefined;
	let applications = 0;
	try {
		const phase = await driveEditorHarness({
			accountId: "alice",
			projectId: "classic-project",
			model: "fixture-codex",
			signal: controller.signal,
			assertScope() {
				expect(runtime.snapshot().project.id).toBe("classic-project");
			},
			// eslint-disable-next-line opencut/prefer-object-params -- implement the standard fetch transport signature.
			send: (async (_url, options) =>
				handleHarnessRequest(
					new Request("http://localhost/api/editor-agent/harness", options),
				)) as typeof fetch,
			async call(operation, round) {
				const step = steps[round - 1];
				if (!step) throw new Error("Unexpected provider round");
				if (operation === "provider") {
					const request = runtime.agentProviderRequest("fixture-codex");
					expect(
						request.body.tools.map((tool: { name: string }) => tool.name),
					).toEqual(["opencut_editor"]);
					const action =
						typeof step.action === "function" ? step.action() : step.action;
					pending = {
						epoch: request.epoch,
						response: {
							id: `earshot-response-${round}`,
							status: "completed",
							output: [
								{
									type: "function_call",
									call_id: `earshot-call-${round}`,
									name: "opencut_editor",
									arguments: JSON.stringify(action),
								},
							],
						},
					};
					return pending;
				}
				if (!pending) throw new Error("No pending provider response");
				const current = pending;
				pending = undefined;
				let applied = runtime.agentProviderResponse(
					current.epoch,
					current.response,
				);
				if (applied.pendingHost) {
					if (!step.host) throw new Error("Unexpected host dispatch");
					const effect = hostEffect.parse(applied.pendingHost);
					expect(runtime.agentPendingHost()).toEqual(applied.pendingHost);
					const beforeHost = runtime.snapshot();
					applied = runtime.agentSettleHost(
						"alice",
						"classic-project",
						effect.id,
						step.host(effect),
					);
					expect(runtime.agentPendingHost()).toBeNull();
					expect(runtime.snapshot()).toEqual(beforeHost);
				} else expect(step.host).toBeUndefined();
				expect(applied.activities).toHaveLength(1);
				const activity = applied.activities[0];
				expect(activity.ok).toBe(!step.error);
				if (step.error)
					expect(JSON.stringify(activity.output)).toContain(step.error);
				step.inspect?.(activity.output);
				if (applied.needsVerification)
					runtime.agentVerify(
						runtime.agentSnapshot().epoch,
						runtime.snapshot().revision,
						[],
					);
				applications++;
				return { phase: runtime.agentSnapshot().phase };
			},
		});
		expect(applications).toBe(steps.length);
		return phase;
	} finally {
		controller.abort();
	}
}

test("DSH discovers Earshot, reads its source, edits a procedural clip and receives canonical preview evidence", async () => {
	const runtime = await setup();
	try {
		runtime.agentStart(
			"alice",
			"dsh-earshot",
			"Add and customize an Earshot click, then preview it",
		);
		let entry: {
			procedural: Record<string, unknown>;
			sourceCode: string;
			sound: { name: string; sourcePath: string };
		};
		let reference: { trackId: string; elementId: string };
		let recipe: Record<string, unknown>;
		let artifactId = "";
		const phase = await drive({
			runtime,
			steps: [
				{
					action: {
						action: "plan",
						steps: [{ title: "Read, edit and preview", status: "inProgress" }],
					},
				},
				{
					action: { action: "discover", query: "earshot", limit: 20 },
					inspect(output) {
						expect(JSON.stringify(output)).toContain(
							"audio.earshot.catalog.read",
						);
						expect(JSON.stringify(output)).toContain("audio.earshot.preview");
					},
				},
				{ action: { action: "describe", id: "audio.earshot.catalog.search" } },
				{
					action: {
						action: "invoke",
						id: "audio.earshot.catalog.search",
						input: { query: "click", limit: 5 },
					},
					inspect(output) {
						expect(
							z.object({ totalCatalogItems: z.number() }).parse(data(output))
								.totalCatalogItems,
						).toBe(252);
					},
				},
				{ action: { action: "describe", id: "audio.earshot.catalog.read" } },
				{
					action: {
						action: "invoke",
						id: "audio.earshot.catalog.read",
						input: { bankRevision: EARSHOT_BANK_REVISION, id: "click/double" },
					},
					inspect(output) {
						entry = z
							.object({
								procedural: z.record(z.string(), z.unknown()),
								sourceCode: z.string(),
								sound: z.object({ name: z.string(), sourcePath: z.string() }),
							})
							.parse(data(output));
						recipe = {
							...entry.procedural,
							duration: 0.02,
							pitch: "C5",
							sourceCode: entry.sourceCode,
							echo: { delay: 0.1, feedback: 0.3, mix: 0.2 },
						};
						expect(entry.sourceCode).toContain("source_spec");
					},
				},
				{ action: { action: "describe", id: "audio.earshot.repository.read" } },
				{
					action: {
						action: "invoke",
						id: "audio.earshot.repository.read",
						input: {
							bankRevision: EARSHOT_BANK_REVISION,
							path: "README.md",
							limit: 2000,
						},
					},
					inspect(output) {
						expect(
							z
								.object({ text: z.string() })
								.parse(data(output))
								.text.toLowerCase(),
						).toContain("earshot");
					},
				},
				{
					action: () => ({
						action: "invoke",
						id: "audio.earshot.repository.read",
						input: {
							bankRevision: EARSHOT_BANK_REVISION,
							path: entry.sound.sourcePath,
							limit: 2000,
						},
					}),
					inspect(output) {
						expect(
							z.object({ text: z.string() }).parse(data(output)).text.length,
						).toBeGreaterThan(20);
					},
				},
				{
					action: {
						action: "describe",
						id: "timeline.classic.elements.insert",
					},
				},
				{
					action: () => ({
						action: "invoke",
						id: "timeline.classic.elements.insert",
						input: {
							sceneId: "main-scene",
							clips: [
								{
									placement: { mode: "auto", trackType: "audio" },
									element: {
										type: "audio",
										sourceType: "procedural",
										procedural: { ...entry.procedural, duration: 0.02 },
										name: entry.sound.name,
										startTime: 0,
										duration: 2400,
										sourceDuration: 2400,
										trimStart: 0,
										trimEnd: 0,
										params: { volume: -12, muted: false },
									},
								},
							],
						},
					}),
					inspect(output) {
						reference = z
							.object({
								elements: z
									.array(
										z.object({ trackId: z.string(), elementId: z.string() }),
									)
									.length(1),
							})
							.parse(data(output)).elements[0]!;
					},
				},
				{
					action: {
						action: "describe",
						id: "timeline.classic.audio.procedural.set",
					},
				},
				{
					action: () => ({
						action: "invoke",
						id: "timeline.classic.audio.procedural.set",
						input: {
							sceneId: "main-scene",
							updates: [{ ...reference, procedural: recipe }],
						},
					}),
				},
				{ action: { action: "describe", id: "app.state.read" } },
				{
					action: {
						action: "invoke",
						id: "app.state.read",
						input: {
							pointer: "/project/classic/document/scenes/0/tracks/audio",
						},
					},
					inspect(output) {
						const tracks = z
							.object({
								value: z.array(
									z.object({
										elements: z.array(z.record(z.string(), z.unknown())),
									}),
								),
							})
							.parse(data(output)).value;
						const clip = tracks
							.flatMap((track) => track.elements)
							.find((element) => element.id === reference.elementId);
						expect(clip?.procedural).toEqual(recipe);
						expect(clip?.mediaId).toBeUndefined();
						expect(clip?.file).toBeUndefined();
					},
				},
				{
					action: { action: "describe", id: "audio.earshot.preview" },
					inspect(output) {
						expect(JSON.stringify(output)).toContain('"openWorld":true');
						expect(JSON.stringify(output)).toContain('"available":true');
					},
				},
				{
					action: () => ({
						action: "invoke",
						id: "audio.earshot.preview",
						input: { procedural: recipe },
					}),
					host(raw) {
						const effect = hostEffect.parse(raw);
						expect(effect.request.procedural).toEqual(recipe);
						expect(effect.request.expectedRevision).toBe(
							runtime.snapshot().revision,
						);
						expect(effect.request.startFrame).toBe(0);
						expect(effect.request.frames).toBe(960);
						const pcm = Buffer.alloc(effect.request.frames * 2);
						for (let i = 0; i < effect.request.frames; i++)
							pcm.writeInt16LE(i % 2 ? -8192 : 8192, i * 2);
						return {
							type: "success",
							data: { channels: 1, pcm16Base64: pcm.toString("base64") },
						};
					},
					inspect(output) {
						const result = z
							.object({
								artifact: z.object({
									id: z.string(),
									mimeType: z.literal("audio/wav"),
								}),
								peak: z.number(),
								rms: z.number(),
							})
							.parse(data(output));
						expect(result.peak).toBeCloseTo(0.25);
						expect(result.rms).toBeCloseTo(0.25);
						artifactId = result.artifact.id;
						const bytes = runtime.readArtifact(artifactId);
						expect(bytes.length).toBe(44 + 1920);
						expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
					},
				},
				{
					action: {
						action: "plan",
						steps: [{ title: "Read, edit and preview", status: "complete" }],
					},
				},
				{
					action: {
						action: "complete",
						text: "Added, customized and verified the procedural click",
					},
				},
			],
		});
		expect(phase).toBe("completed");
		expect(runtime.agentSnapshot().pendingApproval).toBeFalsy();
		expect(runtime.agentSnapshot().receipts).toContainEqual(
			expect.objectContaining({
				capabilityId: "audio.earshot.preview",
				committed: true,
				artifactIds: [artifactId],
			}),
		);
		expect(runtime.snapshot().revision).toBe(3);
	} finally {
		runtime.free();
	}
}, 60_000);

test("DSH Plan mode can inspect Earshot but cannot synthesize, insert or grant itself permissions", async () => {
	const runtime = await setup();
	try {
		runtime.invokeSync(
			"agent.policy.set",
			{
				projectId: "classic-project",
				expectedRevision: runtime.snapshot().revision,
				mode: "plan",
				computerAccess: false,
			},
			null,
		);
		const before = runtime.snapshot();
		runtime.agentStart(
			"alice",
			"dsh-earshot-plan",
			"Propose a sound without changing the project",
		);
		const phase = await drive({
			runtime,
			steps: [
				{
					action: {
						action: "plan",
						steps: [{ title: "Proposed sound", status: "pending" }],
					},
				},
				{ action: { action: "describe", id: "audio.earshot.catalog.read" } },
				{
					action: {
						action: "invoke",
						id: "audio.earshot.catalog.read",
						input: { bankRevision: EARSHOT_BANK_REVISION, id: "click/double" },
					},
				},
				{
					action: { action: "describe", id: "audio.earshot.preview" },
					inspect(output) {
						expect(JSON.stringify(output)).toContain('"available":false');
					},
				},
				{
					action: { action: "invoke", id: "audio.earshot.preview", input: {} },
					error: "Plan mode",
				},
				{
					action: {
						action: "invoke",
						id: "timeline.classic.elements.insert",
						input: {},
					},
					error: "Plan mode",
				},
				{
					action: {
						action: "invoke",
						id: "agent.policy.set",
						input: { mode: "fullAccess", computerAccess: true },
					},
					error: "authority",
				},
				{
					action: {
						action: "complete",
						text: "Proposed an Earshot click; no edit or synthesis executed",
					},
				},
			],
		});
		expect(phase).toBe("completed");
		expect(runtime.snapshot()).toEqual(before);
		expect(runtime.agentPendingHost()).toBeNull();
		expect(
			runtime
				.agentSnapshot()
				.receipts.every(
					(receipt: { committed: boolean }) => !receipt.committed,
				),
		).toBe(true);
	} finally {
		runtime.free();
	}
}, 60_000);

test("DSH reports rejected Earshot host synthesis as failure without publishing an artifact or changing the project", async () => {
	const runtime = await setup();
	try {
		const before = runtime.snapshot();
		runtime.agentStart(
			"alice",
			"dsh-earshot-rejected",
			"Preview a sound; stop if synthesis fails",
		);
		let recipe: unknown;
		const phase = await drive({
			runtime,
			steps: [
				{
					action: {
						action: "plan",
						steps: [{ title: "Preview sound", status: "inProgress" }],
					},
				},
				{ action: { action: "describe", id: "audio.earshot.catalog.read" } },
				{
					action: {
						action: "invoke",
						id: "audio.earshot.catalog.read",
						input: { bankRevision: EARSHOT_BANK_REVISION, id: "click/double" },
					},
					inspect(output) {
						recipe = z
							.object({ procedural: z.unknown() })
							.parse(data(output)).procedural;
					},
				},
				{ action: { action: "describe", id: "audio.earshot.preview" } },
				{
					action: () => ({
						action: "invoke",
						id: "audio.earshot.preview",
						input: { projectId: "another-project", procedural: recipe },
					}),
					error: "owned-project",
				},
				{
					action: () => ({
						action: "invoke",
						id: "audio.earshot.preview",
						input: { procedural: recipe },
					}),
					host: () => ({
						type: "rejected",
						message: "Synthesis cancelled by host",
					}),
					error: "Synthesis cancelled by host",
				},
				{
					action: {
						action: "fail",
						text: "Synthesis was cancelled; no sound or preview was published",
					},
				},
			],
		});
		expect(phase).toBe("failed");
		expect(runtime.snapshot()).toEqual(before);
		expect(runtime.agentPendingHost()).toBeNull();
		expect(
			runtime
				.agentSnapshot()
				.receipts.flatMap(
					(receipt: { artifactIds: string[] }) => receipt.artifactIds,
				),
		).toEqual([]);
		expect(
			runtime
				.agentSnapshot()
				.receipts.every(
					(receipt: { committed: boolean }) => !receipt.committed,
				),
		).toBe(true);
	} finally {
		runtime.free();
	}
}, 60_000);
