import type { ClientReviewShare, ClientReviewComment } from "./canonical";
export interface OwnerReview extends ClientReviewShare {
	projectId: string;
	url: string;
	passwordProtected: boolean;
	ready: boolean;
	revoked: boolean;
	expiresAt: number;
	comments: ClientReviewComment[];
	size: number;
	uploadedBytes?: number;
}
export interface PublicReview {
	share: ClientReviewShare;
	comments: ClientReviewComment[];
	expiresAt: number;
}
export async function reviewRequest<T>({
	path,
	init,
}: {
	path: string;
	init?: RequestInit;
}): Promise<T> {
	const owner =
		path.startsWith("/api/client-review/owner") && typeof window !== "undefined"
			? window.__opencutAccountId
			: undefined;
	const response = await fetch(path, {
		cache: "no-store",
		credentials: "same-origin",
		...init,
		headers: {
			...Object.fromEntries(new Headers(init?.headers)),
			...(owner ? { "X-OpenCut-Account": owner } : {}),
		},
	});
	if (owner && window.__opencutAccountId !== owner)
		throw new Error("The active account changed. Reload this workspace.");
	const data = await response.json();
	if (!response.ok)
		throw new Error(
			data.error ||
				(data.locked
					? "Enter the review password"
					: "Could not load the review"),
		);
	return data;
}
export const jsonRequest = ({
	method,
	data,
}: {
	method: string;
	data: unknown;
}): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(data),
});
export function reviewTime(ticks: number) {
	const seconds = Math.max(0, Math.floor(ticks / 120000));
	return `${Math.floor(seconds / 60)
		.toString()
		.padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
