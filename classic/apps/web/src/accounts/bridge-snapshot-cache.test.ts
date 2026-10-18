import { expect, test } from "bun:test";
import { BridgeSnapshotCache } from "./bridge-snapshot-cache";
const snapshot = {
	sessionId: "account_tab",
	projectId: "p",
	projectName: "P",
	revision: 1,
	timeline: { words: ["original"] },
	tools: [{ name: "edit" }],
};
const value = {
	projectId: "p",
	projectName: "P",
	expectedRevision: 1,
	revision: 2,
	dirty: true,
	playback: { position: 17 },
	selection: ["clip"],
	ui: { focused: true },
};
test("legacy heartbeat preserves original document/tools and enforces account-session, project and revision scope", () => {
	const cache = new BridgeSnapshotCache();
	cache.remember({ snapshot, bytes: 100 });
	expect(cache.heartbeat({ sessionId: "other_tab", value })).toBeNull();
	expect(
		cache.heartbeat({
			sessionId: "account_tab",
			value: { ...value, projectId: "other" },
		}),
	).toBeNull();
	const result = cache.heartbeat({ sessionId: "account_tab", value });
	expect(result?.timeline).toBe(snapshot.timeline);
	expect(result?.tools).toBe(snapshot.tools);
	expect(result?.playback).toEqual({ position: 17 });
	expect(snapshot.revision).toBe(1);
	expect(cache.heartbeat({ sessionId: "account_tab", value })).toBeNull();
});
test("legacy cache rejects large snapshots and expires inactive browser sessions", () => {
	let now = 0;
	const cache = new BridgeSnapshotCache({ now: () => now });
	cache.remember({ snapshot, bytes: 2 * 1024 * 1024 + 1 });
	expect(cache.heartbeat({ sessionId: snapshot.sessionId, value })).toBeNull();
	cache.remember({ snapshot, bytes: 100 });
	now = 120001;
	expect(cache.heartbeat({ sessionId: snapshot.sessionId, value })).toBeNull();
});
