import type { AudioDraft } from "./types";

/** Canonical reads decode fresh objects; external-store snapshots must be stable. */
export function audioDraftsSnapshot(drafts: readonly AudioDraft[]): string {
	return JSON.stringify(drafts);
}
