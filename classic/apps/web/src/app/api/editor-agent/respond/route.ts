import { withAccount } from "@/accounts/server";
import { handleEditorAgentResponse } from "@/editor-agent/server/response-handler";
export const runtime = "nodejs";
export const POST = withAccount(handleEditorAgentResponse);
