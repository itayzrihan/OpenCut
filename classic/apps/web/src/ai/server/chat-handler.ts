import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	agentProviderModels,
	agentProviderStatus,
	requireAgentOrigin,
	usesHostedProvider,
	streamAgentProvider,
} from "@/editor-agent/server/provider";
import { AgentProviderFailure, readAgentResponse } from "@/editor-agent/stream";
import { ALLOWED_AI_TOOL_WIRE_NAMES } from "@/ai/tool-wire-names";
import { retryOverload } from "@/ai/server/retry-overload";

const MAX_AI_CHAT_BODY_BYTES = 1_000_000;
const MAX_AI_INPUT_ITEMS = 40;
const MAX_AI_TOOLS = 12;

const aiToolSchema = z
	.object({
		type: z.literal("function"),
		name: z
			.string()
			.min(1)
			.max(80)
			.refine((name) => ALLOWED_AI_TOOL_WIRE_NAMES.has(name), {
				message: "Unknown AI tool",
			}),
		description: z.string().max(4_000),
		parameters: z.record(z.string(), z.unknown()),
		strict: z.boolean().optional(),
	})
	.strict();

const chatRequestSchema = z
	.object({
		input: z.array(z.unknown()).min(1).max(MAX_AI_INPUT_ITEMS),
		tools: z.array(aiToolSchema).max(MAX_AI_TOOLS).optional(),
		webSearch: z.boolean().optional(),
		model: z.string().trim().min(1).max(100).optional(),
		reasoningEffort: z
			.string()
			.regex(/^[a-z][a-z0-9_]{0,31}$/)
			.optional(),
		previousResponseId: z.string().trim().min(1).max(200).optional(),
	})
	.strict()
	.refine(
		(value) => value.webSearch !== true || (value.tools?.length ?? 0) === 0,
		{
			message: "Web research must be isolated from local function tools",
			path: ["webSearch"],
		},
	);

export async function handleAiChatRequest(request: NextRequest) {
	const denied = requireAgentOrigin(request);
	if (denied) return denied;
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (
		Number.isFinite(contentLength) &&
		contentLength > MAX_AI_CHAT_BODY_BYTES
	) {
		return NextResponse.json(
			{ error: "AI request is too large" },
			{ status: 413 },
		);
	}

	const body = await request.json().catch(() => null);
	if (JSON.stringify(body).length > MAX_AI_CHAT_BODY_BYTES) {
		return NextResponse.json(
			{ error: "AI request is too large" },
			{ status: 413 },
		);
	}

	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{
				error: "Invalid AI request",
				details: parsed.error.flatten().fieldErrors,
			},
			{ status: 400 },
		);
	}

	const { sharing } = await agentProviderStatus();
	if (!sharing) {
		return NextResponse.json(
			{
				error: "Connect your AI provider in the POCUT Agent to use AI editing.",
			},
			{ status: 401 },
		);
	}
	const { input, tools, webSearch, reasoningEffort } = parsed.data;
	const instructions = input.flatMap((item) => {
		const message = z
			.object({ role: z.literal("system"), content: z.string() })
			.safeParse(item);
		return message.success ? [message.data.content] : [];
	});
	const providerInput = input.filter(
		(item) =>
			!(
				item &&
				typeof item === "object" &&
				"role" in item &&
				item.role === "system"
			),
	);
	try {
		const model =
			parsed.data.model ?? (await agentProviderModels(request.signal))[0]?.id;
		if (!model)
			throw new Error("No models are available for this provider connection.");
		const providerTools = webSearch ? [{ type: "web_search" }] : tools;
		const requestProvider = async () =>
			readAgentResponse({
				response: await streamAgentProvider({
					body: {
						model,
						input: providerInput,
						...(instructions.length
							? { instructions: instructions.join("\n\n") }
							: {}),
						...(providerTools?.length ? { tools: providerTools } : {}),
						...(webSearch
							? { include: ["web_search_call.action.sources"] }
							: {}),
						...(reasoningEffort
							? { reasoning: { effort: reasoningEffort } }
							: {}),
						parallel_tool_calls: !webSearch,
					},
					signal: request.signal,
				}),
				signal: request.signal,
				onEvent: () => {},
			});
		const responseBody = usesHostedProvider()
			? await requestProvider()
			: await retryOverload({
					request: requestProvider,
					signal: request.signal,
				});
		return NextResponse.json({ response: responseBody });
	} catch (error) {
		if (request.signal.aborted) {
			return NextResponse.json(
				{ error: "AI request cancelled" },
				{ status: 499 },
			);
		}
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "ChatGPT request failed.",
			},
			{
				status:
					error instanceof AgentProviderFailure && error.failure.status === 429
						? 429
						: 502,
			},
		);
	}
}
