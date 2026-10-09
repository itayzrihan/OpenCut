import {
	isRenderPerfEnabled,
	incrementCounter,
} from "@/diagnostics/render-perf";
import { publishPerformanceReport } from "@/diagnostics/performance-reports";

type Entry = {
	nextCheck: number;
	pending: boolean;
	url?: string;
	key?: string;
	failed?: boolean;
};
const entries = new Map<string, Entry>();

export function previewProxySource({
	url,
	maxSourceSize,
}: {
	url?: string;
	maxSourceSize?: number;
}): { url: string; key: string } | null {
	if (maxSourceSize === undefined || !url || typeof window === "undefined")
		return null;
	if (
		isRenderPerfEnabled() &&
		new URLSearchParams(window.location.search).get("previewSource") ===
			"original"
	)
		return null;
	let original: URL;
	try {
		original = new URL(url, window.location.origin);
	} catch {
		return null;
	}
	if (
		original.origin !== window.location.origin ||
		original.pathname !== "/api/local-drive/media"
	)
		return null;
	const account = original.searchParams.get("account");
	if (!account || account !== window.__opencutAccountId) return null;
	const requestUrl = new URL(original);
	requestUrl.pathname = "/api/local-drive/preview-proxy";
	const cacheKey = requestUrl.href;
	let entry = entries.get(cacheKey);
	if (!entry) {
		if (entries.size >= 128) return null;
		entry = { nextCheck: 0, pending: false };
		entries.set(cacheKey, entry);
	}
	if (!entry.failed && !entry.pending && Date.now() >= entry.nextCheck) {
		entry.pending = true;
		entry.nextCheck = Date.now() + 5000;
		const current = entry;
		void (async () => {
			try {
				const response = await fetch(requestUrl, {
					cache: "no-store",
					signal: AbortSignal.timeout(5000),
				});
				if (!response.ok) throw new Error("Proxy unavailable");
				let result = await response.json();
				if (result.status === "missing") {
					const created = await fetch(requestUrl, {
						method: "POST",
						signal: AbortSignal.timeout(5000),
					});
					if (!created.ok) throw new Error("Proxy preparation unavailable");
					result = await created.json();
				}
				if (result.status === "ready" && typeof result.key === "string") {
					requestUrl.searchParams.set("content", "1");
					requestUrl.searchParams.set("key", result.key);
					current.url = requestUrl.href;
					current.key = result.key;
					current.nextCheck = Date.now() + 30000;
				} else {
					current.url = undefined;
					current.key = undefined;
				}
				if (result.status === "unavailable") current.failed = true;
				if (isRenderPerfEnabled())
					publishPerformanceReport({
						kind: "proxy",
						data: { status: result.status },
					});
			} catch {
				current.nextCheck = Date.now() + 60000;
			} finally {
				current.pending = false;
			}
		})();
	}
	if (!entry.url || !entry.key || entry.failed) return null;
	incrementCounter({ name: "preview.proxyFramesRequested" });
	return { url: entry.url, key: entry.key };
}

export function rejectPreviewProxy(key: string) {
	for (const entry of entries.values())
		if (entry.key === key) {
			entry.failed = true;
			entry.url = undefined;
		}
}
