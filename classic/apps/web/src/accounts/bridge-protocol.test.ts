import { expect, test } from "bun:test";
import { legacyBridgeBody } from "./bridge-protocol";

test("old bridge peers receive no unsupported canonical tools or revisions", () => {
	const state = {
		sessionId: "account_tab",
		projectId: "project",
		revision: 99,
		canonicalRevision: 4,
		timeline: { elements: [1] },
		tools: [
			{ name: "legacy.read", parameters: {} },
			{
				name: "canonical.audio.earshot.preview",
				canonical: { id: "audio.earshot.preview" },
			},
			{ name: "canonical.app.state.read" },
		],
	};
	const body = new TextEncoder().encode(JSON.stringify(state)).buffer;
	const result = JSON.parse(
		new TextDecoder().decode(legacyBridgeBody({ body, operation: "state" })),
	);
	expect(result.tools).toEqual([{ name: "legacy.read", parameters: {} }]);
	expect(result.canonicalRevision).toBeUndefined();
	expect(result.revision).toBe(99);
	expect(result.timeline).toEqual(state.timeline);
	expect(state.tools.length).toBe(3);
});

test("heartbeat downgrade preserves its optimistic transport revision", () => {
	const body = new TextEncoder().encode(
		JSON.stringify({
			projectId: "project",
			expectedRevision: 98,
			revision: 99,
			canonicalRevision: 4,
		}),
	).buffer;
	expect(
		JSON.parse(
			new TextDecoder().decode(
				legacyBridgeBody({ body, operation: "heartbeat" }),
			),
		),
	).toEqual({ projectId: "project", expectedRevision: 98, revision: 99 });
});
