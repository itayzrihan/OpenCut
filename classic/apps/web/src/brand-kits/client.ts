import type { BrandKitLibrary } from "./types";
export async function brandKitRequest({
	edit,
	signal,
}: {
	edit?: { expectedRevision: number; requestId: string; change: unknown };
	signal?: AbortSignal;
} = {}): Promise<BrandKitLibrary> {
	const accountId = window.__opencutAccountId;
	if (!accountId) throw new Error("Sign in before opening Brand Kits");
	const response = await fetch("/api/brand-kits", {
		cache: "no-store",
		signal,
		...(edit ? { method: "POST", body: JSON.stringify(edit) } : {}),
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": accountId,
		},
	});
	const data = await response.json();
	if (window.__opencutAccountId !== accountId)
		throw new Error("Brand Kit account changed");
	if (!response.ok) throw new Error(data.error ?? "Could not load Brand Kits");
	return data;
}
