import { withAccount } from "@/accounts/server";
import { requireLocalChatGPT } from "@/editor-agent/server/chatgpt";
import { handleEditorAgentResponse } from "@/editor-agent/server/response-handler";
export const runtime = "nodejs";
export const POST = withAccount(async (request) => {
	const denied = requireLocalChatGPT(request);
	return denied ?? handleEditorAgentResponse(request);
});
