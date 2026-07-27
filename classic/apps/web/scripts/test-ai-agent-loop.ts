import { runAiAgent } from "../src/ai/client-agent";
import type { AiToolDefinition } from "../src/ai/types";

const requests: Array<Record<string, unknown>> = [];
let fetchCount = 0;

globalThis.fetch = (async (
	_input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => {
	fetchCount += 1;
	const body =
		typeof init?.body === "string"
			? (JSON.parse(init.body) as Record<string, unknown>)
			: {};
	requests.push(body);

	if (fetchCount === 1) {
		return new Response(
			JSON.stringify({
				response: {
					id: "resp-tool",
					output: [
						{
							type: "function_call",
							call_id: "call-search",
							name: "timeline_search_elements",
							arguments: '{"inActiveRange":true,"limit":2}',
						},
					],
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	}

	return new Response(
		JSON.stringify({
			response: {
				id: "resp-final",
				output_text:
					'{"title":"Smoke edit","summary":"Tool loop completed","operations":[]}',
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}) as unknown as typeof fetch;

const tools: AiToolDefinition[] = [
	{
		type: "function",
		name: "timeline.search_elements",
		description: "Search timeline elements.",
		parameters: {
			type: "object",
			properties: {
				inActiveRange: { type: "boolean" },
				limit: { type: "number" },
			},
			additionalProperties: false,
		},
	},
];

const result = await runAiAgent({
	messages: [
		{
			role: "system",
			content: "Use tools, then return an AiEditPlan JSON object.",
		},
		{ role: "user", content: "Do a no-op edit in the active range." },
	],
	tools,
	executeTool: async (toolCall) => ({
		tool: toolCall.name,
		arguments: toolCall.arguments,
		items: [],
	}),
	maxIterations: 4,
});

if (result.status !== "completed" || result.editPlan?.title !== "Smoke edit") {
	throw new Error(`AI agent loop smoke test failed: ${JSON.stringify(result)}`);
}

console.log(
	JSON.stringify(
		{
			ok: true,
			iterations: result.iterations,
			requestCount: requests.length,
			firstToolName: (
				(requests[0]?.tools as Array<{ name?: string }> | undefined)?.[0] ?? {}
			).name,
			secondInputTypes: (
				requests[1]?.input as Array<{ type?: string }> | undefined
			)?.map((item) => item.type),
			secondPreviousResponseId: requests[1]?.previousResponseId ?? null,
		},
		null,
		2,
	),
);
