import {
	authenticateAccount,
	assertLocalOrigin,
	accountDataLocked,
	loginAccount,
	logoutAccount,
	registerAccount,
	sessionCookie,
} from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { importAccountIdentity } from "@/accounts/identity-transfer";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try {
		const account = await authenticateAccount(request);
		return Response.json(
			{ account, storageBusy: await accountDataLocked(account.id) },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return Response.json(
			{ account: null },
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
}
export async function POST(request: Request) {
	try {
		assertLocalOrigin(request);
		if (!request.headers.get("content-type")?.startsWith("application/json"))
			throw new Error("JSON required");
		const text = new TextDecoder().decode(
			await readBoundedBody(request, 16 * 1024),
		);
		const body = JSON.parse(text);
		if (body.action === "recover" && typeof body.password === "string") {
			const result = await importAccountIdentity(body.recovery, body.password);
			return Response.json(
				{ account: result.account },
				{
					headers: {
						"Set-Cookie": sessionCookie(result.token),
						"Cache-Control": "no-store",
					},
				},
			);
		}
		if (body.action === "logout") {
			await logoutAccount(request);
			return Response.json(
				{ account: null },
				{
					headers: {
						"Set-Cookie": sessionCookie(""),
						"Cache-Control": "no-store",
					},
				},
			);
		}
		if (typeof body.login !== "string" || typeof body.password !== "string")
			throw new Error("Account name and password required");
		const result =
			body.action === "register" && typeof body.displayName === "string"
				? await registerAccount(body.login, body.displayName, body.password)
				: body.action === "login"
					? await loginAccount(body.login, body.password)
					: null;
		if (!result) throw new Error("Unknown account action");
		return Response.json(
			{ account: result.account },
			{
				headers: {
					"Set-Cookie": sessionCookie(result.token),
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		return Response.json(
			{
				error:
					(error as NodeJS.ErrnoException).code === "EEXIST"
						? "That account name already exists"
						: error instanceof Error
							? error.message
							: "Account request failed",
			},
			{ status: 400 },
		);
	}
}
