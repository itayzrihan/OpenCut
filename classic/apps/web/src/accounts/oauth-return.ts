import { randomBytes } from "node:crypto";

/** A navigation from an external OAuth site may omit the Strict account cookie.
 * This document carries no credentials and consumes no handoff. Its new
 * same-origin navigation must pass the normal account/session binding checks. */
export function oauthReturnDocument(request: Request): Response | null {
	const url = new URL(request.url);
	const handoff = url.searchParams.get("handoff");
	if (
		request.method !== "GET" ||
		url.pathname !== "/api/ai/oauth/complete" ||
		request.headers.get("sec-fetch-site") !== "cross-site" ||
		url.searchParams.has("opencutReturn") ||
		!handoff ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
			handoff,
		)
	)
		return null;
	const nonce = randomBytes(24).toString("base64url");
	const target = `/api/ai/oauth/complete?handoff=${encodeURIComponent(handoff)}&opencutReturn=1`;
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Returning to OpenCut</title></head><body><p>Finishing sign-in…</p><noscript>Enable JavaScript and return to OpenCut to finish sign-in.</noscript><script nonce="${nonce}">window.location.replace(${JSON.stringify(target)});</script></body></html>`,
		{
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "private, no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
			},
		},
	);
}
