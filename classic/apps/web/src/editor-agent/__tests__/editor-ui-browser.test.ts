// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Isolated browser fixture loads the production host bundle; WASM validates its contract. Test shorthand is local to this suite. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireBrowser } from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { EditingAgentHostEffect } from "@/core/agent-protocol";
import type { captureEditorUi } from "../editor-ui";

declare global {
	interface Window {
		__uiTest: typeof import("../host-effects");
	}
}

test("real browser observation discovers new controls and reaches the WASM agent without mutating the edit", async () => {
	const build = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("../host-effects.ts", import.meta.url)),
		],
		target: "browser",
		format: "esm",
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const code = await build.outputs[0].text();
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	const runtime = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	try {
		const page = await lease.browser.newPage();
		await page.setViewport({ width: 1000, height: 900 });
		await page.setContent(`<main data-opencut-editor-project="classic-project">
<h2>Timeline</h2><button id="split">חיתוך</button><button disabled>Export</button>
<label>Audio gain <input type="number" value="8888"></label>
<label>Mute <input type="checkbox" checked></label>
<div role="tab" aria-selected="true">Effects</div><button aria-expanded="false">More</button>
<button aria-label="Safe label">Visible <span data-editor-agent-private>SECRET CHILD</span></button>
<button>Nested <span data-editor-agent-private>SECRET NESTED</span> text</button>
<input type="password" aria-label="SECRET PASSWORD" value="password">
<input type="file" aria-label="SECRET FILE"><textarea id="script-value" aria-label="Script">SECRET VALUE</textarea>
<button aria-labelledby="script-value">Script action</button>
<div contenteditable aria-label="Caption">SECRET EDITABLE <span role="button">SECRET RICH TEXT</span></div>
<main data-opencut-editor-project="nested-other"><button>SECRET NESTED PROJECT</button></main>
<aside data-testid="editor-agent"><button>SECRET AGENT</button></aside>
<div data-editor-agent-private><button>SECRET PRIVATE</button></div>
<div hidden><button>SECRET HIDDEN</button></div><div style="opacity:0"><button>SECRET OPACITY</button></div>
<div style="height:1px;overflow:hidden"><button style="margin-top:30px">SECRET CLIPPED</button></div>
<button aria-labelledby="outside-label" title="Fallback">Fallback</button>
<iframe srcdoc="<button>SECRET FRAME</button>"></iframe>
</main><div id="outside-label">SECRET EXTERNAL LABEL</div><button>SECRET OUTSIDE</button>
<main data-opencut-editor-project="other"><button>SECRET OTHER PROJECT</button></main>`);
		await page.evaluate(async (code) => {
			window.__opencutAccountId = "alice";
			const url = URL.createObjectURL(
				new Blob([code], { type: "text/javascript" }),
			);
			try {
				window.__uiTest = await import(url);
			} finally {
				URL.revokeObjectURL(url);
			}
			document.getElementById("split")?.focus();
		}, code);
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
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		const before = runtime.invokeSync("app.state.read", {}, null).result.data;
		const started = runtime.agentStart(
			"alice",
			"ui-run",
			"בדוק אילו בקרות עריכה מוצגות",
		);
		const discovery = runtime.agentCommand({
			type: "discover",
			query: "editor.ui.snapshot",
			limit: 10,
		});
		expect(JSON.stringify(discovery)).toContain("editor.ui.snapshot");
		runtime.agentCommand({
			type: "describe",
			epoch: started.epoch,
			id: "editor.ui.snapshot",
		});
		const request = runtime.agentProviderRequest("fixture-model");
		const round = runtime.agentProviderResponse(request.epoch, {
			id: "ui-response",
			status: "completed",
			output: [
				{
					type: "function_call",
					call_id: "ui-call",
					name: "opencut_editor",
					arguments: JSON.stringify({
						action: "invoke",
						id: "editor.ui.snapshot",
						input: { limit: 80 },
					}),
				},
			],
		});
		expect(round.pendingHost.adapter).toBe("editorUi");
		const effect = round.pendingHost as EditingAgentHostEffect;
		const observe = (
			effect: EditingAgentHostEffect,
			accountId = "alice",
			projectId = "classic-project",
		) =>
			page.evaluate(
				async ({ effect, accountId, projectId }) =>
					window.__uiTest.performHostEffect({
						effect,
						accountId,
						signal: new AbortController().signal,
						activeProjectId: () => projectId,
					}),
				{ effect, accountId, projectId },
			);
		const result = await observe(effect);
		expect(result.type).toBe("success");
		if (result.type !== "success") throw new Error("Observation rejected");
		const snapshot = result.data as ReturnType<typeof captureEditorUi>;
		expect(JSON.stringify(snapshot)).not.toContain("SECRET");
		expect(JSON.stringify(snapshot)).not.toContain("8888");
		expect(snapshot.nodes.find((n) => n.name === "חיתוך")).toMatchObject({
			role: "button",
			focused: true,
			disabled: false,
		});
		expect(snapshot.nodes.find((n) => n.name === "Export")?.disabled).toBe(
			true,
		);
		expect(snapshot.nodes.find((n) => n.name === "Mute")?.checked).toBe(true);
		expect(snapshot.nodes.find((n) => n.name === "Effects")?.selected).toBe(
			true,
		);
		expect(snapshot.nodes.find((n) => n.name === "More")?.expanded).toBe(false);
		expect(snapshot.nodes.find((n) => n.name === "Nested text")).toBeDefined();
		expect(snapshot.nodes.find((n) => n.name === "Script")).toBeDefined();
		expect(snapshot.nodes.find((n) => n.name === "Caption")).toBeDefined();
		expect(snapshot.truncated).toBe(false);
		expect((await observe(effect, "bob")).type).toBe("rejected");
		expect((await observe(effect, "alice", "other")).type).toBe("rejected");
		const bounded = await observe({
			...effect,
			request: { ...(effect.request as object), limit: 1 },
		});
		expect(
			bounded.type === "success" && (bounded.data as typeof snapshot).truncated,
		).toBe(true);
		await page.evaluate(() => {
			const button = document.createElement("button");
			button.textContent = "Future audio enhancement";
			document.querySelector("main")?.append(button);
		});
		const future = await observe({
			...effect,
			request: { ...(effect.request as object), query: "audio enhancement" },
		});
		expect(
			future.type === "success" &&
				(future.data as typeof snapshot).nodes.map((n) => n.name),
		).toEqual(["Future audio enhancement"]);
		// A pending read can be checkpointed/restored without serializing a DOM handle.
		const checkpoint = runtime.agentCheckpoint();
		const archive = runtime.invokeSync(
			"project.classic.session.archive",
			{ projectId: "classic-project", persistableOnly: true },
			null,
		).result.data;
		reopened.invokeSync(
			"project.classic.session.restore",
			{ projectId: "classic-project", expectedRevision: 0, archive },
			null,
		);
		reopened.agentRestoreCheckpoint("alice", checkpoint);
		const pending = reopened.agentPendingHost();
		const restoredResult = await observe(pending);
		expect(
			reopened.agentSettleHost(
				"alice",
				"classic-project",
				pending.id,
				restoredResult,
			).activities[0].ok,
		).toBe(true);
		const settled = runtime.agentSettleHost(
			"alice",
			"classic-project",
			effect.id,
			result,
		);
		expect(settled.activities[0].ok).toBe(true);
		expect(runtime.agentProviderRequest("fixture-model").body).toBeDefined();
		expect(runtime.invokeSync("app.state.read", {}, null).result.data).toEqual(
			before,
		);
		await page.evaluate(() => {
			const root = document.querySelector("main")!;
			const fragment = document.createDocumentFragment();
			for (let i = 0; i < 10_100; i++) {
				const privateNode = document.createElement("div");
				privateNode.setAttribute("data-editor-agent-private", "");
				fragment.append(privateNode);
			}
			root.replaceChildren(fragment);
		});
		const boundedScan = await observe(effect);
		expect(boundedScan.type === "success" && boundedScan.data).toMatchObject({
			scanned: 10_000,
			truncated: true,
			nodes: [],
		});
		const invalid = await observe({
			...effect,
			request: { ...(effect.request as object), selector: "body" },
		});
		expect(invalid.type).toBe("rejected");
		await page.evaluate(() => document.querySelector("main")?.remove());
		expect((await observe(effect)).type).toBe("rejected");
	} finally {
		runtime.free();
		reopened.free();
		await lease.release();
	}
}, 90_000);
