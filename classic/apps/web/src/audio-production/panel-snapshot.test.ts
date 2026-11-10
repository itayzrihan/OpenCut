import { expect, test } from "bun:test";
import { isEditorSnapshotEqual } from "@/editor/snapshot";
import { audioDraftsSnapshot } from "./panel-snapshot";
import { audioDraftSchema, type AudioDraft } from "./types";

const saved = JSON.stringify([
	{
		id: "dialogue-1",
		version: 2,
		title: "Dialogue",
		kind: "dialogue",
		modelId: "eleven_v3",
		text: "",
		instrumental: false,
		dialogue: [
			{ voiceId: "voice_a", text: "Hello" },
			{ voiceId: "voice_b", text: "Welcome" },
		],
	} satisfies AudioDraft,
]);

test("saved audio drafts stay stable across fresh canonical decodes and reopening", () => {
	const read = () => audioDraftSchema.array().parse(JSON.parse(saved));
	// This was the old selector: nested draft objects compare unequal every read.
	expect(isEditorSnapshotEqual({ a: read(), b: read() })).toBe(false);
	const first = audioDraftsSnapshot(read());
	for (let i = 0; i < 100; i++) {
		expect(
			isEditorSnapshotEqual({ a: first, b: audioDraftsSnapshot(read()) }),
		).toBe(true);
	}
	expect(audioDraftSchema.array().parse(JSON.parse(first))).toEqual(read());
});

test("audio edits, dialogue changes and undo still invalidate the snapshot", () => {
	const drafts = audioDraftSchema.array().parse(JSON.parse(saved));
	const current = audioDraftsSnapshot(drafts);
	const draft = drafts[0]!;
	for (const changed of [
		[],
		[{ ...draft, version: draft.version + 1 }],
		[{ ...draft, title: "Updated title" }],
		[{ ...draft, dialogue: [{ voiceId: "voice_a", text: "Changed line" }] }],
	]) {
		expect(
			isEditorSnapshotEqual({ a: current, b: audioDraftsSnapshot(changed) }),
		).toBe(false);
	}
	expect(audioDraftsSnapshot([])).toBe(audioDraftsSnapshot([]));
});
