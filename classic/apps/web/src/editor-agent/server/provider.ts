import { assertLocalOrigin } from "@/accounts/server";
import {
	chatGPTModels,
	chatGPTStatus,
	requireLocalChatGPT,
	streamChatGPTResponse,
} from "./chatgpt";
import {
	hostedProviderModels,
	hostedProviderStatus,
	streamHostedProvider,
} from "./hosted-provider";

export const usesHostedProvider = () =>
	process.env.OPENCUT_LEGITATE_HOSTED === "true";
export function requireAgentOrigin(request: Request): Response | undefined {
	if (!usesHostedProvider()) return requireLocalChatGPT(request);
	try {
		assertLocalOrigin(request);
	} catch {
		return Response.json(
			{
				error:
					"Use the authenticated POCUT workspace to connect your provider.",
			},
			{ status: 403 },
		);
	}
}
export const agentProviderStatus = () =>
	usesHostedProvider() ? hostedProviderStatus() : chatGPTStatus();
export const agentProviderModels = (signal?: AbortSignal) =>
	usesHostedProvider() ? hostedProviderModels(signal) : chatGPTModels(signal);
export const streamAgentProvider = (request: {
	body: Record<string, unknown>;
	signal: AbortSignal;
}) =>
	usesHostedProvider()
		? streamHostedProvider(request)
		: streamChatGPTResponse(request);
