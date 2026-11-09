import { authenticateAccountNavigation } from "@/accounts/server";
import { legitateClientId } from "@/accounts/legitate-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try {
		await authenticateAccountNavigation(request);
		if (!legitateClientId()) throw new Error("not configured");
		return new Response(
			'<!doctype html><html><head><meta charset="utf-8"><title>Connect Legitate</title></head><body><main><h1>Connect your Legitate account</h1><p>This links the signed-in POCUT workspace to your Legitate identity.</p><form action="/api/accounts/legitate/start" method="post"><button type="submit">Continue with Legitate</button></form></main></body></html>',
			{
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						"default-src 'none'; form-action 'self' https://auth.legitate.com; base-uri 'none'; frame-ancestors 'none'",
				},
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		console.warn("[legitate] Connect denied", {
			reason:
				message === "Cross-origin request rejected"
					? "origin_rejected"
					: message === "Sign in to an POCUT account first"
						? "session_cookie_missing"
						: message === "Session expired. Sign in again"
							? "session_expired"
							: "session_unavailable",
			cookiePresent: /(?:^|;)\s*opencut-account=/.test(
				request.headers.get("cookie") ?? "",
			),
			fetchSite: ["none", "same-origin", "same-site", "cross-site"].includes(
				request.headers.get("sec-fetch-site") ?? "",
			)
				? request.headers.get("sec-fetch-site")
				: "other",
		});
		return new Response("Sign in to your POCUT workspace first.", {
			status: 401,
			headers: { "Cache-Control": "no-store" },
		});
	}
}
