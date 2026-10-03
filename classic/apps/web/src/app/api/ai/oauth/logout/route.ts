import { withAccount } from "@/accounts/server";
import { type NextRequest, NextResponse } from "next/server";
import { clearOpenAICredentials } from "@/ai/server/openai-codex-oauth";
import { cancelDeviceLogin } from "@/ai/server/device-login";

export const runtime = "nodejs";

async function POSTHandler(request: NextRequest) {
	await cancelDeviceLogin(request);
	const response = NextResponse.json({ ok: true });
	clearOpenAICredentials({ response, request });
	return response;
}

export const POST = withAccount(POSTHandler);
