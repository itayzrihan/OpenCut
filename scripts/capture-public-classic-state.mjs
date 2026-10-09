// Bounded public fixture/state evidence, excluding agent/provider/session state.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg || !outputArg) throw new Error("Expected project directory and evidence file");
const directory=await realpath(projectArg), project=JSON.parse(await readFile(join(directory,"project.json"),"utf8"));
const projectId=basename(directory); assert.equal(project.metadata.id,projectId);
const bundle=JSON.parse(project.__opencutEditorSession).saved.bundle;
assert.equal(bundle.archive.classic.document.metadata.id,projectId);
const publicState={projectId,revision:bundle.archive.revision,classic:bundle.archive.classic};
await mkdir(dirname(resolve(outputArg)),{recursive:true});
await writeFile(resolve(outputArg),JSON.stringify(publicState,null,2)+"\n");
console.log(JSON.stringify({projectId,revision:publicState.revision}));
