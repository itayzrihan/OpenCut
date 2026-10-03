import { withAccount } from "@/accounts/server";
import { type NextRequest } from "next/server";
import { completeOpenAIAuthorizationHandoff } from "@/ai/server/openai-codex-oauth";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
	const { response } = await completeOpenAIAuthorizationHandoff({ request });
	return response;
}

export const GET = withAccount(GETHandler);
