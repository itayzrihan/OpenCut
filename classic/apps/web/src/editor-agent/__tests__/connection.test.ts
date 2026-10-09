import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSignIn, validateCallback } from "../server/chatgpt-oauth";
import { ChatGPTVault } from "../server/chatgpt-vault";

describe("new ChatGPT connection", () => {
	it("binds fresh state, nonce, PKCE, issued client and exact loopback callback", () => {
		const config = {
			hostId: "urn:uuid:test-host",
			redirectUri: "http://127.0.0.1:53100/auth/callback",
			saved: { version: 1 as const, scopes: [] },
		};
		const first = prepareSignIn(config),
			second = prepareSignIn(config);
		const url = new URL(first.url);
		expect(url.origin).toBe("https://auth.openai.com");
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(first.attempt.verifier).digest("base64url"),
		);
		expect(first.attempt.state).not.toBe(second.attempt.state);
		expect(first.attempt.nonce).not.toBe(second.attempt.nonce);
		const callback = new URL(config.redirectUri);
		callback.search = new URLSearchParams({
			state: first.attempt.state,
			code: "authorization-code",
			client_id: "issued-client",
		}).toString();
		expect(validateCallback({ attempt: first.attempt, callback })).toEqual({
			code: "authorization-code",
			clientId: "issued-client",
		});
		expect(() =>
			validateCallback({ attempt: second.attempt, callback }),
		).toThrow("verified");
		expect(() =>
			validateCallback({
				attempt: first.attempt,
				callback,
				now: first.attempt.expiresAt,
			}),
		).toThrow("expired");
		callback.searchParams.delete("client_id");
		expect(() =>
			validateCallback({ attempt: first.attempt, callback }),
		).toThrow("registration");
		expect(() =>
			prepareSignIn({
				...config,
				redirectUri: "http://localhost:53100/auth/callback",
			}),
		).toThrow("loopback");
	});
	it("does not accept another registration when reconnecting", () => {
		const { attempt } = prepareSignIn({
			hostId: "urn:uuid:test",
			redirectUri: "http://127.0.0.1:5000/auth/callback",
			saved: {
				version: 1,
				scopes: [],
				clientId: "registered",
				subject: "subject-a",
			},
		});
		const callback = new URL(attempt.redirectUri);
		callback.search = new URLSearchParams({
			state: attempt.state,
			code: "code",
			client_id: "other-client",
		}).toString();
		expect(() => validateCallback({ attempt, callback })).toThrow(
			"different registration",
		);
		expect(attempt.expectedSubject).toBe("subject-a");
	});
	it("encrypts account-bound records and serializes concurrent credential updates", async () => {
		const root = await mkdtemp(join(tmpdir(), "opencut-agent-vault-test-"));
		try {
			const key = randomBytes(32);
			const store = new ChatGPTVault({
				directory: root,
				accountId: "alice",
				key,
			});
			await store.locked((vault) =>
				vault.write({
					version: 1,
					scopes: [],
					accessToken: "secret-access-token",
					refreshToken: "secret-refresh-token",
				}),
			);
			const bytes = await readFile(join(root, "connection.enc"));
			expect(bytes.includes(Buffer.from("secret"))).toBe(false);
			const other = new ChatGPTVault({
				directory: root,
				accountId: "bob",
				key,
			});
			await expect(other.locked((vault) => vault.read())).rejects.toThrow();
			await Promise.all(
				Array.from({ length: 6 }, (_, i) =>
					store.locked(async (vault) => {
						const value = await vault.read();
						value.scopes.push(`scope-${i}`);
						await vault.write(value);
					}),
				),
			);
			const result = await store.locked((vault) => vault.read());
			expect(new Set(result.scopes).size).toBe(6);
			expect(result.refreshToken).toBe("secret-refresh-token");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
