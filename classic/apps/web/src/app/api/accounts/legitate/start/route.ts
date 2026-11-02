import {
	assertLocalOrigin,
	authenticateAccount,
	localRequestOrigin,
} from "@/accounts/server";
import { legitateStart } from "@/accounts/legitate-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
	try {
		assertLocalOrigin(request);
		const account = await authenticateAccount(request).catch(() => null);
		const tx = legitateStart(localRequestOrigin(request), account);
		return new Response(null, {
			status: 303,
			headers: {
				Location: tx.url,
				"Set-Cookie": `opencut-legitate=${tx.browser}; HttpOnly; SameSite=Lax; Path=/api/accounts/legitate/callback; Max-Age=300`,
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
