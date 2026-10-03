import { withAccount } from "@/accounts/server";
import { type NextRequest } from "next/server";
import { createOpenAIAuthorizationResponse } from "@/ai/server/openai-codex-oauth";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
	return createOpenAIAuthorizationResponse({ request });
}

export const GET = withAccount(GETHandler);
