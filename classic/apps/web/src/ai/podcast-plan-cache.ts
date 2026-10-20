/** Host IO cache for an unapplied proposal, never a second editor document. */
import { parsePodcastProposal } from "./podcast-proposal";
import type {
	PodcastOptions,
	PodcastSource,
	PodcastVideo,
} from "./podcast-types";
export async function podcastPlanCacheKey(input: {
	account: string;
	projectId: string;
	sceneId: string;
	options: PodcastOptions;
	words: PodcastSource["words"];
	sourceFingerprint?: string;
}) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(input)),
	);
	return (
		(input.options.mode === "teaser"
			? "opencut-strategic-teaser-v1:"
			: "opencut-podcast-shorts-v2:") +
		Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("")
	);
}
export function readPodcastPlan(
	storage: Pick<Storage, "getItem">,
	key: string,
): PodcastVideo[] | null {
	try {
		const raw = storage.getItem(key);
		return raw && raw.length <= 300000 ? parsePodcastProposal(raw) : null;
	} catch {
		return null;
	}
}
export function savePodcastPlan(
	storage: Pick<Storage, "setItem">,
	key: string,
	videos: PodcastVideo[],
) {
	const raw = JSON.stringify({ videos });
	if (raw.length > 300000)
		throw new Error("Podcast proposal exceeds the resume cache limit");
	storage.setItem(key, raw);
}
