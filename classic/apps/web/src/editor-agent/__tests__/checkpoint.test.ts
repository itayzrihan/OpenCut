import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

test("a completed task and reloaded follow-up retain scoped public history without replay", async () => {
	const source = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		source.invokeSync(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		const scope = ["alice", "classic-project"] as const;
		source.conversationApply(...scope, {
			type: "user",
			text: "Add a blue title to clip-1",
			attachments: [],
		});
		source.conversationApply(...scope, { type: "round", review: false });
		const first = source.agentStart(
			"alice",
			"first",
			"Add a blue title to clip-1",
		);
		source.agentCommand({
			type: "plan",
			epoch: first.epoch,
			steps: [{ title: "Inspect the title", status: "complete" }],
		});
		source.agentVerify(
			source.agentSnapshot().epoch,
			source.snapshot().revision,
			[],
		);
		source.agentCommand({
			type: "finish",
			epoch: source.agentSnapshot().epoch,
			text: "Title text-42 is blue",
		});
		source.conversationApply(...scope, {
			type: "text",
			text: "Title text-42 is blue; clip-1",
		});
		source.conversationApply(...scope, { type: "close" });
		const archive = source.invokeSync(
			"project.classic.session.archive",
			{ projectId: "classic-project", persistableOnly: true },
			null,
		).result.data;
		reopened.invokeSync(
			"project.classic.session.restore",
			{ projectId: "classic-project", expectedRevision: 0, archive },
			null,
		);
		reopened.conversationRestore(
			...scope,
			JSON.parse(JSON.stringify(source.conversationRead(...scope))),
		);
		reopened.conversationApply(...scope, {
			type: "user",
			text: "אותו דבר בקליפ הבא",
			attachments: [],
		});
		reopened.agentStart("alice", "follow-up", "אותו דבר בקליפ הבא");
		const request = reopened.agentProviderRequest("fixture-model");
		const history = JSON.parse(request.body.input[1].content).priorConversation;
		expect(history).toHaveLength(2);
		expect(history[1].text).toContain("text-42");
		expect(request.body.input).toHaveLength(2);
		expect(reopened.agentSnapshot().receipts).toHaveLength(0);
		expect(reopened.snapshot().revision).toBe(source.snapshot().revision);
	} finally {
		source.free();
		reopened.free();
	}
}, 30_000);

test("HyperFrames checkpoint survives the browser JSON numeric round trip", async () => {
	const source = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		source.invokeSync(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		source.invokeSync(
			"timeline.hyperframes.import",
			{
				projectId: "classic-project",
				expectedRevision: 1,
				name: "Reference",
				startSeconds: 0,
				source: {
					entryFile: "index.html",
					files: {
						"index.html":
							'<div data-composition-id="test" data-duration="4.8" data-width="1920" data-height="1080"></div>',
					},
					resourceAssetIds: {},
				},
			},
			null,
		);
		source.agentStart("alice", "hyperframes-checkpoint", "Remix this example");
		const checkpoint = source.agentCheckpoint();
		const archive = JSON.parse(
			JSON.stringify(
				source.invokeSync(
					"project.classic.session.archive",
					{ projectId: "classic-project", persistableOnly: true },
					null,
				).result.data,
			),
		);
		reopened.invokeSync(
			"project.classic.session.restore",
			{ projectId: "classic-project", expectedRevision: 0, archive },
			null,
		);
		expect(reopened.agentRestoreCheckpoint("alice", checkpoint).phase).toBe(
			"paused",
		);
	} finally {
		source.free();
		reopened.free();
	}
}, 20_000);

test("real WASM restores a paused agent only beside its matching canonical archive", async () => {
	const source = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	const wrongAccount = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		await source.invoke(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		const started = source.agentStart(
			"alice",
			"checkpoint-run",
			"שנה את שם הסרטון",
		);
		source.agentCommand({
			type: "describe",
			epoch: started.epoch,
			id: "project.classic.commit",
		});
		source.agentCommand({
			type: "plan",
			epoch: started.epoch,
			steps: [{ title: "Rename the film", status: "inProgress" }],
		});
		classic.document.metadata.name = "Saved by the editing agent";
		source.agentCommand({
			type: "invoke",
			epoch: started.epoch,
			callId: "rename",
			id: "project.classic.commit",
			input: { classic },
		});
		const archive = source.invokeSync(
			"project.classic.session.archive",
			{ projectId: "classic-project", persistableOnly: true },
			null,
		).result.data;
		const checkpoint = source.agentCheckpoint();
		expect(typeof checkpoint).toBe("string");
		for (const runtime of [reopened, wrongAccount])
			runtime.invokeSync(
				"project.classic.session.restore",
				{ projectId: "classic-project", expectedRevision: 0, archive },
				null,
			);
		expect(reopened.snapshot().revision).toBe(source.snapshot().revision);
		expect(() =>
			wrongAccount.agentRestoreCheckpoint("bob", checkpoint),
		).toThrow("another account");
		expect(wrongAccount.agentSnapshot()).toBeNull();
		const recovered = reopened.agentRestoreCheckpoint("alice", checkpoint);
		expect(recovered.phase).toBe("paused");
		expect(recovered.receipts).toHaveLength(1);
		expect(recovered.receipts[0].committed).toBe(true);
		expect(() => reopened.agentProviderRequest("fixture-model")).toThrow();
		reopened.agentCommand({ type: "resume", scope: recovered.scope });
		reopened.agentCommand({ type: "observe" });
		expect(reopened.agentSnapshot().phase).toBe("needsVerification");
		reopened.invokeSync("history.undo", {}, null);
		expect(reopened.snapshot().project.classic.document.metadata.name).toBe(
			"Existing edit",
		);
		const mismatched = JSON.parse(checkpoint);
		mismatched.projectRevision += 1;
		expect(() =>
			wrongAccount.agentRestoreCheckpoint("alice", JSON.stringify(mismatched)),
		).toThrow("not saved together");
	} finally {
		source.free();
		reopened.free();
		wrongAccount.free();
	}
}, 20_000);
