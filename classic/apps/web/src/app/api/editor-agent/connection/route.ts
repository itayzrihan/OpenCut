import { withAccount } from "@/accounts/server";
import {
	chatGPTModels,
	disconnectChatGPT,
	startChatGPTSignIn,
} from "@/editor-agent/server/chatgpt";
import { readBoundedBody } from "@/accounts/request-body";
import {
	agentProviderModels,
	agentProviderStatus,
	requireAgentOrigin,
	usesHostedProvider,
} from "@/editor-agent/server/provider";
import {
	connectHostedProvider,
	disconnectHostedProvider,
} from "@/editor-agent/server/hosted-provider";
import { z } from "zod";

export const runtime = "nodejs";
export const GET = withAccount(async (request) => {
	const denied = requireAgentOrigin(request);
	if (denied) return denied;
	try {
		return Response.json(await agentProviderStatus(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "The saved ChatGPT connection could not be read" },
			{ status: 503 },
		);
	}
});
export const POST = withAccount(async (request) => {
	const denied = requireAgentOrigin(request);
	if (denied) return denied;
	if (usesHostedProvider()) {
		try {
			const value = JSON.parse(
				new TextDecoder().decode(
					await readBoundedBody({ request, maximumBytes: 4096 }),
				),
			);
			const input = z
				.discriminatedUnion("operation", [
					z
						.object({
							operation: z.literal("connectHosted"),
							pin: z.string().regex(/^\d{6,16}$/),
							apiKey: z.string().min(1).max(1024).optional(),
							confirmed: z.literal(true),
						})
						.strict(),
					z.object({ operation: z.enum(["disconnect", "models"]) }).strict(),
				])
				.parse(value);
			const result =
				input.operation === "connectHosted"
					? await connectHostedProvider(input)
					: input.operation === "disconnect"
						? disconnectHostedProvider()
						: { models: await agentProviderModels(request.signal) };
			return Response.json(result, {
				headers: { "Cache-Control": "no-store" },
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof z.ZodError || error instanceof SyntaxError
							? "Invalid provider connection request"
							: error instanceof Error
								? error.message
								: "Provider connection failed",
				},
				{ status: 400, headers: { "Cache-Control": "no-store" } },
			);
		}
	}
	const input = z
		.object({ operation: z.enum(["signIn", "disconnect", "models"]) })
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!input.success)
		return Response.json(
			{ error: "Invalid connection operation" },
			{ status: 400 },
		);
	try {
		return Response.json(
			input.data.operation === "signIn"
				? await startChatGPTSignIn()
				: input.data.operation === "disconnect"
					? await disconnectChatGPT()
					: { models: await chatGPTModels(request.signal) },
		);
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : "ChatGPT connection failed",
			},
			{ status: 400 },
		);
	}
});
