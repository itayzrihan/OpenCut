/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Real WASM fixture and isolated browser protocols. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesRenderHost } from "../render-host";
import type { HyperframesSource } from "../types";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"source edits remeasure geometry and render changed HTML, CSS and JavaScript with undo",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const stateRuntime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: stateRuntime,
			projectId: "classic-project",
		});
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "source-test", projectId: "classic-project" };
		const source: HyperframesSource = {
			entryFile: "index.html",
			resourceAssetIds: {},
			files: {
				"index.html":
					'<html><head><link rel="stylesheet" href="style.css"></head><body><div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4"><div id="paint"></div></div><script src="motion.js"></script></body></html>',
				"style.css":
					"body{margin:0}#paint{position:absolute;top:0;width:80px;height:80px;background:#ff0000}",
				"motion.js": 'document.getElementById("paint").style.left="0px";',
			},
		};
		const unchanged = JSON.stringify(source);
		const capture = async (input: HyperframesSource) => {
			const opened = await host.open({
				scope,
				source: input,
				resolveResource: async () => null,
			});
			try {
				const artifact = await host.capture({
					scope,
					id: opened.id,
					timeSeconds: 1,
				});
				const frame = await sharp(runtime.readArtifact(artifact.uri))
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				return { opened, frame };
			} finally {
				await host.closeSession({ scope, id: opened.id });
			}
		};
		try {
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
			const original = await capture(source);
			const imported = session.importHyperframes({
				name: "Editable source",
				source,
				runtimeManifest: original.opened.runtimeManifest,
			});
			const before = session.read();
			const changes = {
				"index.html": source.files["index.html"].replace(
					'data-width="320"',
					'data-width="640"',
				),
				"style.css": source.files["style.css"].replace("#ff0000", "#00ff00"),
				"motion.js": source.files["motion.js"].replace("0px", "40px"),
			};
			const prepared = session.prepareHyperframesSource({ source, changes });
			const changed = await capture(prepared.source);
			session.setHyperframesSource({
				sceneId: classic.document.currentSceneId,
				elementId: imported.itemId,
				changes,
				sourceFingerprint: prepared.sourceFingerprint,
				manifest: changed.opened.runtimeManifest,
				expectedRevision: session.status().revision,
			});
			const after = session.read();
			expect(changed.frame.info.width).toBe(640);
			expect(changed.frame.info.height).toBe(180);
			const sample = ({
				frame,
				x,
			}: {
				frame: typeof original.frame;
				x: number;
			}) =>
				Array.from(
					frame.data.subarray(
						(10 * frame.info.width + x) * 4,
						(10 * frame.info.width + x) * 4 + 4,
					),
				);
			expect(sample({ frame: original.frame, x: 10 })).toEqual([
				255, 0, 0, 255,
			]);
			expect(sample({ frame: changed.frame, x: 50 })).toEqual([0, 255, 0, 255]);
			expect(sample({ frame: changed.frame, x: 10 })[3]).toBe(0);
			expect(
				after.document.hyperframesCompositions![imported.assetId].width,
			).toBe(640);
			expect(JSON.stringify(source)).toBe(unchanged);
			session.undo();
			expect(session.read()).toEqual(before);
			const restored = await capture(
				session.read().document.hyperframesCompositions![imported.assetId]
					.source,
			);
			expect(restored.frame.data).toEqual(original.frame.data);
			session.redo();
			expect(session.read()).toEqual(after);
		} finally {
			await host.close();
			runtime.free();
			session.dispose();
		}
	},
	120_000,
);
