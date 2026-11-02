import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import {
	createLegitateAuthorization,
	LEGITATE_ISSUER,
	matchesLegitateState,
	verifyLegitateIdToken,
} from "./legitate-oidc";

describe("Legitate OIDC", () => {
	test("binds a random PKCE challenge and nonce to an exact loopback callback", () => {
		const tx = createLegitateAuthorization({
			clientId: "opencut",
			redirectUri: "http://localhost:3000/api/accounts/legitate/callback",
		});
		const url = new URL(tx.url);
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(tx.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("state")).toBe(tx.state);
		expect(url.searchParams.get("nonce")).toBe(tx.nonce);
		expect(matchesLegitateState(tx.state, tx.state)).toBe(true);
		expect(matchesLegitateState(tx.state, tx.state + "x")).toBe(false);
		expect(() =>
			createLegitateAuthorization({
				clientId: "opencut",
				redirectUri: "https://example.com/api/accounts/legitate/callback",
			}),
		).toThrow();
	});
	test("accepts only a signed, unexpired token for the issuer, client and nonce", async () => {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		async function token(
			issuer = LEGITATE_ISSUER,
			audience = "opencut",
			nonce = "expected",
			expiry = "5m",
		) {
			return new SignJWT({ nonce })
				.setProtectedHeader({ alg: "RS256" })
				.setIssuer(issuer)
				.setAudience(audience)
				.setSubject("opaque-subject")
				.setIssuedAt()
				.setExpirationTime(expiry)
				.sign(privateKey);
		}
		const verify = (value: string) =>
			verifyLegitateIdToken({
				token: value,
				clientId: "opencut",
				nonce: "expected",
				key: publicKey,
			});
		expect((await verify(await token())).subject).toBe("opaque-subject");
		await expect(
			verify(await token("https://elsewhere.example")),
		).rejects.toThrow();
		await expect(
			verify(await token(LEGITATE_ISSUER, "other")),
		).rejects.toThrow();
		await expect(
			verify(await token(LEGITATE_ISSUER, "opencut", "wrong")),
		).rejects.toThrow();
		await expect(
			verify(await token(LEGITATE_ISSUER, "opencut", "expected", "-1m")),
		).rejects.toThrow();
	});
});
