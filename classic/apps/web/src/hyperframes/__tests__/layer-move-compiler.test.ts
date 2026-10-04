import { expect, test } from "bun:test";
import { parseHTML } from "./layer-move-fixture";
import { parseGsapScriptAcornForWrite } from "@hyperframes/core/gsap-parser-acorn";
import { compileHyperframesLayerMove } from "../layer-move-compiler";
import type { HyperframesLayerMovePlan } from "../types";

const html =
	'<html><body><div id="paint" data-start="3" data-duration="2"><span class="letter">שלום</span></div><div id="other" data-start="0" data-duration="10"></div></body></html>';
function plan(script: string): HyperframesLayerMovePlan {
	return {
		sourceFingerprint: "fixture",
		layerKey: "dom/1/0",
		file: "index.html",
		elementId: "paint",
		startSeconds: 3,
		durationSeconds: 2,
		deltaSeconds: 2,
		localStartSeconds: 3,
		localEndSeconds: null,
		html,
		scripts: [
			{
				key: "motion",
				file: "motion.js",
				content: script,
				startByte: null,
				endByte: null,
			},
		],
	};
}
function compile(script: string) {
	const request = plan(script);
	return compileHyperframesLayerMove({
		plan: request,
		document: parseHTML(request.html).document,
	}).motion;
}

test("moves owned GSAP tweens and untimed children, preserving other layers and initialization", () => {
	const script = `// שלום 😀\r\nconst tl=gsap.timeline({paused:true});\r\ngsap.set('#paint',{opacity:1});\r\ntl.to('.letter',{x:50,duration:1},1);\r\ntl.fromTo('#paint',{x:0},{x:80,duration:2},1.25);\r\ntl.to('#other',{x:10,duration:4},0);`;
	const result = compile(script);
	expect(result).toBe(
		script
			.replace("duration:1},1)", "duration:1},3)")
			.replace("duration:2},1.25)", "duration:2},3.25)"),
	);
	const parsed = parseGsapScriptAcornForWrite(result)!;
	expect(
		parsed.located
			.filter(({ animation }) => !animation.global)
			.map(({ animation }) => animation.position),
	).toEqual([3, 3.25, 0]);
});

test("rejects partially supported timing and shared animation targets before producing edits", () => {
	for (const script of [
		"const tl=gsap.timeline();tl.to('#paint',{x:1},1);tl.to('#other',{x:2},'>');",
		"const tl=gsap.timeline();tl.to('#paint',{x:1},1);tl.to('#other',{x:2});",
		"const tl=gsap.timeline();tl.to('#paint',{x:1},1+0);",
		"const tl=gsap.timeline();tl.to(['#paint','#other'],{x:1},1);",
		"const tl=gsap.timeline();tl.to(window.targets,{x:1},1);",
		"const tl=gsap.timeline();for(let i=0;i<2;i++){tl.to('#paint',{x:i},1);}",
		"const tl=gsap.timeline();const other=gsap.timeline();tl.to('#paint',{x:1},1);other.to('#other',{x:2},1);",
		"gsap.to('#paint',{x:1,duration:2});",
		"hero.to('#paint',{x:1,duration:2},1);",
		"tl.to('#paint',{x:1,duration:2},1);",
		"const tl=gsap.timeline();tl['to']('#paint',{x:1,duration:2},1);",
		"const tl=gsap.timeline();tl.to('#paint',{x:1},1);tl.timeScale(2);",
		"const tl=gsap.timeline({delay:2});tl.to('#paint',{x:1},1);",
		"const tl=gsap.timeline();tl.to('#paint',{x:1},1.000123);",
		"const tl=gsap.timeline();tl.to('#paint',{x:1,onUpdate(){ document.body.style.opacity=0; }},1);",
		"const options={x:1,onComplete:finish};const tl=gsap.timeline();tl.to('#paint',options,1);",
		"document.getElementById('paint').animate([{opacity:0},{opacity:1}],1000);",
	])
		expect(() => compile(script)).toThrow();
});

test("does not execute arbitrary source while reading or compiling it", () => {
	const script =
		"throw new Error('must never execute'); const tl=gsap.timeline();tl.to('#paint',{x:1,duration:1},1);";
	expect(compile(script)).toContain("duration:1},3)");
});
