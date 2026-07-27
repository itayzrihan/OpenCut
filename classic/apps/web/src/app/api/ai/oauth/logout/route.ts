import { type NextRequest, NextResponse } from "next/server";
import { clearOpenAICredentials } from "@/ai/server/openai-codex-oauth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	const response = NextResponse.json({ ok: true });
	clearOpenAICredentials({ response, request });
	return response;
}
