/** Bounded transport cache for legacy bridge peers; never editor authority. */
export interface BridgeSnapshot extends Record<string, unknown> {
	sessionId: string;
	projectId: string;
	projectName: string;
	revision: number;
}
export interface BridgeHeartbeat {
	projectId: string;
	projectName: string;
	expectedRevision: number;
	revision: number;
	canonicalRevision?: number;
	dirty: boolean;
	playback: unknown;
	selection: unknown;
	ui: unknown;
}
const LEGACY_BODY_LIMIT = 2 * 1024 * 1024;
export class BridgeSnapshotCache {
	private entries = new Map<string, { value: BridgeSnapshot; at: number }>();
	private now: () => number;
	constructor({ now = Date.now }: { now?: () => number } = {}) {
		this.now = now;
	}
	remember({ snapshot, bytes }: { snapshot: BridgeSnapshot; bytes: number }) {
		this.expire();
		if (bytes > LEGACY_BODY_LIMIT) {
			this.entries.delete(snapshot.sessionId);
			return;
		}
		this.entries.delete(snapshot.sessionId);
		this.entries.set(snapshot.sessionId, {
			value: { ...snapshot },
			at: this.now(),
		});
		while (this.entries.size > 32)
			this.entries.delete(this.entries.keys().next().value!);
	}
	heartbeat({
		sessionId,
		value,
	}: {
		sessionId: string;
		value: BridgeHeartbeat;
	}): BridgeSnapshot | null {
		this.expire();
		const cached = this.entries.get(sessionId);
		if (
			!cached ||
			cached.value.projectId !== value.projectId ||
			cached.value.revision !== value.expectedRevision ||
			value.revision < value.expectedRevision
		)
			return null;
		const updated = {
			...cached.value,
			projectName: value.projectName,
			revision: value.revision,
			canonicalRevision: value.canonicalRevision,
			dirty: value.dirty,
			playback: value.playback,
			selection: value.selection,
			ui: value.ui,
		};
		this.entries.delete(sessionId);
		this.entries.set(sessionId, { value: updated, at: this.now() });
		return updated;
	}
	forget({ sessionId }: { sessionId: string }) {
		this.entries.delete(sessionId);
	}
	private expire() {
		for (const [key, entry] of this.entries)
			if (this.now() - entry.at > 120000) this.entries.delete(key);
	}
}
