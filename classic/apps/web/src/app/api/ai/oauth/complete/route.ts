import { withAccount } from "@/accounts/server";
import { type NextRequest } from "next/server";
import { completeOpenAIAuthorizationHandoff } from "@/ai/server/openai-codex-oauth";
import { oauthReturnDocument } from "@/accounts/oauth-return";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
	const { response } = await completeOpenAIAuthorizationHandoff({ request });
	return response;
}

const completeWithAccount = withAccount(GETHandler);
export async function GET(request: NextRequest) {
	return oauthReturnDocument(request) ?? completeWithAccount(request);
}
