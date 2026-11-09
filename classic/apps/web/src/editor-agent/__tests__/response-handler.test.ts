import { expect, mock, test } from "bun:test";
import { handleEditorAgentResponse } from "../server/response-handler";

const streamChatGPTResponse = mock(
	async (_request: { body: unknown }) => new Response("mock stream"),
);
mock.module("../server/chatgpt", () => ({ streamChatGPTResponse }));

const body = {
	model: "test-model",
	instructions: "test instructions",
	input: [{ role: "user", content: "test" }],
	tools: [],
};

function respond(reasoningEffort?: unknown) {
	return handleEditorAgentResponse(
		new Request("http://localhost/api/editor-agent/respond", {
			method: "POST",
			body: JSON.stringify({ ...body, reasoningEffort }),
		}),
	);
}

test("forwards the selected effort as Responses API reasoning metadata", async () => {
	expect((await respond("xhigh")).status).toBe(200);
	expect(streamChatGPTResponse.mock.lastCall?.[0].body).toStrictEqual({
		...body,
		reasoning: { effort: "xhigh", summary: "auto" },
		include: ["reasoning.encrypted_content"],
		parallel_tool_calls: false,
	});
});

test("uses the provider default when no effort is supplied", async () => {
	expect((await respond()).status).toBe(200);
	expect(streamChatGPTResponse.mock.lastCall?.[0].body).toMatchObject({
		reasoning: { summary: "auto" },
	});
	expect(streamChatGPTResponse.mock.lastCall?.[0].body).not.toHaveProperty(
		"reasoning.effort",
	);
});

test("rejects malformed reasoning effort before making a provider request", async () => {
	streamChatGPTResponse.mockClear();
	expect((await respond({ effort: "high" })).status).toBe(400);
	expect(streamChatGPTResponse).not.toHaveBeenCalled();
});
