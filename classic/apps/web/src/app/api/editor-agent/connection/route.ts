import { withAccount } from "@/accounts/server";
import {
	chatGPTModels,
	chatGPTStatus,
	disconnectChatGPT,
	startChatGPTSignIn,
} from "@/editor-agent/server/chatgpt";
import { z } from "zod";

export const runtime = "nodejs";
export const GET = withAccount(async () => {
	try {
		return Response.json(await chatGPTStatus());
	} catch {
		return Response.json(
			{ error: "The saved ChatGPT connection could not be read" },
			{ status: 503 },
		);
	}
});
export const POST = withAccount(async (request) => {
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
