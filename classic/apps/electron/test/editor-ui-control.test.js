import { test,expect } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir,writeFile } from "node:fs/promises";
const require=createRequire(import.meta.url);
test("production UI adapter and preload operate through scoped owned Electron Playwright",async()=>{
	const bundle=await Bun.build({ entrypoints:[fileURLToPath(new URL("../../web/src/editor-agent/__tests__/ui-control-browser-fixture.ts",import.meta.url))],target:"browser",format:"esm" });if(!bundle.success)throw new Error(bundle.logs.join("\n"));
	const dir=fileURLToPath(new URL("../../../../.local/editor-ui-control/",import.meta.url));await mkdir(dir,{recursive:true});
	const bundlePath=`${dir}electron-${Date.now()}.mjs`;await writeFile(bundlePath,await bundle.outputs[0].text());
	const env={...process.env,OPENCUT_UI_TEST_BUNDLE:bundlePath};delete env.ELECTRON_RUN_AS_NODE;
	const result=await new Promise((resolve,reject)=>{
		const child=spawn(require("electron"),[fileURLToPath(new URL("./editor-ui-control-fixture.cjs",import.meta.url))],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="";
		const timer=setTimeout(()=>{child.kill();reject(new Error(`Electron UI control timed out\n${output}`));},45000);
		child.stdout.on("data",data=>output+=data);child.stderr.on("data",data=>output+=data);
		child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",code=>{clearTimeout(timer);resolve({code,output});});
	});
	expect(result.output).toContain('"type":"editor-ui-control-pass"');expect(result.code).toBe(0);
},50000);
