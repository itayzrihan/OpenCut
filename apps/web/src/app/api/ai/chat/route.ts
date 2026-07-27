import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	forwardCodexResponsesRequest,
	getOpenAIOAuthStatus,
	setCredentialsCookie,
} from "@/ai/server/openai-codex-oauth";
import { ALLOWED_AI_TOOL_WIRE_NAMES } from "@/ai/tool-wire-names";

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
		model: z.string().trim().min(1).max(80).optional(),
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

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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

	const oauth = await getOpenAIOAuthStatus({ request });
	if (!oauth.status.authenticated || !oauth.credentials) {
		return NextResponse.json(
			{
				error:
					oauth.status.error ??
					"Log in with OpenAI before using the AI editing agent.",
			},
			{ status: 401 },
		);
	}

	try {
		const responseBody = await forwardCodexResponsesRequest({
			credentials: oauth.credentials,
			body: parsed.data,
			signal: request.signal,
		});
		const response = NextResponse.json({ response: responseBody });
		if (oauth.refreshedCredentials) {
			setCredentialsCookie({
				response,
				credentials: oauth.refreshedCredentials,
			});
		}
		return response;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return NextResponse.json(
				{ error: "AI request cancelled" },
				{ status: 499 },
			);
		}
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "OpenAI Codex request failed.",
			},
			{ status: 502 },
		);
	}
}
