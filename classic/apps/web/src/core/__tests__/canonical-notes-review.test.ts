/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- serialized fixtures and runtime receipts are validated by the real Rust WASM boundary. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

function fixture(): CanonicalClassicSnapshot {
	return JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
}

test("browser UI and editing agent share durable canonical notes and imported review feedback", async () => {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	const original = fixture();
	let reopened: CanonicalClassicSession | undefined;
	try {
		session.attach({ classic: original });
		session.invokeControl({
			capabilityId: "project.classic.notes.edit",
			input: {
				change: {
					type: "create",
					noteId: "note-1",
					title: "Outline",
					body: "פתיחה קצרה\nThen the demo",
				},
			},
		});
		const note = session.read().document.notes?.[0];
		expect(note?.version).toBe(1);
		expect(note?.body).toContain("פתיחה");
		const agentReceipt = runtime.invokeSync(
			"project.classic.notes.edit",
			{
				projectId: "classic-project",
				expectedRevision: session.status().revision,
				change: {
					type: "update",
					noteId: "note-1",
					expectedNoteVersion: 1,
					body: "Agent added a final CTA",
				},
			},
			{},
		) as { result: { data: unknown } };
		expect(agentReceipt.result.data).toBeDefined();
		const canonical = runtime.invokeSync(
			"app.state.read",
			{
				projectId: "classic-project",
				pointer: "/project/classic/document/notes",
			},
			{},
		) as { result: { data: { value: unknown } } };
		expect(canonical.result.data.value).toEqual(session.read().document.notes);
		expect(session.read().document.notes?.[0]?.version).toBe(2);
		expect(() =>
			session.invokeControl({
				capabilityId: "project.classic.notes.edit",
				input: {
					change: {
						type: "update",
						noteId: "note-1",
						expectedNoteVersion: 1,
						body: "Stale UI draft",
					},
				},
			}),
		).toThrow();
		const share = {
			shareId: "6ec586b2-213d-4006-9d76-87074d987d34",
			version: "render-a",
			sceneId: original.document.currentSceneId,
			durationTicks: 480_000,
			createdAt: "2026-11-10T10:00:00Z",
		};
		session.invokeControl({
			capabilityId: "project.classic.review.share.record",
			input: { share },
		});
		const imported = {
			id: "7ec586b2-213d-4006-9d76-87074d987d34",
			shareId: share.shareId,
			shareVersion: share.version,
			sceneId: share.sceneId,
			timeTicks: 120_000,
			body: "Tighter cut here",
			authorName: "Client",
			serverRevision: 1,
			resolved: false,
			createdAt: share.createdAt,
		};
		const action = {
			capabilityId: "project.classic.review.comments.import",
			input: {
				shareId: share.shareId,
				shareVersion: share.version,
				comments: [imported],
			},
		};
		session.invokeControl(action);
		const revision = session.status().revision;
		session.invokeControl(action);
		expect(session.status().revision).toBe(revision);
		expect(session.read().document.clientReview?.comments).toEqual([imported]);
		const archive = session.archive();
		reopened = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		reopened.restore(archive);
		expect(reopened.read().document.notes).toEqual(
			session.read().document.notes,
		);
		expect(reopened.read().document.clientReview).toEqual(
			session.read().document.clientReview,
		);
		reopened.undo();
		expect(reopened.read().document.clientReview?.comments).toEqual([]);
		reopened.redo();
		expect(reopened.read().document.clientReview?.comments).toEqual([imported]);
	} finally {
		reopened?.dispose();
		session.dispose();
	}
});
