/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Real Rust fixture and isolated browser protocols. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
	createCaptureSession,
	closeCaptureSession,
	type CaptureSession,
} from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesRenderHost } from "../render-host";
import type { TimelineElement } from "@/timeline";
import type { HyperframesSource } from "../types";

const source: HyperframesSource = {
	entryFile: "index.html",
	resourceAssetIds: {},
	files: {
		"index.html": readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/hyperframes-variables.html",
				import.meta.url,
			),
			"utf8",
		),
	},
};
source.files["index.html"] = source.files["index.html"].replace(
	"</body>",
	'<div id="nested-a" data-composition-id="nested-a" data-no-timeline data-composition-src="tile.html" data-start="0" data-duration="4" style="position:absolute;top:140px"></div><div id="nested-b" data-composition-id="nested-b" data-no-timeline data-composition-src="tile.html" data-start="0" data-duration="4" style="position:absolute;left:160px;top:140px"></div></body>',
);
source.files["tile.html"] =
	`<html data-composition-variables='[{"id":"title","type":"string","default":"Nested default"}]'><body><template><div data-composition-id="nested" data-no-timeline data-duration="4"><span id="nested-text" style="color:white" data-start="0" data-duration="4"></span><script>document.getElementById("nested-text").textContent=window.__hyperframes.getVariables().title;</script></div></template></body></html>`;
const pixels = async (png: Uint8Array) =>
	sharp(png).ensureAlpha().raw().toBuffer();
const alpha = ({ bytes, x }: { bytes: Buffer; x: number }) =>
	bytes[(20 * 320 + x) * 4 + 3];

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"canonical variable edits update initialization and bindings, preserve opacity/history, and match live/capture",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const stateRuntime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: stateRuntime,
			projectId: "classic-project",
		});
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "a", projectId: "classic-project" };
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-hf-variable-test-"),
		);
		let engine: CaptureSession | undefined;
		const originalSource = JSON.stringify(source);
		try {
			const original = await host.open({
				scope,
				source,
				resolveResource: async () => null,
			});
			const artifact = await host.capture({
				scope,
				id: original.id,
				timeSeconds: 0.5,
			});
			const originalPixels = await pixels(runtime.readArtifact(artifact.uri));
			await host.closeSession({ scope, id: original.id });
			const classic = JSON.parse(
				readFileSync(
					new URL(
						"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
						import.meta.url,
					),
					"utf8",
				),
			) as CanonicalClassicSnapshot;
			session.attach({ classic });
			const imported = session.importHyperframes({
				name: "Nested duplicate layers",
				source,
				runtimeManifest: original.runtimeManifest,
			});
			const sceneId = classic.document.currentSceneId;
			const paint = original.runtimeManifest.layers.find(
				(layer) => layer.elementId === "paint",
			)!;
			session.setHyperframesLayerOpacity({
				sceneId,
				elementId: imported.itemId,
				layerKey: paint.key,
				opacity: 0.5,
			});
			const values = {
				title: "Updated </script><script>window.bad=true</script>",
				accent: "#00ff00",
				size: 90,
				mode: "right",
				show: true,
			};
			const prepared = session.prepareHyperframesVariables({ source, values });
			const checked = await host.open({
				scope,
				source: prepared,
				resolveResource: async () => null,
			});
			await host.closeSession({ scope, id: checked.id });
			session.setHyperframesVariables({
				sceneId,
				elementId: imported.itemId,
				values,
				manifest: checked.runtimeManifest,
				expectedRevision: session.status().revision,
			});
			const edited = session.read();
			const element = edited.document.scenes
				.flatMap((scene) => scene.tracks.overlay)
				.flatMap<TimelineElement>((track) => track.elements)
				.find((element) => element.id === imported.itemId)!;
			if (element.type !== "graphic")
				throw new Error("Expected compound graphic");
			const layerEdits = element.hyperframesLayerEdits!;
			const active = await host.open({
				scope,
				source: prepared,
				layerEdits,
				resolveResource: async () => null,
			});
			const first = await host.capture({
				scope,
				id: active.id,
				timeSeconds: 0.5,
			});
			const editedPixels = await pixels(runtime.readArtifact(first.uri));
			expect(alpha({ bytes: editedPixels, x: 20 })).toBe(0);
			expect(alpha({ bytes: editedPixels, x: 180 })).toBeGreaterThan(0);
			expect(editedPixels[(20 * 320 + 180) * 4 + 1]).toBe(255);
			expect(originalPixels[(20 * 320 + 20) * 4]).toBe(255);
			const live = await host.livePreview({ scope, id: active.id });
			engine = await createCaptureSession(
				new URL(live.url).origin,
				directory,
				{
					entryUrl: live.url,
					width: 320,
					height: 180,
					fps: { num: 30, den: 1 },
					format: "png",
				},
				null,
				{
					forceScreenshot: true,
					useDrawElement: false,
					browserGpuMode: "software",
					enableBrowserPool: false,
				},
			);
			const page = engine.page;
			await page.evaluateOnNewDocument(() => {
				const state = window as unknown as {
					events: Array<{ type: string; sequence: number }>;
				};
				state.events = [];
				window.addEventListener("message", (event) => {
					if (
						event.source === window &&
						event.data?.source === "opencut-hf-live"
					)
						state.events.push(event.data);
				});
			});
			await page.goto(live.url, { waitUntil: "load" });
			await page.waitForFunction(
				() =>
					(
						window as unknown as { events: Array<{ type: string }> }
					).events.some((event) => event.type === "ready"),
				{ timeout: 15000 },
			);
			const content = page
				.frames()
				.find((frame) => frame.parentFrame() === page.mainFrame())!;
			expect(
				await content.evaluate(
					() => document.getElementById("title")?.textContent,
				),
			).toBe(values.title);
			expect(
				await content.evaluate(
					() => (window as unknown as { bad?: boolean }).bad,
				),
			).toBeUndefined();
			expect(
				await content.evaluate(
					() => document.getElementById("paint")?.style.width,
				),
			).toBe("90px");
			expect(
				await content.evaluate(() =>
					Array.from(
						document.querySelectorAll(
							'[id$="nested-text"], [data-hf-authored-id="nested-text"]',
						),
					).map((node) => node.textContent),
				),
			).toEqual([values.title, values.title]);
			const frames: Buffer[] = [];
			for (const [index, timeSeconds] of [0.5, 2, 0.5, 0.5].entries()) {
				const sequence = index + 1;
				await page.evaluate(
					({ sequence, timeSeconds }) =>
						window.postMessage(
							{
								source: "opencut-hf-live",
								type: "seek",
								sequence,
								timeSeconds,
							},
							"*",
						),
					{ sequence, timeSeconds },
				);
				await page.waitForFunction(
					(sequence) =>
						(
							window as unknown as {
								events: Array<{ type: string; sequence: number }>;
							}
						).events.some(
							(event) => event.type === "frame" && event.sequence === sequence,
						),
					{ timeout: 15000 },
					sequence,
				);
				const livePixels = await pixels(
					await page.screenshot({ type: "png", omitBackground: true }),
				);
				const captured = await host.capture({
					scope,
					id: active.id,
					timeSeconds,
				});
				expect(livePixels).toEqual(
					await pixels(runtime.readArtifact(captured.uri)),
				);
				frames.push(livePixels);
			}
			expect(frames[0]).toEqual(frames[2]);
			expect(frames[2]).toEqual(frames[3]);
			expect(frames[1]).not.toEqual(frames[0]);
			// Persisted archive/undo/redo keeps the overrides on the same occurrence.
			const reopened = new CanonicalClassicSession({
				runtime: await createCanonicalTestRuntime(),
				projectId: "classic-project",
			});
			try {
				reopened.restore(session.archive());
				expect(reopened.read()).toEqual(edited);
				reopened.undo();
				reopened.redo();
				expect(reopened.read()).toEqual(edited);
			} finally {
				reopened.dispose();
			}
			expect(JSON.stringify(source)).toBe(originalSource);
		} finally {
			if (engine) await closeCaptureSession(engine);
			await host.close();
			session.dispose();
			runtime.free();
			await rmdir(directory);
		}
	},
	120_000,
);
