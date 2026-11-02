import { authenticateAccount } from "@/accounts/server";
import { legitateClientId } from "@/accounts/legitate-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try {
		await authenticateAccount(request);
		if (!legitateClientId()) throw new Error("not configured");
		return new Response(
			'<!doctype html><html><head><meta charset="utf-8"><title>Connect Legitate</title></head><body><main><h1>Connect your Legitate account</h1><p>This links the signed-in OpenCut workspace to your Legitate identity.</p><form action="/api/accounts/legitate/start" method="post"><button type="submit">Continue with Legitate</button></form></main></body></html>',
			{
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						"default-src 'none'; form-action 'self' https://auth.legitate.com; base-uri 'none'; frame-ancestors 'none'",
				},
			},
		);
	} catch {
		return new Response("Sign in to your OpenCut workspace first.", {
			status: 401,
			headers: { "Cache-Control": "no-store" },
		});
	}
}
