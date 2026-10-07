import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import type { ChatGPTConnection } from "./chatgpt-vault";

export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const issuer = "https://auth.openai.com";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const tokenSchema = z.object({
	access_token: z.string().min(1).max(64_000),
	refresh_token: z.string().min(1).max(64_000).optional(),
	id_token: z.string().min(1).max(64_000).optional(),
	expires_in: z.number().int().positive().max(31_536_000),
	scope: z.string().max(4000).optional(),
	token_type: z.string().optional(),
});

export interface SignInAttempt {
	state: string;
	nonce: string;
	verifier: string;
	redirectUri: string;
	clientId: string;
	hostId: string;
	expiresAt: number;
	expectedSubject?: string;
}

export function prepareSignIn({
	hostId,
	redirectUri,
	saved,
}: {
	hostId: string;
	redirectUri: string;
	saved: ChatGPTConnection;
}): { attempt: SignInAttempt; url: string } {
	const callback = new URL(redirectUri);
	if (
		callback.protocol !== "http:" ||
		callback.hostname !== "127.0.0.1" ||
		callback.pathname !== "/auth/callback" ||
		callback.search ||
		callback.hash
	)
		throw new Error(
			"Local ChatGPT sign-in requires its exact IPv4 loopback callback",
		);
	const attempt: SignInAttempt = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		verifier: randomBytes(48).toString("base64url"),
		redirectUri,
		clientId: saved.clientId ?? "dynamic_agent_client",
		hostId,
		expiresAt: Date.now() + 10 * 60_000,
		expectedSubject: saved.subject,
	};
	const url = new URL(`${issuer}/api/accounts/authorize`);
	url.search = new URLSearchParams({
		client_id: attempt.clientId,
		ext_agent_host_id: hostId,
		...(saved.clientId ? {} : { agent_name_hint: "OpenCut" }),
		response_type: "code",
		redirect_uri: redirectUri,
		scope:
			"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		resource: CHATGPT_RESOURCE,
		state: attempt.state,
		nonce: attempt.nonce,
		code_challenge_method: "S256",
		code_challenge: createHash("sha256")
			.update(attempt.verifier)
			.digest("base64url"),
	}).toString();
	return { attempt, url: url.toString() };
}

export function validateCallback({
	attempt,
	callback,
	now = Date.now(),
}: {
	attempt: SignInAttempt;
	callback: URL;
	now?: number;
}): { clientId: string; code: string } {
	if (
		attempt.expiresAt <= now ||
		callback.searchParams.get("state") !== attempt.state
	)
		throw new Error("ChatGPT sign-in expired or could not be verified");
	if (callback.searchParams.has("error"))
		throw new Error("ChatGPT sign-in was declined");
	const code = callback.searchParams.get("code");
	const issued = callback.searchParams.get("client_id");
	const clientId = issued ?? attempt.clientId;
	if (
		!code ||
		code.length > 16_000 ||
		!/^[A-Za-z0-9_-]{1,256}$/.test(clientId) ||
		clientId === "dynamic_agent_client"
	)
		throw new Error("ChatGPT registration was not completed");
	if (
		attempt.clientId !== "dynamic_agent_client" &&
		clientId !== attempt.clientId
	)
		throw new Error("ChatGPT returned a different registration");
	return { clientId, code };
}

export async function verifyIdentity({
	idToken,
	clientId,
	nonce,
	expectedSubject,
	receivedAt,
}: {
	idToken: string;
	clientId: string;
	nonce?: string;
	expectedSubject?: string;
	receivedAt?: number;
}): Promise<JWTPayload> {
	const { payload } = await jwtVerify(idToken, jwks, {
		issuer,
		audience: clientId,
		requiredClaims: ["sub", "exp", "iat"],
		clockTolerance: 5,
		...(receivedAt ? { currentDate: new Date(receivedAt) } : {}),
	});
	if (
		!payload.sub ||
		(nonce !== undefined && payload.nonce !== nonce) ||
		(expectedSubject && payload.sub !== expectedSubject)
	)
		throw new Error("ChatGPT account identity could not be verified");
	return payload;
}

export async function requestChatGPTTokens({
	params,
	signal,
}: {
	params: URLSearchParams;
	signal?: AbortSignal;
}) {
	const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: params,
		signal: signal ?? AbortSignal.timeout(60_000),
	});
	if (!response.ok)
		throw new Error(
			`ChatGPT connection could not be renewed (${response.status}); sign in again`,
		);
	const data = tokenSchema.parse(await response.json());
	if (data.token_type && data.token_type.toLowerCase() !== "bearer")
		throw new Error("ChatGPT returned an unsupported token type");
	return data;
}
