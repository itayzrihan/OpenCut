import { type NextRequest } from "next/server";
import { completeOpenAIAuthorizationHandoff } from "@/ai/server/openai-codex-oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
	const { response } = await completeOpenAIAuthorizationHandoff({ request });
	return response;
}
