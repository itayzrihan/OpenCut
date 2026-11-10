import { NextResponse } from "next/server";
import {
	agentProviderModels,
	agentProviderStatus,
	requireAgentOrigin,
} from "@/editor-agent/server/provider";

export async function handleAiModelsRequest(request: Request) {
	const denied = requireAgentOrigin(request);
	if (denied) return denied;
	const { sharing } = await agentProviderStatus();
	if (!sharing) return NextResponse.json({ models: [], authenticated: false });
	try {
		return NextResponse.json({
			models: await agentProviderModels(request.signal),
			authenticated: true,
		});
	} catch {
		return NextResponse.json(
			{ error: "Could not load the connected provider's models" },
			{ status: 502 },
		);
	}
}
