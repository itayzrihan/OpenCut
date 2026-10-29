import { withAccount } from "@/accounts/server";
import { handleHarnessRequest } from "@/editor-agent/server/harness-handler";
export const runtime = "nodejs";
export const POST = withAccount(handleHarnessRequest);
