/** AI credentials live on this device; never fall back to the hosting server. */
const COMPANION = "http://127.0.0.1:43127";
export interface ClientAiPairing {
	version: 1;
	origin: string;
	accountId: string;
	token: string;
}
const key = (id: string) => `opencut-client-ai:${id}`;
export function isRemoteAiClient() {
	return (
		typeof window !== "undefined" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
	);
}
export function readClientAiPairing(): ClientAiPairing | null {
	const id = window.__opencutAccountId;
	if (!id) return null;
	try {
		const pair = JSON.parse(sessionStorage.getItem(key(id)) || "null");
		return pair?.version === 1 &&
			pair.accountId === id &&
			pair.origin === window.location.origin &&
			/^[a-f0-9]{64}$/.test(pair.token)
			? pair
			: null;
	} catch {
		return null;
	}
}
export function prepareClientAiPairing(): ClientAiPairing {
	const id = window.__opencutAccountId;
	if (!id) throw new Error("Sign in to OpenCut first");
	const pair = readClientAiPairing() || {
		version: 1 as const,
		accountId: id,
		origin: window.location.origin,
		token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
			n.toString(16).padStart(2, "0"),
		).join(""),
	};
	sessionStorage.setItem(key(id), JSON.stringify(pair));
	return pair;
}
export function forgetClientAiPairing() {
	const id = window.__opencutAccountId;
	if (id) sessionStorage.removeItem(key(id));
}
export async function aiClientFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!/^\/api\/ai\/(chat|models|oauth\/(status|start|logout))$/.test(path))
		throw new Error("Unsupported AI operation");
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in to OpenCut first");
	if (!isRemoteAiClient())
		return fetch(path, {
			...init,
			headers: {
				...Object.fromEntries(new Headers(init.headers)),
				"X-OpenCut-Account": account,
			},
		});
	const pair = readClientAiPairing();
	if (!pair)
		throw new Error(
			"Connect OpenCut AI on this device. Your OpenAI login stays on your computer.",
		);
	const controller = new AbortController();
	const changed = () => {
		if (window.__opencutAccountId !== account) controller.abort();
	};
	const leaving = () => controller.abort();
	window.addEventListener("storage", changed);
	window.addEventListener("pagehide", leaving, { once: true });
	try {
		const response = await fetch(COMPANION + path, {
			...init,
			credentials: "omit",
			cache: "no-store",
			signal: init.signal
				? AbortSignal.any([init.signal, controller.signal])
				: controller.signal,
			headers: {
				...Object.fromEntries(new Headers(init.headers)),
				Authorization: `Bearer ${pair.token}`,
				"X-OpenCut-Account": account,
			},
		});
		const body = await response.arrayBuffer();
		if (window.__opencutAccountId !== account)
			throw new Error(
				"Account changed. Discarded the previous account's AI response.",
			);
		return new Response(body, {
			status: response.status,
			headers: response.headers,
		});
	} catch (error) {
		if (error instanceof TypeError)
			throw new Error(
				"OpenCut AI is not reachable on this device. Start the local app and allow local-network access if your browser asks.",
			);
		throw error;
	} finally {
		window.removeEventListener("storage", changed);
		window.removeEventListener("pagehide", leaving);
	}
}
