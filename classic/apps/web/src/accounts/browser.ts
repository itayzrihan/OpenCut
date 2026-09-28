declare global {
	interface Window {
		__opencutAccountId: string | null;
		__opencutActivateAccount: (id: string | null, path?: string) => void;
		__opencutLegacyPreferences: () => Record<string, string>;
	}
}
export function accountNamespace(name: string): string {
	if (typeof window === "undefined") return name;
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in before opening account storage");
	return `opencut-account-${account}-${name}`;
}
export function accountAssetUrl(value: string): string {
	if (typeof window === "undefined" || !window.__opencutAccountId) return value;
	const url = new URL(value, window.location.origin);
	if (url.origin !== window.location.origin) return value;
	url.searchParams.set("account", window.__opencutAccountId);
	return `${url.pathname}${url.search}${url.hash}`;
}
