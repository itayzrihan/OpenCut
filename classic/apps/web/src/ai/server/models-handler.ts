import { NextResponse } from "next/server";
import {
	chatGPTModels,
	chatGPTStatus,
	requireLocalChatGPT,
} from "@/editor-agent/server/chatgpt";

export async function handleAiModelsRequest(request: Request) {
	const denied = requireLocalChatGPT(request);
	if (denied) return denied;
	const { sharing } = await chatGPTStatus();
	if (!sharing) return NextResponse.json({ models: [], authenticated: false });
	try {
		return NextResponse.json({
			models: await chatGPTModels(request.signal),
			authenticated: true,
		});
	} catch {
		return NextResponse.json(
			{ error: "Could not load the connected ChatGPT account's models" },
			{ status: 502 },
		);
	}
}
