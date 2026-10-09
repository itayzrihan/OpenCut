/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Real WASM state and isolated renderer fixture. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesRenderHost } from "../render-host";
import { compileHyperframesLayerMove } from "../layer-move-compiler";
import { parseHTML } from "./layer-move-fixture";
import type { TimelineElement } from "@/timeline/types";
import type { HyperframesLayerEdits, HyperframesSource } from "../types";

test.skipIf(
	process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1" ||
		!process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE,
)(
	"moving one source layer shifts GSAP and CSS frames, keeps other occurrences and survives history",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const stateRuntime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: stateRuntime,
			projectId: "classic-project",
		});
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "move-fixture", projectId: "classic-project" };
		const source: HyperframesSource = {
			entryFile: "index.html",
			resourceAssetIds: {},
			files: {
				"index.html": `<!doctype html><html><head><script src="gsap.js"></script><style>html,body{margin:0;background:transparent}.box{position:absolute;top:0;width:60px;height:60px}.letter{width:30px;height:30px;background:lime;animation:fade 2s linear both}@keyframes fade{from{opacity:1}to{opacity:0}}</style></head><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="8"><div id="paint" class="box" data-start="1" data-duration="2" style="background:red"><div class="letter"></div></div><div id="other" class="box" data-start="0" data-duration="8" style="background:blue;left:220px"></div></div><script src="motion.js"></script></body></html>`,
				"gsap.js": readFileSync(
					process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE!,
					"utf8",
				),
				"motion.js":
					"const tl=gsap.timeline({paused:true});tl.to('#paint',{x:100,duration:2,ease:'none'},1);window.__timelines={main:tl};",
			},
		};
		const originalSource = JSON.stringify(source);
		const capture = async ({
			input,
			time,
			edits,
		}: {
			input: HyperframesSource;
			time: number;
			edits?: HyperframesLayerEdits;
		}) => {
			const opened = await host.open({
				scope,
				source: input,
				layerEdits: edits,
				resolveResource: async () => null,
			});
			try {
				const frame = await host.capture({
					scope,
					id: opened.id,
					timeSeconds: time,
				});
				return {
					opened,
					pixels: await sharp(runtime.readArtifact(frame.uri))
						.ensureAlpha()
						.raw()
						.toBuffer(),
				};
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
			const initial = await capture({ input: source, time: 1.5 });
			expect(initial.pixels).not.toEqual(
				(await capture({ input: source, time: 2.5 })).pixels,
			);
			const imported = session.importHyperframes({
				name: "Source layer move",
				source,
				runtimeManifest: initial.opened.runtimeManifest,
			});
			session.insertHyperframes({
				sceneId: classic.document.currentSceneId,
				assetId: imported.assetId,
				name: "Unchanged occurrence",
				startSeconds: 0,
			});
			const layer = initial.opened.runtimeManifest.layers.find(
				(layer) => layer.elementId === "paint",
			)!;
			session.setHyperframesLayerOpacity({
				sceneId: classic.document.currentSceneId,
				elementId: imported.itemId,
				layerKey: layer.key,
				opacity: 0.5,
			});
			const before = session.read();
			const clip = before.document.scenes
				.flatMap((scene) => scene.tracks.overlay)
				.flatMap<TimelineElement>((track) => track.elements)
				.find((element) => element.id === imported.itemId)!;
			const oldEdits = (
				clip as { hyperframesLayerEdits: HyperframesLayerEdits }
			).hyperframesLayerEdits;
			const planInput = {
				source,
				manifest: initial.opened.runtimeManifest,
				layerKey: layer.key,
				startSeconds: 3,
			};
			const plan = session.planHyperframesLayerMove(planInput);
			const scripts = compileHyperframesLayerMove({
				plan,
				document: parseHTML(plan.html).document,
			});
			const updated = session.prepareHyperframesLayerMove({
				...planInput,
				scripts,
			});
			const preflight = await capture({ input: updated, time: 3.5 });
			session.moveHyperframesLayer({
				sceneId: classic.document.currentSceneId,
				elementId: imported.itemId,
				layerKey: layer.key,
				startSeconds: 3,
				sourceFingerprint: plan.sourceFingerprint,
				scripts,
				manifest: preflight.opened.runtimeManifest,
				expectedRevision: session.status().revision,
			});
			const after = session.read();
			const moved = after.document.scenes
				.flatMap((scene) => scene.tracks.overlay)
				.flatMap<TimelineElement>((track) => track.elements)
				.find((element) => element.id === imported.itemId)!;
			const edits = (moved as { hyperframesLayerEdits: HyperframesLayerEdits })
				.hyperframesLayerEdits;
			for (const time of [1.5, 2.5, 1.5]) {
				const original = await capture({
					input: source,
					time,
					edits: oldEdits,
				});
				const changed = await capture({
					input: updated,
					time: time + 2,
					edits,
				});
				expect(changed.pixels).toEqual(original.pixels);
			}
			expect(
				(await capture({ input: updated, time: 1.5, edits })).pixels,
			).toEqual(
				(await capture({ input: source, time: 0.5, edits: oldEdits })).pixels,
			);
			expect(
				after.document.hyperframesCompositions![imported.assetId].source,
			).toEqual(source);
			expect(JSON.stringify(source)).toBe(originalSource);
			session.undo();
			expect(session.read()).toEqual(before);
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

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"moving authored audio preserves media offsets and compound placement",
	async () => {
		const folder = await mkdtemp(join(tmpdir(), "opencut-layer-move-"));
		const path = join(folder, "voice.wav");
		const wav = Buffer.alloc(44 + 6 * 8000 * 2);
		wav.write("RIFF", 0);
		wav.writeUInt32LE(wav.length - 8, 4);
		wav.write("WAVEfmt ", 8);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(8000, 24);
		wav.writeUInt32LE(16000, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(wav.length - 44, 40);
		await writeFile(path, wav);
		const runtime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "move-audio", projectId: "classic-project" };
		const source: HyperframesSource = {
			entryFile: "index.html",
			resourceAssetIds: { "voice.wav": "voice" },
			files: {
				"index.html": `<div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="8"><audio id="voice" src="voice.wav" data-start="1" data-duration="2" data-end="3" data-media-start="0.25" data-playback-rate="2" data-volume="0.5" data-fade-in="0.2"></audio></div>`,
			},
		};
		const resolveResource = async () => ({
			path,
			mimeType: "audio/wav",
			size: wav.length,
		});
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
			const endOnly = {
				...source,
				files: {
					"index.html": source.files["index.html"].replace(
						' data-duration="2"',
						"",
					),
				},
			};
			const endOnlyProbe = await host.open({
				scope,
				source: endOnly,
				resolveResource,
			});
			const endOnlyLayer = endOnlyProbe.runtimeManifest.layers.find(
				(layer) => layer.elementId === "voice",
			)!;
			// Pinned runtime infers this clip to the composition end. Do not
			// silently reinterpret its authored data-end during a move.
			expect(() =>
				session.planHyperframesLayerMove({
					source: endOnly,
					manifest: endOnlyProbe.runtimeManifest,
					layerKey: endOnlyLayer.key,
					startSeconds: 0,
				}),
			).toThrow();
			await host.closeSession({ scope, id: endOnlyProbe.id });
			const original = await host.open({ scope, source, resolveResource });
			const imported = session.importHyperframes({
				name: "Audio move",
				source,
				runtimeManifest: original.runtimeManifest,
				classicResourceAssets: [
					{
						id: "voice",
						name: "voice.wav",
						type: "audio",
						duration: 6,
						storageKind: "copied",
						size: wav.length,
						mimeType: "audio/wav",
					},
				],
			});
			const layer = original.runtimeManifest.layers.find(
				(layer) => layer.elementId === "voice",
			)!;
			expect({ duration: original.durationSeconds, layer }).toMatchObject({
				duration: 8,
				layer: { startSeconds: 1, durationSeconds: 2 },
			});
			const input = {
				source,
				manifest: original.runtimeManifest,
				layerKey: layer.key,
				startSeconds: 3,
			};
			const plan = session.planHyperframesLayerMove(input);
			const scripts = compileHyperframesLayerMove({
				plan,
				document: parseHTML(plan.html).document,
			});
			const updated = session.prepareHyperframesLayerMove({
				...input,
				scripts,
			});
			await host.closeSession({ scope, id: original.id });
			const preflight = await host.open({
				scope,
				source: updated,
				resolveResource,
			});
			session.moveHyperframesLayer({
				sceneId: classic.document.currentSceneId,
				elementId: imported.itemId,
				layerKey: layer.key,
				startSeconds: 3,
				sourceFingerprint: plan.sourceFingerprint,
				scripts,
				manifest: preflight.runtimeManifest,
				expectedRevision: session.status().revision,
			});
			const changed = preflight.runtimeManifest.layers.find(
				(layer) => layer.elementId === "voice",
			)!;
			expect(changed).toMatchObject({
				startSeconds: 3,
				durationSeconds: 2,
				playbackStartSeconds: 0.25,
				playbackRate: 2,
				media: { attributes: { "data-volume": "0.5", "data-fade-in": "0.2" } },
			});
			const beforeAudio = session.readHyperframesAudioClips({
				sceneId: classic.document.currentSceneId,
			});
			expect(beforeAudio.clips).toHaveLength(1);
			session.undo();
			const originalAudio = session.readHyperframesAudioClips({
				sceneId: classic.document.currentSceneId,
			});
			// The outer mixed-audio clip stays on the existing timeline. Its
			// changed source manifest places this child in the generated mix.
			expect(beforeAudio.clips).toEqual(originalAudio.clips);
			expect(
				session.read().document.hyperframesCompositions![imported.assetId]
					.source,
			).toEqual(source);
			session.redo();
			expect(
				session.read().document.hyperframesCompositions![imported.assetId]
					.source,
			).toEqual(updated);
		} finally {
			await host.close();
			runtime.free();
			session.dispose();
			await unlink(path);
			await rmdir(folder);
		}
	},
	90_000,
);
