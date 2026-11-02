import { legitateFinish } from "@/accounts/legitate-server";
import {
	localRequestOrigin,
	newSession,
	sessionCookie,
} from "@/accounts/server";
import { LEGITATE_ISSUER } from "@/accounts/legitate-oidc";
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
	} catch {
		return new Response(
			"Legitate sign-in could not be completed. Return to OpenCut and try again.",
			{
				status: 400,
				headers: {
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				},
			},
		);
	}
}
