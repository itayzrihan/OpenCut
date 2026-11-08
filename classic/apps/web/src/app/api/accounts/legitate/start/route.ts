import {
	assertLocalOrigin,
	authenticateAccount,
	localRequestOrigin,
} from "@/accounts/server";
import {
	hasLegitateWorkspaceBinding,
	legitateStart,
	LEGITATE_SIGN_IN_TTL_SECONDS,
} from "@/accounts/legitate-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
	try {
		assertLocalOrigin(request);
		const account = await authenticateAccount(request).catch(
			(error: unknown) => {
				const message = error instanceof Error ? error.message : "";
				const reason =
					message === "Sign in to an OpenCut account first"
						? "session_cookie_missing"
						: message === "Session expired. Sign in again"
							? "session_expired"
							: (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
								? "session_file_missing"
								: "session_storage_unavailable";
				console.warn("[legitate] Local session unavailable", {
					reason,
					cookiePresent: /(?:^|;)\s*opencut-account=/.test(
						request.headers.get("cookie") ?? "",
					),
				});
				return null;
			},
		);
		if (!account && !(await hasLegitateWorkspaceBinding()))
			return new Response(
				"Sign in to your OpenCut workspace first, then connect Legitate from Account settings.",
				{
					status: 401,
					headers: {
						"Cache-Control": "no-store",
						"Content-Type": "text/plain; charset=utf-8",
						"Referrer-Policy": "no-referrer",
					},
				},
			);
		const tx = legitateStart(localRequestOrigin(request), account);
		return new Response(null, {
			status: 303,
			headers: {
				Location: tx.url,
				"Set-Cookie": `opencut-legitate=${tx.browser}; HttpOnly; SameSite=Lax; Path=/api/accounts/legitate/callback; Max-Age=${LEGITATE_SIGN_IN_TTL_SECONDS}`,
				"Cache-Control": "no-store",
			},
		});
	} catch {
		return Response.json(
			{ error: "Could not start Legitate sign-in" },
			{ status: 400 },
		);
	}
}
