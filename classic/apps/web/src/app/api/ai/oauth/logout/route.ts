import { withAccount } from "@/accounts/server";
import { type NextRequest, NextResponse } from "next/server";
import { clearOpenAICredentials } from "@/ai/server/openai-codex-oauth";

export const runtime = "nodejs";

async function POSTHandler(request: NextRequest) {
	const response = NextResponse.json({ ok: true });
	clearOpenAICredentials({ response, request });
	return response;
}

export const POST = withAccount(POSTHandler);
