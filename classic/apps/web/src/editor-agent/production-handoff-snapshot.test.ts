import { expect, test } from "bun:test";
import { isEditorSnapshotEqual } from "@/editor/snapshot";
import type { DirectorDocument } from "@/generative/types";
import { productionHandoffSnapshot } from "./production-handoff-snapshot";

const saved = JSON.stringify({
	id: "handoff-1",
	sourceRevision: 3,
	createdAt: "2026-11-10T12:00:00Z",
	request: "Preserve the two approved references",
	rows: [],
	referenceSlots: [],
	referenceIds: ["a".repeat(32), "b".repeat(32)],
	durationMs: 4000,
	storyboardRecommended: true,
} satisfies NonNullable<DirectorDocument["productionHandoff"]>);

test("a saved handoff remains a stable external-store snapshot across fresh runtime reads", () => {
	const read = () =>
		productionHandoffSnapshot({
			projectId: "project-1",
			handoff: JSON.parse(saved),
		});
	const initial = read();
	for (let i = 0; i < 100; i++) {
		expect(isEditorSnapshotEqual({ a: initial, b: read() })).toBe(true);
	}
	expect(JSON.parse(initial.referenceIdsJson)).toEqual([
		"a".repeat(32),
		"b".repeat(32),
	]);
});

test("handoff creation, undo and project changes still invalidate the snapshot", () => {
	const empty = productionHandoffSnapshot({
		projectId: "project-1",
		handoff: undefined,
	});
	const current = productionHandoffSnapshot({
		projectId: "project-1",
		handoff: JSON.parse(saved),
	});
	for (const changed of [
		empty,
		productionHandoffSnapshot({
			projectId: "project-2",
			handoff: JSON.parse(saved),
		}),
		productionHandoffSnapshot({
			projectId: "project-1",
			handoff: { ...JSON.parse(saved), id: "handoff-2" },
		}),
		productionHandoffSnapshot({
			projectId: "project-1",
			handoff: { ...JSON.parse(saved), referenceIds: ["c".repeat(32)] },
		}),
	]) {
		expect(isEditorSnapshotEqual({ a: current, b: changed })).toBe(false);
	}
	expect(
		isEditorSnapshotEqual({
			a: empty,
			b: productionHandoffSnapshot({
				projectId: "project-1",
				handoff: null,
			}),
		}),
	).toBe(true);
});
