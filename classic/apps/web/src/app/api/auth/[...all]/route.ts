import type { toNextJsHandler } from "better-auth/next-js";

let handlers: ReturnType<typeof toNextJsHandler> | undefined;
async function handle(request: Request) {
	if (process.env.OPENCUT_LEGITATE_ONLY === "true")
		return Response.json({ error: "Sign in with Legitate." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	const { webEnv } = await import("@/env/web");
	if (!webEnv.DATABASE_URL || !webEnv.BETTER_AUTH_SECRET || !webEnv.UPSTASH_REDIS_REST_URL || !webEnv.UPSTASH_REDIS_REST_TOKEN) return Response.json({ error: "Hosted authentication is disabled. Use /api/accounts on the local host." }, { status: 503 });
	if (!handlers) {
		const [{ createHostedAuth }, { toNextJsHandler }] = await Promise.all([
			import("@/auth/server"), import("better-auth/next-js"),
		]);
		handlers ??= toNextJsHandler(createHostedAuth());
	}
	return request.method === "POST" ? handlers.POST(request) : handlers.GET(request);
}
export const POST = handle;
export const GET = handle;
