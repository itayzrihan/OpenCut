import { withAccount } from "@/accounts/server";
import { handleAiModelsRequest } from "@/ai/server/models-handler";
export const runtime = "nodejs";
export const GET = withAccount(handleAiModelsRequest);
