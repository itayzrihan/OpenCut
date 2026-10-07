// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Tests exercise the generated WASM and an isolated Electron IPC response boundary. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { performHostEffect } from "../host-effects";
import type { EditingAgentHostEffect } from "@/core/agent-protocol";

test("desktop screenshot discovery, scoped host IO, artifact receipts and pending-run restoration use real WASM", async () => {
	const runtime = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	let captures = 0;
	let stores = 0;
	let project = "classic-project";
	let onCapture = () => {};
	const host = {
		__opencutAccountId: "alice",
		opencutElectron: {
			async captureEditorScreenshot(scope: {
				accountId: string;
				projectId: string;
			}) {
				captures++;
				expect(scope).toEqual({
					accountId: "alice",
					projectId: "classic-project",
				});
				onCapture();
				return {
					bytes: new Uint8Array([255, 216, 255, 224]),
					width: 800,
					height: 600,
				};
			},
		},
	};
	Object.defineProperty(globalThis, "window", {
		value: host,
		configurable: true,
	});
	try {
		expect(JSON.stringify(runtime.capabilities())).not.toContain(
			"editor.ui.screenshot",
		);
		runtime.installDesktopUi();
		expect(JSON.stringify(runtime.capabilities())).toContain(
			"editor.ui.screenshot",
		);
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId: project, expectedRevision: 0, classic },
			null,
		);
		const before = runtime.invokeSync("app.state.read", {}, null).result.data;
		const started = runtime.agentStart(
			"alice",
			"desktop-run",
			"בדוק צילום של ממשק העריכה",
		);
		expect(
			JSON.stringify(
				runtime.agentCommand({
					type: "discover",
					query: "editor.ui.screenshot",
					limit: 5,
				}),
			),
		).toContain("editor.ui.screenshot");
		runtime.agentCommand({
			type: "describe",
			epoch: started.epoch,
			id: "editor.ui.screenshot",
		});
		const provider = runtime.agentProviderRequest("fixture-model");
		const round = runtime.agentProviderResponse(provider.epoch, {
			id: "screenshot-response",
			status: "completed",
			output: [
				{
					type: "function_call",
					call_id: "screenshot-call",
					name: "opencut_editor",
					arguments: JSON.stringify({
						action: "invoke",
						id: "editor.ui.screenshot",
						input: {},
					}),
				},
			],
		});
		const effect = round.pendingHost as EditingAgentHostEffect;
		expect(effect.adapter).toBe("editorScreenshot");
		const archive = runtime.invokeSync(
			"project.classic.session.archive",
			{ projectId: project, persistableOnly: true },
			null,
		).result.data;
		reopened.installDesktopUi();
		reopened.invokeSync(
			"project.classic.session.restore",
			{ projectId: project, expectedRevision: 0, archive },
			null,
		);
		reopened.agentRestoreCheckpoint("alice", runtime.agentCheckpoint());
		expect(reopened.agentPendingHost().adapter).toBe("editorScreenshot");
		const controller = new AbortController();
		const invoke = () =>
			performHostEffect({
				effect,
				accountId: "alice",
				signal: controller.signal,
				activeProjectId: () => project,
				storeScreenshot: ({ bytes, width, height }) => {
					stores++;
					return runtime.storeArtifact(
						bytes,
						"image/jpeg",
						width,
						height,
						undefined,
					);
				},
			});
		host.__opencutAccountId = "bob";
		expect((await invoke()).type).toBe("rejected");
		host.__opencutAccountId = "alice";
		project = "other";
		expect((await invoke()).type).toBe("rejected");
		expect(captures).toBe(0);
		project = "classic-project";
		onCapture = () => {
			host.__opencutAccountId = "bob";
		};
		expect((await invoke()).type).toBe("rejected");
		expect(stores).toBe(0);
		host.__opencutAccountId = "alice";
		onCapture = () => {};
		const result = await invoke();
		expect(result.type).toBe("success");
		expect(stores).toBe(1);
		const settled = runtime.agentSettleHost(
			"alice",
			project,
			effect.id,
			result,
		);
		expect(settled.activities[0].ok).toBe(true);
		expect(JSON.stringify(settled)).toContain("opencut://artifacts/");
		expect(runtime.invokeSync("app.state.read", {}, null).result.data).toEqual(
			before,
		);
		const visualRequest = runtime.agentProviderRequest("fixture-model");
		expect(JSON.stringify(visualRequest.body)).toContain(
			'"type":"input_image"',
		);
		expect(JSON.stringify(visualRequest.body)).toContain(
			"data:image/jpeg;base64,/9j/4A==",
		);
		expect(runtime.agentCheckpoint()).not.toContain("data:image/jpeg;base64");
		runtime.invokeSync(
			"project.classic.settings.update",
			{
				projectId: project,
				expectedRevision: visualRequest.revision,
				settings: { fps: { numerator: 30, denominator: 1 } },
			},
			null,
		);
		expect(
			JSON.stringify(runtime.agentProviderRequest("fixture-model").body),
		).not.toContain('"type":"input_image"');
		// Cancellation after an IPC response must not store or settle new evidence.
		onCapture = () => controller.abort();
		await expect(invoke()).rejects.toThrow();
		expect(stores).toBe(1);
	} finally {
		if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
		else Reflect.deleteProperty(globalThis, "window");
		runtime.free();
		reopened.free();
	}
}, 60_000);
