/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Real WASM and isolated renderer integration fixtures. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesRenderHost } from "../render-host";
import { compileHyperframesLayerMove } from "../layer-move-compiler";
import type { HyperframesSource } from "../types";

const enabled =
	process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS === "1" &&
	!!process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE;
function source(extra = ""): HyperframesSource {
	return {
		entryFile: "index.html",
		resourceAssetIds: {},
		files: {
			"gsap.js": readFileSync(
				process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE!,
				"utf8",
			),
			"index.html": `<!doctype html><html><head><script src="gsap.js"></script><style>html,body{margin:0;background:transparent}.box{position:absolute;top:20px;width:40px;height:40px}.inner{width:20px;height:20px;background:lime;animation:fade 2s linear both}@keyframes fade{from{opacity:1}to{opacity:0}}</style></head><body><div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="8"></div><script>
const tl=gsap.timeline({paused:true});
for(const [id,start,duration,color,left] of [['paint',1,2,'red',0],['other',0,8,'blue',240]]){
 const node=document.createElement('div');node.id=id;node.className='box';node.dataset.start=start;node.dataset.duration=duration;node.style.background=color;node.style.left=left+'px';document.getElementById('root').appendChild(node);
 tl.set(node,{opacity:0},0);tl.set(node,{opacity:1},start);tl.to(node,{x:40,duration,ease:'none'},start);tl.set(node,{opacity:0},start+duration);
 if(id==='paint'){const inner=document.createElement('div');inner.className='inner';node.appendChild(inner);tl.fromTo(inner,{scale:0},{scale:1,duration:.7,immediateRender:false},start+.2);}
}
${extra}
window.__timelines={main:tl};window.__seekRender=t=>tl.pause().seek(t,false);
</script></body></html>`,
		},
	};
}

test.skipIf(!enabled)(
	"generated GSAP layers move through canonical history, render with CSS and retain independent occurrences",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		const host = new HyperframesRenderHost(runtime),
			scope = { accountId: "generated-move", projectId: "classic-project" };
		const original = source();
		const capture = async ({
			input,
			time,
		}: {
			input: HyperframesSource;
			time: number;
		}) => {
			const opened = await host.open({
				scope,
				source: input,
				resolveResource: async () => null,
			});
			try {
				const frame = await host.capture({
					scope,
					id: opened.id,
					timeSeconds: time,
				});
				const bytes = runtime.readArtifact(frame.uri);
				const forward = await host.capture({
					scope,
					id: opened.id,
					timeSeconds: time + 0.3,
				});
				const reverse = await host.capture({
					scope,
					id: opened.id,
					timeSeconds: time,
				});
				expect(reverse.sha256).toBe(frame.sha256);
				runtime.removeArtifact(forward.uri);
				runtime.removeArtifact(reverse.uri);
				const left = await sharp(bytes)
					.extract({ left: 0, top: 0, width: 180, height: 180 })
					.raw()
					.toBuffer();
				const right = await sharp(bytes)
					.extract({ left: 180, top: 0, width: 140, height: 180 })
					.raw()
					.toBuffer();
				runtime.removeArtifact(frame.uri);
				return { manifest: opened.runtimeManifest, left, right };
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
			const initial = await capture({ input: original, time: 1.5 });
			const imported = session.importHyperframes({
				name: "Generated scene",
				source: original,
				runtimeManifest: initial.manifest,
			});
			const sceneId = classic.document.currentSceneId;
			session.insertHyperframes({
				sceneId,
				assetId: imported.assetId,
				name: "Independent occurrence",
				startSeconds: 0,
			});
			const before = session.read();
			const layer = initial.manifest.layers.find(
				(layer) => layer.elementId === "paint",
			)!;
			const input = {
				source: original,
				manifest: initial.manifest,
				layerKey: layer.key,
				startSeconds: 3,
			};
			const plan = session.planHyperframesLayerMove(input);
			expect(plan.generated).toBe(true);
			expect(
				plan.scripts.find((script) => script.file === "gsap.js")
					?.runtimeLibrary,
			).toBe(true);
			const scripts = compileHyperframesLayerMove({ plan });
			const updated = session.prepareHyperframesLayerMove({
				...input,
				scripts,
			});
			const moved = await capture({ input: updated, time: 3.5 });
			expect(moved.left).toEqual(initial.left);
			expect(moved.right).toEqual(
				(await capture({ input: original, time: 3.5 })).right,
			);
			session.moveHyperframesLayer({
				sceneId,
				elementId: imported.itemId,
				layerKey: layer.key,
				startSeconds: 3,
				sourceFingerprint: plan.sourceFingerprint,
				scripts,
				manifest: moved.manifest,
				expectedRevision: session.status().revision,
			});
			const after = session.read();
			expect(
				after.document.hyperframesCompositions![imported.assetId].source,
			).toEqual(original);
			expect(updated.files["gsap.js"]).toBe(original.files["gsap.js"]);
			expect(updated.files["index.html"]).toContain(
				original.files["index.html"].split("</body>")[0],
			);
			for (const time of [2.5, 1.5]) {
				expect(
					(await capture({ input: updated, time: time + 2 })).left,
				).toEqual((await capture({ input: original, time })).left);
			}
			const repeatedInput = {
				source: updated,
				manifest: moved.manifest,
				layerKey: layer.key,
				startSeconds: 1.2,
			};
			const secondPlan = session.planHyperframesLayerMove(repeatedInput);
			const second = session.prepareHyperframesLayerMove({
				...repeatedInput,
				scripts: compileHyperframesLayerMove({ plan: secondPlan }),
			});
			expect((await capture({ input: second, time: 1.7 })).left).toEqual(
				initial.left,
			);
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

test.skipIf(!enabled)(
	"generated retiming rejects mixed ownership, callbacks and off-timeline animation at runtime preflight",
	async () => {
		const runtime = await createCanonicalTestRuntime(),
			host = new HyperframesRenderHost(runtime);
		const session = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		const scope = {
			accountId: "generated-invalid",
			projectId: "classic-project",
		};
		try {
			for (const extra of [
				"tl.to(['#paint','#other'],{y:20,duration:1},1);",
				"tl.call(()=>document.getElementById('paint').style.opacity='0',[],1.5);",
				"tl.to('#paint',{y:10,duration:1,onUpdate(){document.getElementById('other').style.opacity='0'}},1);",
				"gsap.to('#paint',{y:40,duration:4});",
				"tl.to('#paint',{x:()=>tl.time()*10,duration:1},1);",
			]) {
				const inputSource = source(extra);
				const opened = await host.open({
					scope,
					source: inputSource,
					resolveResource: async () => null,
				});
				await host.closeSession({ scope, id: opened.id });
				const layer = opened.runtimeManifest.layers.find(
					(layer) => layer.elementId === "paint",
				)!;
				const input = {
					source: inputSource,
					manifest: opened.runtimeManifest,
					layerKey: layer.key,
					startSeconds: 3,
				};
				const plan = session.planHyperframesLayerMove(input);
				const updated = session.prepareHyperframesLayerMove({
					...input,
					scripts: compileHyperframesLayerMove({ plan }),
				});
				await expect(
					host.open({
						scope,
						source: updated,
						resolveResource: async () => null,
					}),
				).rejects.toThrow(/HyperFrames layer move/);
			}
		} finally {
			await host.close();
			runtime.free();
			session.dispose();
		}
	},
	120_000,
);
