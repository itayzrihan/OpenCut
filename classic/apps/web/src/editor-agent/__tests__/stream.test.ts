import { describe, expect, it } from "bun:test";
import { readAgentResponse, type AgentStreamEvent } from "../stream";

function stream(text: string) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream({
			start(controller) {
				// Includes split CRLF and UTF-8 code points.
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
const completed = { id: "resp_1", status: "completed", output: [] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

describe("editor agent provider stream", () => {
	it("recovers ordered completed calls and encrypted continuation from a sparse terminal", async () => {
		const reasoning = {
			id: "rs_1",
			type: "reasoning",
			encrypted_content: "opaque",
		};
		const call = {
			id: "fc_1",
			type: "function_call",
			call_id: "call_1",
			name: "editor",
			arguments: '{"operation":"remix"}',
			status: "completed",
		};
		const result = await readAgentResponse({
			response: stream(
				event({
					type: "response.output_item.done",
					output_index: 1,
					item: call,
				}) +
					event({
						type: "response.output_item.done",
						output_index: 0,
						item: reasoning,
					}) +
					event({ type: "response.completed", response: completed }),
			),
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		expect(result).toEqual({ ...completed, output: [reasoning, call] });
	});
	it("deduplicates terminal items without promoting unfinished added calls", async () => {
		const call = {
			id: "fc_1",
			type: "function_call",
			call_id: "call_1",
			name: "editor",
			arguments: "{}",
			status: "completed",
		};
		expect(
			await readAgentResponse({
				response: stream(
					event({
						type: "response.output_item.added",
						output_index: 1,
						item: { ...call, id: "fc_partial", arguments: "{" },
					}) +
						event({
							type: "response.output_item.done",
							output_index: 0,
							item: call,
						}) +
						event({
							type: "response.output_item.done",
							output_index: 0,
							item: call,
						}) +
						event({
							type: "response.completed",
							response: { ...completed, output: [call] },
						}),
				),
				signal: new AbortController().signal,
				onEvent: () => {},
			}),
		).toEqual({ ...completed, output: [call] });
	});
	it("never accepts completed items without successful response completion", async () => {
		for (const ending of ["", event({ type: "response.incomplete" })]) {
			await expect(
				readAgentResponse({
					response: stream(
						event({
							type: "response.output_item.done",
							output_index: 0,
							item: { id: "fc_1", type: "function_call", arguments: "{}" },
						}) + ending,
					),
					signal: new AbortController().signal,
					onEvent: () => {},
				}),
			).rejects.toThrow();
		}
	});
	it("renders only public summaries and waits for completed before returning actions", async () => {
		const events: AgentStreamEvent[] = [];
		const response = stream(
			event({ type: "response.output_text.delta", delta: "שלום" }) +
				event({
					type: "response.reasoning_summary_text.delta",
					delta: "Checking timing",
				}) +
				event({ type: "response.reasoning_text.delta", delta: "private" }) +
				event({ type: "response.completed", response: completed }),
		);
		expect(
			await readAgentResponse({
				response,
				signal: new AbortController().signal,
				onEvent: (item) => events.push(item),
			}),
		).toEqual(completed);
		expect(events).toEqual([
			{ type: "text", text: "שלום" },
			{ type: "summary", text: "Checking timing" },
		]);
	});
	it("rejects a late subscription error even after text and tool deltas", async () => {
		const response = stream(
			event({ type: "response.output_text.delta", delta: "I will edit" }) +
				event({ type: "response.function_call_arguments.delta", delta: "{}" }) +
				event({
					type: "response.failed",
					response: { error: { message: "Usage limit reached" } },
				}),
		);
		await expect(
			readAgentResponse({
				response,
				signal: new AbortController().signal,
				onEvent: () => {},
			}),
		).rejects.toThrow("Usage limit reached");
	});
	it("rejects abrupt completion and cancellation", async () => {
		await expect(
			readAgentResponse({
				response: stream(
					event({ type: "response.output_text.delta", delta: "Partial" }),
				),
				signal: new AbortController().signal,
				onEvent: () => {},
			}),
		).rejects.toThrow("disconnected");
		const controller = new AbortController();
		controller.abort();
		await expect(
			readAgentResponse({
				response: stream(
					event({ type: "response.completed", response: completed }),
				),
				signal: controller.signal,
				onEvent: () => {},
			}),
		).rejects.toThrow();
	});
});
