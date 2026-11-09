import {
	legitateFinish,
	LegitateSignInFailure,
} from "@/accounts/legitate-server";
import {
	localRequestOrigin,
	newSession,
	sessionCookie,
} from "@/accounts/server";
import { LEGITATE_ISSUER } from "@/accounts/legitate-oidc";
import { ACCOUNT_WORKSPACE_HREF } from "@/accounts/workspace-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try {
		const url = new URL(request.url),
			origin = localRequestOrigin(request);
		if (
			(url.searchParams.has("iss") &&
				url.searchParams.get("iss") !== LEGITATE_ISSUER) ||
			["iss", "state", "code"].some(
				(key) => url.searchParams.getAll(key).length > 1,
			)
		)
			throw new Error("Invalid authorization response");
		const browser =
			request.headers
				.get("cookie")
				?.split(";")
				.map((value) => value.trim())
				.find((value) => value.startsWith("opencut-legitate="))
				?.slice("opencut-legitate=".length) || "";
		const account = await legitateFinish({
			state: url.searchParams.get("state") || "",
			code: url.searchParams.get("code") || "",
			browser,
		});
		const session = await newSession(account, "legitate");
		const headers = new Headers({
			Location: `${origin}/projects`,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		});
		headers.append("Set-Cookie", sessionCookie(session.token));
		headers.append(
			"Set-Cookie",
			"opencut-legitate=; HttpOnly; SameSite=Lax; Path=/api/accounts/legitate/callback; Max-Age=0",
		);
		return new Response(null, { status: 303, headers });
	} catch (error) {
		const expired =
			error instanceof Error &&
			["Legitate sign-in expired", "Incomplete Legitate response"].includes(
				error.message,
			);
		// Never log callback URLs, authorization codes, cookies or identity tokens.
		console.warn("[legitate] Callback rejected", {
			reason: expired ? "expired_request" : "verification_failed",
			...(error instanceof LegitateSignInFailure
				? error.diagnostics
				: { stage: "local_session" }),
		});
		const message = expired
			? "This sign-in link expired. Start again from POCUT in this browser."
			: "Legitate sign-in could not be completed. Start a new sign-in from your POCUT workspace.";
		return new Response(
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to POCUT</title><body style="background:#111;color:#eee;font:16px system-ui;padding:48px;max-width:640px;margin:auto"><h1>Return to POCUT</h1><p>${message}</p><p><a style="color:#b9a5ff" href="${ACCOUNT_WORKSPACE_HREF}">Open account settings and try again</a></p></body></html>`,
			{
				status: 400,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				},
			},
		);
	}
}
