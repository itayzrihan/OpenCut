import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAccount } from "@/accounts/server";
import {
	getSessionBinding,
	normalizeTokenResponse,
	setCredentialsCookie,
	setOAuthBindingCookie,
	type OpenAICodexCredentials,
} from "./openai-codex-oauth";
import {
	createDeviceLoginProcess,
	type DeviceLoginProcess,
} from "./device-login-process";

interface Attempt {
	account: string;
	session: string;
	expires: number;
	process?: DeviceLoginProcess;
	start?: { verificationUrl: string; userCode: string };
	credentials?: OpenAICodexCredentials;
	error?: string;
}
const host = globalThis as typeof globalThis & {
	__opencutDeviceLogins?: Map<string, Attempt>;
	__opencutDeviceLoginStarts?: Map<string, { count: number; until: number }>;
};
const attempts = (host.__opencutDeviceLogins ??= new Map<string, Attempt>());
const starts = (host.__opencutDeviceLoginStarts ??= new Map<
	string,
	{ count: number; until: number }
>());
const cookieName = "opencut_openai_oauth_binding";

function appSession(request: NextRequest) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				requireAccount().id,
				request.cookies.get("opencut-account")?.value,
			]),
		)
		.digest("hex");
}

export async function cancelDeviceLogin(request: NextRequest) {
	// A user can close the dialog before the start response has delivered its
	// binding cookie. Cancellation still targets only their exact app session.
	const session = appSession(request);
	for (const [key, attempt] of attempts) {
		if (attempt.account !== requireAccount().id || attempt.session !== session)
			continue;
		attempts.delete(key);
		await attempt.process?.close();
	}
}

export async function handleDeviceLogin(
	request: NextRequest,
	createProcess: () => Promise<DeviceLoginProcess> = createDeviceLoginProcess,
) {
	const account = requireAccount().id;
	// A custom account header plus same-origin checks prevent login CSRF, even
	// on direct loopback access. No caller can select a different account/home.
	if (request.headers.get("X-OpenCut-Account") !== account)
		return NextResponse.json(
			{ error: "Reload your OpenCut account before signing in." },
			{ status: 403 },
		);
	if (Number(request.headers.get("content-length")) > 1000)
		return NextResponse.json({ error: "Request too large" }, { status: 413 });
	const raw = await request.text();
	if (raw.length > 1000)
		return NextResponse.json({ error: "Request too large" }, { status: 413 });
	let action: unknown;
	try {
		action = JSON.parse(raw).action;
	} catch {
		/* rejected below */
	}
	if (!["start", "poll", "cancel"].includes(action as string))
		return NextResponse.json(
			{ error: "Invalid login action" },
			{ status: 400 },
		);
	for (const [key, attempt] of attempts)
		if (attempt.expires <= Date.now()) {
			attempts.delete(key);
			void attempt.process?.close().catch(() => {});
		}
	if (action === "cancel") {
		await cancelDeviceLogin(request);
		return NextResponse.json({ cancelled: true });
	}
	if (action === "start" && !request.cookies.get(cookieName)?.value)
		request.cookies.set(cookieName, randomUUID());
	const binding = getSessionBinding({ request });
	if (!binding)
		return NextResponse.json(
			{ error: "Sign-in expired. Start again." },
			{ status: 410 },
		);
	let attempt = attempts.get(binding);
	if (attempt && attempt.account !== account)
		return NextResponse.json(
			{ error: "Sign-in expired. Start again." },
			{ status: 410 },
		);
	if (action === "poll") {
		if (!attempt)
			return NextResponse.json(
				{ error: "Sign-in expired. Start again." },
				{ status: 410 },
			);
		if (attempt.error) {
			attempts.delete(binding);
			return NextResponse.json({ error: attempt.error }, { status: 502 });
		}
		if (!attempt.credentials) return NextResponse.json({ pending: true });
		const response = NextResponse.json({ authenticated: true });
		setCredentialsCookie({ response, credentials: attempt.credentials });
		attempts.delete(binding);
		return response;
	}
	if (attempt?.error) {
		attempts.delete(binding);
		attempt = undefined;
	}
	if (!attempt) {
		for (const [key, value] of starts)
			if (value.until <= Date.now()) starts.delete(key);
		const rate = starts.get(account) ?? {
			count: 0,
			until: Date.now() + 60_000,
		};
		if (rate.count >= 6)
			return NextResponse.json(
				{ error: "Too many sign-in attempts. Wait a minute and try again." },
				{ status: 429 },
			);
		rate.count++;
		starts.set(account, rate);
		if (
			attempts.size >= 8 ||
			[...attempts.values()].filter((a) => a.account === account).length >= 2
		)
			return NextResponse.json(
				{
					error:
						"A sign-in is already pending. Finish it or try again in a few minutes.",
				},
				{ status: 429 },
			);
		attempt = {
			account,
			session: appSession(request),
			expires: Date.now() + 10 * 60_000,
		};
		attempts.set(binding, attempt); // Reserve before awaiting startup.
		const current = attempt;
		try {
			current.process = await createProcess();
			void current.process.completed
				.then((tokens) => {
					if (attempts.get(binding) !== current) return;
					const payload = JSON.parse(
						Buffer.from(
							String(tokens.access_token).split(".")[1],
							"base64url",
						).toString(),
					);
					const expiresIn = Number(payload.exp) - Date.now() / 1000;
					if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw Error();
					current.credentials = normalizeTokenResponse({
						json: { ...tokens, expires_in: expiresIn },
						sessionBinding: binding,
					});
				})
				.catch(() => {
					current.error =
						"OpenAI sign-in failed or expired. Enable device-code login in ChatGPT Settings → Security, then try again.";
				});
			current.start = await current.process.start;
		} catch {
			attempts.delete(binding);
			await current.process?.close();
			return NextResponse.json(
				{ error: "Could not start OpenAI sign-in. Try again shortly." },
				{ status: 503 },
			);
		}
	}
	if (!attempt.start)
		return NextResponse.json(
			{ error: "Sign-in is starting. Try again shortly." },
			{ status: 409 },
		);
	const response = NextResponse.json({
		...attempt.start,
		expiresAt: attempt.expires,
	});
	setOAuthBindingCookie({
		response,
		value: request.cookies.get(cookieName)!.value,
	});
	return response;
}
