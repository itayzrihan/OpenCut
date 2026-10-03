import { createHostedAuth } from "@/auth/server";
import { toNextJsHandler } from "better-auth/next-js";
import { webEnv } from "@/env/web";

let handlers: ReturnType<typeof toNextJsHandler> | undefined;
async function handle(request: Request) {
	if (!webEnv.DATABASE_URL || !webEnv.BETTER_AUTH_SECRET || !webEnv.UPSTASH_REDIS_REST_URL || !webEnv.UPSTASH_REDIS_REST_TOKEN) return Response.json({ error: "Hosted authentication is disabled. Use /api/accounts on the local host." }, { status: 503 });
	handlers ??= toNextJsHandler(createHostedAuth());
	return request.method === "POST" ? handlers.POST(request) : handlers.GET(request);
}
export const POST = handle;
export const GET = handle;
