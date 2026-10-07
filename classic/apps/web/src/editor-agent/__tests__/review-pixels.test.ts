// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The serialized fixture is validated by Rust and the generated request is a public JSON projection. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
test("real WASM review decodes exact JPEG pixels and rejects fake image evidence", async () => {
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	const fixture = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	session.attach({ classic: fixture });
	const run = session.startAgent({
		accountId: "alice",
		runId: "pixel-review",
		request: "Rename this project",
	});
	session.agentCommand({ type: "observe" });
	session.agentCommand({
		type: "plan",
		epoch: run.epoch,
		steps: [{ title: "Rename", status: "inProgress" }],
	});
	session.agentCommand({
		type: "describe",
		epoch: run.epoch,
		id: "project.classic.commit",
	});
	const classic = session.read();
	classic.document.metadata.name = "Pixel review";
	session.agentCommand({
		type: "invoke",
		epoch: run.epoch,
		callId: "rename",
		id: "project.classic.commit",
		input: {
			projectId: "classic-project",
			expectedRevision: session.status().revision,
			classic,
		},
	});
	const plan = session.agentReviewPlan();
	const black = session.storeAgentFrame(
		new Uint8Array(
			readFileSync(
				new URL(
					"../../../../../../crates/editor-agent/tests/fixtures/black-frame.jpg",
					import.meta.url,
				),
			),
		),
	);
	const request = session.agentReviewRequest({
		model: "model",
		epoch: plan.epoch,
		revision: plan.revision,
		frames: plan.times.map((timeTicks) => ({
			artifactId: black.id,
			timeTicks,
		})),
	});
	const body = JSON.stringify(request.body);
	expect(body).toContain("nativePixelEvidence");
	expect(body).toContain("nearBlack");
	expect(body).toContain("Never claim such content is visible");
	const fake = session.storeAgentFrame(new Uint8Array([1, 2, 3]));
	expect(() =>
		session.agentReviewRequest({
			model: "model",
			epoch: plan.epoch,
			revision: plan.revision,
			frames: plan.times.map((timeTicks) => ({
				artifactId: fake.id,
				timeTicks,
			})),
		}),
	).toThrow("Invalid review JPEG");
	session.dispose();
});
