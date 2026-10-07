import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	accountsRoot,
	accountDataRoot,
	requireAccount,
} from "@/accounts/server";
import { hostCookieSecret } from "@/accounts/host-key";
import { ChatGPTVault, type ChatGPTConnection } from "./chatgpt-vault";
import {
	CHATGPT_RESOURCE,
	prepareSignIn,
	requestChatGPTTokens,
	validateCallback,
	verifyIdentity,
	type SignInAttempt,
} from "./chatgpt-oauth";

interface ConnectionRuntime {
	version: number;
	server?: Server;
	error?: string;
	requests: Set<AbortController>;
}
const globalHost = globalThis as typeof globalThis & {
	__opencutChatGPTConnections?: Map<string, ConnectionRuntime>;
};
const connections = (globalHost.__opencutChatGPTConnections ??= new Map<
	string,
	ConnectionRuntime
>());

function runtimeFor(accountId: string) {
	let runtime = connections.get(accountId);
	if (!runtime) {
		runtime = { version: 0, requests: new Set() };
		connections.set(accountId, runtime);
	}
	return runtime;
}
function vaultForAccount() {
	return new ChatGPTVault({
		directory: join(accountDataRoot(), "editor-agent", "chatgpt"),
		accountId: requireAccount().id,
		key: hostCookieSecret(),
	});
}
function safeStatus({
	saved,
	runtime,
}: {
	saved: ChatGPTConnection;
	runtime: ConnectionRuntime;
}) {
	return {
		connected: Boolean(saved.accessToken && saved.subject),
		sharing: Boolean(
			saved.accessToken &&
			saved.scopes.includes("chatgpt.tokens.use.direct") &&
			saved.scopes.includes("resource.invoke"),
		),
		connecting: Boolean(runtime.server),
		identity: saved.subject ? { name: saved.name, email: saved.email } : null,
		error: runtime.error ?? null,
		usageUrl: "https://chatgpt.com/settings/usage",
	};
}

async function hostId() {
	const root = accountsRoot();
	await mkdir(root, { recursive: true, mode: 0o700 });
	const file = join(root, "editor-agent-host-id");
	try {
		await writeFile(file, `urn:uuid:${randomUUID()}`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
	const id = (await readFile(file, "utf8")).trim();
	if (!/^urn:uuid:[a-f0-9-]{36}$/.test(id))
		throw new Error("ChatGPT host registration is invalid");
	return id;
}

export async function chatGPTStatus() {
	const runtime = runtimeFor(requireAccount().id);
	return vaultForAccount().locked(async (store) =>
		safeStatus({ saved: await store.read(), runtime }),
	);
}

/** Own implementation of the documented OAuth flow. No DevKit source is
 * distributed: its noncommercial package is not a SaaS dependency. */
export async function startChatGPTSignIn() {
	const runtime = runtimeFor(requireAccount().id);
	if (runtime.server) throw new Error("ChatGPT sign-in is already in progress");
	const vault = vaultForAccount();
	const saved = await vault.locked((store) => store.read());
	const installation = await hostId();
	const version = ++runtime.version;
	for (const request of runtime.requests) request.abort();
	runtime.error = undefined;
	const callbackState: { attempt?: SignInAttempt } = {};
	let consumed = false;
	const server = createServer((request, response) => {
		const attempt = callbackState.attempt;
		const callback = new URL(request.url ?? "/", "http://127.0.0.1");
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; frame-ancestors 'none'",
		);
		if (
			request.method !== "GET" ||
			callback.pathname !== "/auth/callback" ||
			!attempt ||
			consumed ||
			callback.searchParams.get("state") !== attempt.state
		) {
			response.writeHead(400).end("This sign-in attempt is unavailable.");
			return;
		}
		consumed = true;
		const pending = attempt;
		void (async () => {
			try {
				const { clientId, code } = validateCallback({
					attempt: pending,
					callback,
				});
				await vault.locked(async (store) => {
					if (runtime.version !== version)
						throw new Error("Sign-in was cancelled");
					const current = await store.read();
					if (
						current.clientId !== saved.clientId ||
						current.subject !== saved.subject
					)
						throw new Error("The selected ChatGPT connection changed");
					// Keep the issued registration even when code exchange expires.
					await store.write({ ...current, clientId });
					const tokens = await requestChatGPTTokens({
						params: new URLSearchParams({
							grant_type: "authorization_code",
							client_id: clientId,
							code,
							code_verifier: pending.verifier,
							redirect_uri: pending.redirectUri,
							resource: CHATGPT_RESOURCE,
						}),
					});
					if (!tokens.id_token)
						throw new Error("ChatGPT did not return a verified identity");
					const identity = await verifyIdentity({
						idToken: tokens.id_token,
						clientId,
						nonce: pending.nonce,
						expectedSubject: pending.expectedSubject,
					});
					if (runtime.version !== version)
						throw new Error("Sign-in was cancelled");
					await store.write({
						version: 1,
						clientId,
						subject: identity.sub,
						name: typeof identity.name === "string" ? identity.name : undefined,
						email:
							typeof identity.email === "string" ? identity.email : undefined,
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token,
						idToken: tokens.id_token,
						expiresAt: Date.now() + tokens.expires_in * 1000,
						scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
					});
				});
				response.end(
					"ChatGPT is connected. Return to OpenCut to continue editing.",
				);
			} catch (error) {
				runtime.error =
					error instanceof Error ? error.message : "ChatGPT sign-in failed";
				response
					.writeHead(400)
					.end(
						"ChatGPT sign-in could not be completed. Return to OpenCut and try again.",
					);
			} finally {
				clearTimeout(timer);
				server.close();
				if (runtime.server === server) runtime.server = undefined;
			}
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not start the ChatGPT callback");
	}
	const prepared = prepareSignIn({
		hostId: installation,
		redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
		saved,
	});
	const attempt = prepared.attempt;
	callbackState.attempt = attempt;
	runtime.server = server;
	const timer = setTimeout(() => {
		server.close();
		if (runtime.server === server) {
			runtime.server = undefined;
			runtime.error = "ChatGPT sign-in expired. Try again.";
		}
	}, 10 * 60_000);
	timer.unref();
	return { authorizationUrl: prepared.url, expiresAt: attempt.expiresAt };
}

async function withAccess<T>({
	operation,
	signal,
}: {
	operation: (access: string, signal: AbortSignal) => Promise<T>;
	signal?: AbortSignal;
}): Promise<T> {
	const runtime = runtimeFor(requireAccount().id);
	const version = runtime.version;
	const controller = new AbortController();
	runtime.requests.add(controller);
	const combined = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	try {
		const access = await vaultForAccount().locked(async (store) => {
			let saved = await store.read();
			if (!saved.clientId || !saved.subject || !saved.accessToken)
				throw new Error("Continue with ChatGPT before using the editor agent");
			if (
				!saved.scopes.includes("chatgpt.tokens.use.direct") ||
				!saved.scopes.includes("resource.invoke")
			)
				throw new Error(
					"ChatGPT plan usage is not enabled for this connection",
				);
			if (
				saved.pendingRefresh ||
				(saved.expiresAt ?? 0) <= Date.now() + 60_000
			) {
				if (!saved.pendingRefresh) {
					if (!saved.refreshToken)
						throw new Error("ChatGPT connection expired. Sign in again");
					const tokens = await requestChatGPTTokens({
						params: new URLSearchParams({
							grant_type: "refresh_token",
							client_id: saved.clientId,
							refresh_token: saved.refreshToken,
							resource: CHATGPT_RESOURCE,
						}),
					});
					saved.pendingRefresh = {
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token ?? saved.refreshToken,
						idToken: tokens.id_token,
						expiresAt: Date.now() + tokens.expires_in * 1000,
						scopes:
							tokens.scope === undefined
								? saved.scopes
								: tokens.scope.split(/\s+/).filter(Boolean),
						receivedAt: Date.now(),
					};
					await store.write(saved);
				}
				const rotation = saved.pendingRefresh;
				if (rotation.idToken)
					await verifyIdentity({
						idToken: rotation.idToken,
						clientId: saved.clientId,
						expectedSubject: saved.subject,
						receivedAt: rotation.receivedAt,
					});
				saved = {
					...saved,
					accessToken: rotation.accessToken,
					refreshToken: rotation.refreshToken,
					idToken: rotation.idToken ?? saved.idToken,
					expiresAt: rotation.expiresAt,
					scopes: rotation.scopes,
					pendingRefresh: undefined,
				};
				await store.write(saved);
			}
			if (
				!saved.scopes.includes("chatgpt.tokens.use.direct") ||
				!saved.scopes.includes("resource.invoke")
			)
				throw new Error("ChatGPT plan usage was revoked");
			return saved.accessToken!;
		});
		combined.throwIfAborted();
		if (runtime.version !== version)
			throw new Error("ChatGPT connection changed");
		return await operation(access, combined);
	} finally {
		runtime.requests.delete(controller);
	}
}

export async function chatGPTModels(signal?: AbortSignal) {
	return withAccess({
		signal,
		operation: async (access, signal) => {
			const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
				headers: { Authorization: `Bearer ${access}` },
				signal,
			});
			if (!response.ok)
				throw new Error(`ChatGPT model discovery failed (${response.status})`);
			const body: unknown = await response.json();
			if (
				!body ||
				typeof body !== "object" ||
				!("models" in body) ||
				!Array.isArray(body.models)
			)
				throw new Error("ChatGPT returned an invalid model catalog");
			return body.models.flatMap((value: unknown) => {
				if (
					!value ||
					typeof value !== "object" ||
					!("slug" in value) ||
					typeof value.slug !== "string" ||
					!("visibility" in value) ||
					value.visibility !== "list"
				)
					return [];
				return [
					{
						id: value.slug,
						name:
							"display_name" in value && typeof value.display_name === "string"
								? value.display_name
								: value.slug,
					},
				];
			});
		},
	});
}

export async function streamChatGPTResponse({
	body,
	signal,
}: {
	body: Record<string, unknown>;
	signal: AbortSignal;
}): Promise<Response> {
	const runtime = runtimeFor(requireAccount().id);
	const lifecycle = new AbortController();
	runtime.requests.add(lifecycle);
	const cleanup = () => runtime.requests.delete(lifecycle);
	try {
		return await withAccess({
			signal: AbortSignal.any([signal, lifecycle.signal]),
			operation: async (access, signal) => {
				const upstream = await fetch(`${CHATGPT_RESOURCE}/responses`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${access}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({ ...body, store: false, stream: true }),
					signal,
				});
				if (!upstream.ok) {
					await upstream.body?.cancel();
					throw new Error(
						`ChatGPT request failed (${upstream.status}). Check your connection and ChatGPT plan usage.`,
					);
				}
				if (!upstream.body) throw new Error("ChatGPT returned an empty stream");
				const reader = upstream.body.getReader();
				const stream = new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							const chunk = await reader.read();
							if (chunk.done) {
								cleanup();
								controller.close();
							} else controller.enqueue(chunk.value);
						} catch (error) {
							cleanup();
							controller.error(error);
						}
					},
					async cancel(reason) {
						lifecycle.abort();
						cleanup();
						await reader.cancel(reason);
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-store",
						"X-Accel-Buffering": "no",
					},
				});
			},
		});
	} catch (error) {
		cleanup();
		throw error;
	}
}

export async function disconnectChatGPT() {
	const runtime = runtimeFor(requireAccount().id);
	++runtime.version;
	runtime.server?.close();
	runtime.server = undefined;
	for (const request of runtime.requests) request.abort();
	let revocationConfirmed = true;
	await vaultForAccount().locked(async (store) => {
		const saved = await store.read();
		if (saved.refreshToken && saved.clientId) {
			try {
				const discovery = await fetch(
					"https://auth.openai.com/.well-known/openid-configuration",
					{ signal: AbortSignal.timeout(15_000) },
				).then((r) => r.json());
				const endpoint = new URL(discovery.revocation_endpoint);
				if (endpoint.origin !== "https://auth.openai.com")
					throw new Error("Invalid revocation endpoint");
				const result = await fetch(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						token: saved.refreshToken,
						token_type_hint: "refresh_token",
						client_id: saved.clientId,
					}),
					signal: AbortSignal.timeout(15_000),
				});
				revocationConfirmed = result.ok;
			} catch {
				revocationConfirmed = false;
			}
		}
		await store.write({
			version: 1,
			clientId: saved.clientId,
			subject: saved.subject,
			email: saved.email,
			name: saved.name,
			scopes: [],
		});
	});
	runtime.error = revocationConfirmed
		? undefined
		: "Signed out locally; remote revocation was not confirmed. You can disconnect OpenCut in ChatGPT Settings.";
	return { revocationConfirmed };
}
