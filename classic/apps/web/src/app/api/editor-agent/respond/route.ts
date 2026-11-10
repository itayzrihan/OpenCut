import { withAccount } from "@/accounts/server";
import { requireAgentOrigin } from "@/editor-agent/server/provider";
import { handleEditorAgentResponse } from "@/editor-agent/server/response-handler";
export const runtime = "nodejs";
export const POST = withAccount(async (request) => {
	const denied = requireAgentOrigin(request);
	return denied ?? handleEditorAgentResponse(request);
});
