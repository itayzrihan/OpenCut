import { expect, test } from "bun:test";
import { runDeepseekEditorHarness } from "../server/deepseek-harness";
import { HarnessChannel } from "../server/harness-channel";
import { driveEditorHarness } from "../harness-client";
import type { HarnessEvent } from "../harness-protocol";

test("the real DSH loop serializes canonical provider/apply rounds and stops without another model call", async () => {
	const calls: string[] = [];
	const phase = await runDeepseekEditorHarness({
		id: "serial",
		model: "existing-codex-model",
		signal: new AbortController().signal,
		bridge: {
			async call({ operation, round }) {
				calls.push(`${operation}:${round}`);
				return operation === "provider"
					? { epoch: round, response: { id: `r-${round}`, output: [] } }
					: { phase: round === 3 ? "completed" : "ready" };
			},
		},
	});
	expect(phase).toBe("completed");
	expect(calls).toEqual([
		"provider:1",
		"apply:1",
		"provider:2",
		"apply:2",
		"provider:3",
		"apply:3",
	]);
});

test("DSH never retries an uncertain editor write or treats a failed run as complete", async () => {
	for (const phase of ["failed", "paused"]) {
		let calls = 0;
		expect(
			await runDeepseekEditorHarness({
				id: phase,
				model: "codex",
				signal: new AbortController().signal,
				bridge: {
					async call({ operation }) {
						calls++;
						return operation === "provider"
							? { epoch: 1, response: {} }
							: { phase };
					},
				},
			}),
		).toBe(phase);
		expect(calls).toBe(2);
	}
	let writes = 0;
	await expect(
		runDeepseekEditorHarness({
			id: "lost-receipt",
			model: "codex",
			signal: new AbortController().signal,
			bridge: {
				async call({ operation }) {
					if (operation === "provider") return { epoch: 1, response: {} };
					writes++;
					throw new Error("Write receipt unavailable");
				},
			},
		}),
	).rejects.toThrow("Write receipt unavailable");
	expect(writes).toBe(1);
});

test("cancellation prevents a second provider call after a settled edit", async () => {
	const controller = new AbortController();
	let calls = 0;
	await expect(
		runDeepseekEditorHarness({
			id: "cancel",
			model: "codex",
			signal: controller.signal,
			bridge: {
				async call({ operation }) {
					calls++;
					if (operation === "provider") return { epoch: 1, response: {} };
					controller.abort();
					return { phase: "ready" };
				},
			},
		}),
	).rejects.toThrow();
	expect(calls).toBe(2);
});

test("transport mailboxes bind account, project, token and one-use callback identity", async () => {
	const events: HarnessEvent[] = [];
	const channel = new HarnessChannel({
		accountId: "alice",
		projectId: "film",
		send: (event) => events.push(event),
		signal: new AbortController().signal,
	});
	const result = channel.call({ operation: "provider", round: 1 });
	const call = events[0];
	if (call?.type !== "call") throw new Error("Missing callback");
	const reply = {
		accountId: "alice",
		projectId: "film",
		token: channel.token,
		callId: call.callId,
		result: "ok",
	};
	for (const override of [
		{ accountId: "bob" },
		{ projectId: "other" },
		{ token: "0".repeat(64) },
		{ callId: "stale" },
	])
		expect(() => channel.reply({ ...reply, ...override })).toThrow();
	channel.reply(reply);
	expect(await result).toBe("ok");
	expect(() => channel.reply(reply)).toThrow("already acknowledged");
	channel.close();
});

test("channel close releases a pending callback; a timeout cannot be resumed by a late reply", async () => {
	const channel = new HarnessChannel({
		accountId: "alice",
		projectId: "film",
		send: () => {},
		signal: new AbortController().signal,
	});
	const result = channel.call({ operation: "apply", round: 1 });
	channel.close(new Error("Connection lost"));
	await expect(result).rejects.toThrow("Connection lost");
	await expect(
		channel.call({ operation: "provider", round: 2 }),
	).rejects.toThrow("unavailable");
});

const eventStream = (events: HarnessEvent[]) =>
	new Response(events.map((event) => JSON.stringify(event) + "\n").join(""), {
		headers: { "Content-Type": "application/x-ndjson" },
	});
const ready = { type: "ready" as const, runId: "run", token: "a".repeat(64) };
test("client rejects reordered/repeated dispatch and never replays a write after a lost acknowledgement", async () => {
	for (const wrongOrder of [true, false]) {
		let applies = 0,
			replies = 0;
		await expect(
			driveEditorHarness({
				accountId: "alice",
				projectId: "film",
				model: "codex",
				signal: new AbortController().signal,
				assertScope() {},
				async call(operation) {
					if (operation === "apply") applies++;
					return {};
				},
				send: (async (_url, options) => {
					if (JSON.parse(String(options?.body)).type === "start")
						return eventStream([
							ready,
							{
								type: "call",
								callId: "p",
								operation: wrongOrder ? "apply" : "provider",
								round: 1,
							},
							{ type: "call", callId: "a", operation: "apply", round: 1 },
							{ type: "call", callId: "a", operation: "apply", round: 1 },
						]);
					replies++;
					return new Response("{}", { status: replies === 2 ? 409 : 200 });
				}) as typeof fetch,
			}),
		).rejects.toThrow();
		expect(applies).toBe(wrongOrder ? 0 : 1);
		expect(replies).toBe(wrongOrder ? 0 : 2);
	}
});

test("client cannot accept DSH success while an editor callback is unsettled or after account changes", async () => {
	let active = true,
		applies = 0;
	await expect(
		driveEditorHarness({
			accountId: "alice",
			projectId: "film",
			model: "codex",
			signal: new AbortController().signal,
			assertScope() {
				if (!active) throw new Error("Account changed");
			},
			async call() {
				active = false;
				applies++;
				return {};
			},
			send: (async () =>
				eventStream([
					ready,
					{ type: "call", callId: "p", operation: "provider", round: 1 },
					{ type: "done", phase: "completed" },
				])) as typeof fetch,
		}),
	).rejects.toThrow("Account changed");
	expect(applies).toBe(1);
});
