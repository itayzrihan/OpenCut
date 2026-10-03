import { withAccount } from "@/accounts/server";
import { handleAiChatRequest } from "@/ai/server/chat-handler";
export const runtime = "nodejs";
export const POST = withAccount(handleAiChatRequest);
