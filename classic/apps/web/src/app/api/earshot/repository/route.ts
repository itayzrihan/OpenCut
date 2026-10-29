import { withAccount } from "@/accounts/server";
import { handleEarshotRepository } from "@/ai/earshot-repository";
export const runtime = "nodejs";
export const GET = withAccount(handleEarshotRepository, { concurrent: true });
