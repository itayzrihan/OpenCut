import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { requestAgentResponse } from "../transport";
import { AgentStreamDisconnected } from "../stream";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stream = (text: string) =>
	new Response(text, { headers: { "content-type": "text/event-stream" } });
const complete = { id: "complete", status: "completed", output: [] };
let runtime: Awaited<ReturnType<typeof createCanonicalTestRuntime>>;
beforeAll(async () => {
	runtime = await createCanonicalTestRuntime();
});
afterAll(() => runtime.free());
const options = () => ({
	signal: new AbortController().signal,
	beforeAttempt: () => {},
	onEvent: () => {},
	onRetry: () => {},
	wait: async () => {},
	planRetry: (failure: import("../transport").ProviderFailureInput) =>
		z
			.object({
				retry: z.boolean(),
				delayMs: z.number(),
				maxAttempts: z.number(),
			})
			.parse(runtime.providerRetryPlan(failure)),
});

test("discards the disconnected attempt's finished call before retrying transport", async () => {
	let sends = 0;
	const retries: number[] = [];
	const result = await requestAgentResponse({
		...options(),
		onRetry: (attempt) => retries.push(attempt),
		send: async () =>
			++sends === 1
				? stream(
						event({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								id: "discarded",
								type: "function_call",
								call_id: "never-execute",
								name: "editor",
								arguments: "{}",
							},
						}),
					)
				: stream(event({ type: "response.completed", response: complete })),
	});
	expect(result).toEqual(complete);
	expect(sends).toBe(2);
	expect(retries).toEqual([1]);
});

test("retries network disconnects at most twice", async () => {
	let sends = 0;
	await expect(
		requestAgentResponse({
			...options(),
			send: async () => {
				sends++;
				throw new TypeError("Network failed");
			},
		}),
	).rejects.toBeInstanceOf(AgentStreamDisconnected);
	expect(sends).toBe(3);
});

test("does not retry auth, malformed protocol or explicit provider failure", async () => {
	for (const response of [
		new Response('{"error":"Unauthorized"}', { status: 401 }),
		stream("data: invalid-json\n\n"),
		stream(
			event({
				type: "response.failed",
				error: { message: "Provider stopped" },
			}),
		),
	]) {
		let sends = 0;
		await expect(
			requestAgentResponse({
				...options(),
				send: async () => {
					sends++;
					return response;
				},
			}),
		).rejects.toThrow();
		expect(sends).toBe(1);
	}
});

test("cancellation or changed account/project stops before another send", async () => {
	let sends = 0;
	const controller = new AbortController();
	await expect(
		requestAgentResponse({
			...options(),
			signal: controller.signal,
			send: async () => {
				sends++;
				return stream("");
			},
			onRetry: () => controller.abort(),
		}),
	).rejects.toThrow();
	expect(sends).toBe(1);
	let checks = 0;
	await expect(
		requestAgentResponse({
			...options(),
			beforeAttempt: () => {
				if (++checks === 2) throw new Error("Scope changed");
			},
			send: async () => {
				sends++;
				return stream("");
			},
		}),
	).rejects.toThrow("Scope changed");
	expect(sends).toBe(2);
});

test("Rust retries overload/503 before complete output and discards the failed attempt's tool call", async () => {
	for (const failed of [
		new Response('{"error":{"code":"server_error","message":"Busy"}}', {
			status: 503,
			headers: { "retry-after": "2" },
		}),
		stream(
			event({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					id: "discarded",
					type: "function_call",
					call_id: "no-replay",
					name: "opencut_editor",
					arguments: "{}",
				},
			}) +
				event({
					type: "response.failed",
					error: {
						code: "server_error",
						message:
							"Our servers are currently overloaded. Please try again later.",
					},
				}),
		),
	]) {
		let sends = 0;
		const waits: number[] = [];
		const result = await requestAgentResponse({
			...options(),
			wait: async ({ milliseconds }) => {
				waits.push(milliseconds);
			},
			send: async () =>
				++sends === 1
					? failed
					: stream(event({ type: "response.completed", response: complete })),
		});
		expect(result).toEqual(complete);
		expect(sends).toBe(2);
		expect(waits).toHaveLength(1);
		expect(waits[0]).toBeGreaterThanOrEqual(1000);
	}
});

test("quota/auth/protocol failures stop without retry and temporary errors have a bounded native budget", async () => {
	for (const response of [
		new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }),
		stream(
			event({ type: "response.incomplete", error: { code: "server_error" } }),
		),
	]) {
		let sends = 0;
		await expect(
			requestAgentResponse({
				...options(),
				send: async () => {
					sends++;
					return response;
				},
			}),
		).rejects.toThrow();
		expect(sends).toBe(1);
	}
	let sends = 0;
	await expect(
		requestAgentResponse({
			...options(),
			send: async () => {
				sends++;
				return new Response('{"error":"Busy"}', { status: 503 });
			},
		}),
	).rejects.toThrow();
	expect(sends).toBe(5);
});
