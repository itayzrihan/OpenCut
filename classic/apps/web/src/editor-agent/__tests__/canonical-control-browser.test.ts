// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser test protocol and real WASM boundary. */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { acquireBrowser } from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";
import type { CanonicalControlAction } from "@/core/canonical-control";
import type { captureEditorUi } from "../editor-ui";

declare global {
	interface Window {
		__controlFixture: typeof import("./canonical-control-browser-fixture");
		__controlCalls: Array<
			CanonicalControlAction & { accountId: string; projectId: string }
		>;
	}
}

test("the same rendered canonical button exposes and invokes its action, with scoped hints and cleanup", async () => {
	const require = createRequire(import.meta.url);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("./canonical-control-browser-fixture.tsx", import.meta.url),
			),
		],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "fixture-editor-host",
				setup(build) {
					// Workspace packages may resolve separate React installs. Match
					// Next's single React instance in this standalone browser bundle.
					build.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
						path: require.resolve(path),
					}));
					build.onResolve({ filter: /^@\/editor\/use-editor$/ }, () => ({
						path: "host",
						namespace: "fixture",
					}));
					build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
						loader: "js",
						contents: `export const useEditor = () => ({project:{getActiveOrNull:()=>({metadata:{id:'classic-project'}})},command:{invokeCanonicalControl:input=>window.__controlCalls.push(input)}});`,
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
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
		session.attach({ classic });
		const page = await lease.browser.newPage();
		const browserErrors: string[] = [];
		page.on("pageerror", (error) => browserErrors.push(String(error)));
		await page.setViewport({ width: 1000, height: 900 });
		await page.setContent(
			`<main data-opencut-editor-project="classic-project"><div id="controls"></div><button id="spoof" data-capability-id="app.state.patch">Spoof</button></main>`,
		);
		await page.evaluate(
			async (code) => {
				window.__opencutAccountId = "alice";
				window.__controlCalls = [];
				const url = URL.createObjectURL(
					new Blob([code], { type: "text/javascript" }),
				);
				try {
					window.__controlFixture = await import(url);
				} finally {
					URL.revokeObjectURL(url);
				}
			},
			await bundle.outputs[0].text(),
		);
		const action = {
			capabilityId: "timeline.classic.track.update",
			input: {
				sceneId: "main-scene",
				trackId: "video-track",
				change: { type: "toggleMute" },
			},
		};
		await page.evaluate(
			(action) => window.__controlFixture.renderControl({ action }),
			action,
		);
		const observe = async () => {
			const result = await page.evaluate(
				async (revision) =>
					window.__controlFixture.performHostEffect({
						effect: {
							id: 1,
							adapter: "editorUi",
							projectId: "classic-project",
							request: {
								projectId: "classic-project",
								expectedRevision: revision,
								limit: 80,
							},
						},
						accountId: "alice",
						signal: new AbortController().signal,
						activeProjectId: () => "classic-project",
					}),
				session.status().revision,
			);
			if (result.type !== "success") throw new Error(result.message);
			return result.data as ReturnType<typeof captureEditorUi>;
		};
		const before = session.read();
		const snapshot = await observe();
		expect(browserErrors).toEqual([]);
		expect(snapshot.nodes.map((node) => node.name)).toContain(
			"Mute video track",
		);
		const control = snapshot.nodes.find((n) => n.name === "Mute video track")!;
		expect(control.pressed).toBe(false);
		expect(control.action).toEqual({
			...action,
			input: {
				...action.input,
				projectId: "classic-project",
				expectedRevision: snapshot.revision,
			},
		});
		expect(snapshot.nodes.find((n) => n.name === "Spoof")?.action).toBeNull();
		await page.click("#controls button");
		const [call] = await page.evaluate(() => window.__controlCalls);
		expect(call).toEqual({
			...action,
			projectId: "classic-project",
			accountId: "alice",
		});
		session.begin();
		session.invokeControl(call);
		session.commit({ label: "Control", hostContext: {} });
		const after = session.read();
		expect(after.document.scenes[0].tracks.main.muted).toBe(true);
		session.undo();
		expect(session.read()).toEqual(before);
		const started = session.startAgent({
			accountId: "alice",
			runId: "bound-control",
			request: "השתק את הווידאו",
		});
		session.agentCommand({
			type: "plan",
			epoch: started.epoch,
			steps: [{ title: "Mute track", status: "inProgress" }],
		});
		session.agentCommand({
			type: "describe",
			epoch: started.epoch,
			id: action.capabilityId,
		});
		const fresh = (await observe()).nodes.find(
			(n) => n.name === "Mute video track",
		)!.action!;
		session.agentCommand({
			type: "invoke",
			epoch: started.epoch,
			callId: "control-agent",
			id: fresh.capabilityId,
			input: fresh.input,
		});
		expect(session.read()).toEqual(after);
		const future = {
			capabilityId: "future.product.feature",
			input: { strength: 0.5 },
		};
		await page.evaluate(
			(action) => window.__controlFixture.renderControl({ action }),
			future,
		);
		expect(
			(await observe()).nodes.find((n) => n.name === "Mute video track")?.action
				?.capabilityId,
		).toBe(future.capabilityId);
		await page.evaluate(
			(action) =>
				window.__controlFixture.renderControl({ action, disabled: true }),
			future,
		);
		expect(
			(await observe()).nodes.find((n) => n.name === "Mute video track")
				?.action,
		).toBeNull();
		await page.click("#controls button");
		expect(await page.evaluate(() => window.__controlCalls.length)).toBe(1);
		await page.evaluate(() => window.__controlFixture.unmountControl());
		expect(
			(await observe()).nodes.some((n) => n.name === "Mute video track"),
		).toBe(false);
	} finally {
		session.dispose();
		await lease.release();
	}
}, 90_000);
