import { readFile, writeFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
const [projectArg, outputArg, mode] = process.argv.slice(2);
if (!projectArg || !outputArg || !["undo","redo","reopen"].includes(mode)) throw new Error("Expected QA project, evidence directory and undo/redo/reopen mode");
const directory=await realpath(projectArg), output=resolve(outputArg);
const saved=JSON.parse(await readFile(join(directory,"project.json"),"utf8"));
const projectId=basename(directory), accountId=basename(dirname(dirname(directory)));
assert.equal(saved.metadata.id,projectId);
const bundle=JSON.parse(saved.__opencutEditorSession).saved.bundle;
const checkpoint=JSON.parse(bundle.agentCheckpoint);
assert.equal(checkpoint.run.scope.projectId,projectId); assert.equal(checkpoint.run.scope.accountId,accountId);
const completion=JSON.parse(await readFile(join(output,"completion.json"),"utf8"));
assert.equal(completion.runId,checkpoint.run.scope.runId); assert.equal(checkpoint.run.phase,"completed");
const classic=bundle.archive.classic;
if (mode==="undo") {
  const elements=classic.document.scenes.flatMap(scene=>[scene.tracks.main,...scene.tracks.overlay,...scene.tracks.audio].flatMap(track=>track.elements));
  assert.equal(elements.length,0); assert.equal(classic.mediaAssets.length,0);
  assert.equal(bundle.archive.revision,completion.finalRevision+1);
} else {
  const before=JSON.parse(await readFile(join(output,"canonical-before-history-qa.json"),"utf8"));
  assert.deepEqual(classic,before,"Redo/reopening must restore the exact canonical project content");
  assert.equal(bundle.archive.revision,completion.finalRevision+2);
  assert.equal(checkpoint.run.verifiedRevision,completion.finalRevision);
}
await writeFile(join(output,`${mode}-state.json`),JSON.stringify({projectId,runId:completion.runId,revision:bundle.archive.revision,phase:checkpoint.run.phase,classic},null,2)+"\n");
console.log(JSON.stringify({mode,verified:true,revision:bundle.archive.revision,phase:checkpoint.run.phase}));
