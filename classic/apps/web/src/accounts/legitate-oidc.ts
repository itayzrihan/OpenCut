/** Protocol primitives for Legitate sign-in. The host owns transaction and session storage. */
import {
	createHash,
	randomBytes,
	timingSafeEqual,
	type KeyObject,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const LEGITATE_ISSUER = "https://auth.legitate.com";
const AUTHORIZATION_ENDPOINT = `${LEGITATE_ISSUER}/api/oidc/authorization`;
const JWKS = createRemoteJWKSet(new URL(`${LEGITATE_ISSUER}/jwks.json`));

function randomValue() {
	return randomBytes(32).toString("base64url");
}

/** Caller must persist these values as a short-lived, one-use browser-bound transaction. */
export function createLegitateAuthorization({
	clientId,
	redirectUri,
}: {
	clientId: string;
	redirectUri: string;
}) {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId))
		throw new Error("Invalid Legitate client ID");
	const callback = new URL(redirectUri);
	if (
		callback.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
		callback.username ||
		callback.password ||
		callback.search ||
		callback.hash ||
		callback.pathname !== "/api/accounts/legitate/callback"
	)
		throw new Error("Invalid local Legitate callback");
	const state = randomValue(),
		nonce = randomValue(),
		verifier = randomValue();
	const url = new URL(AUTHORIZATION_ENDPOINT);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: callback.href,
		scope: "openid profile",
		state,
		nonce,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return { url: url.href, state, nonce, verifier };
}

export function matchesLegitateState(expected: string, actual: string) {
	const left = Buffer.from(expected),
		right = Buffer.from(actual);
	return (
		left.length > 0 &&
		left.length === right.length &&
		timingSafeEqual(left, right)
	);
}

/** Verify issuer, audience, signature, expiry and transaction nonce before using a subject. */
export async function verifyLegitateIdToken({
	token,
	clientId,
	nonce,
	key = JWKS,
}: {
	token: string;
	clientId: string;
	nonce: string;
	key?: typeof JWKS | CryptoKey | KeyObject;
}) {
	const options = {
		issuer: LEGITATE_ISSUER,
		audience: clientId,
		algorithms: ["RS256", "ES256", "PS256"],
		requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
		maxTokenAge: "5 minutes",
		clockTolerance: 30,
	};
	const { payload } =
		typeof key === "function"
			? await jwtVerify(token, key, options)
			: await jwtVerify(token, key, options);
	if (
		typeof payload.sub !== "string" ||
		!payload.sub ||
		payload.nonce !== nonce
	)
		throw new Error("Invalid Legitate identity token");
	if (
		(payload.azp !== undefined && payload.azp !== clientId) ||
		(Array.isArray(payload.aud) &&
			payload.aud.length > 1 &&
			payload.azp !== clientId)
	)
		throw new Error("Invalid Legitate authorized party");
	return { issuer: LEGITATE_ISSUER, subject: payload.sub };
}
