// Uses only saved public conversation/tool activity and canonical content.
import { readFile, writeFile, realpath, mkdir } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import assert from "node:assert/strict";
const [projectArg, folderArg]=process.argv.slice(2);
if(!projectArg||!folderArg)throw new Error("Expected QA project and evidence directory");
const directory=await realpath(projectArg),folder=resolve(folderArg),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8"));assert.equal(project.metadata.id,projectId);
const bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,cp=JSON.parse(bundle.agentCheckpoint);
assert.equal(cp.run.scope.projectId,projectId);assert.equal(cp.run.scope.accountId,accountId);assert.equal(bundle.conversation.accountId,accountId);
assert.equal(cp.run.phase,"completed");
const baseline=JSON.parse(await readFile(join(folder,"rerun-baseline.json"),"utf8"));
assert.equal(baseline.projectId,projectId);assert.equal(bundle.archive.revision,baseline.revision);assert.deepEqual(bundle.archive.classic,baseline.classic);
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8"));
const task=manifest.tasks.find(task=>task.id==="en-ui-navigation");
const users=bundle.conversation.entries.filter(entry=>entry.kind==="user");assert.equal(users.length,1);assert.equal(users[0].text,task.prompt);
const activities=bundle.conversation.entries.flatMap(entry=>entry.activities??[]).filter(activity=>activity.ok && activity.input.action==="invoke" && ["editor.ui.snapshot","editor.ui.control"].includes(activity.input.id));
const snapshots=activities.filter(activity=>activity.input.id==="editor.ui.snapshot");
const clicks=activities.filter(activity=>activity.input.id==="editor.ui.control");assert.equal(clicks.length,2);assert.ok(snapshots.length>=3);
for(const activity of activities) {assert.equal(activity.input.input.projectId,projectId);assert.equal(activity.output.result.result.data.projectId,projectId);}
const clicked=[];
for(const click of clicks) {
  assert.equal(click.input.input.gesture.type,"click");
  const source=snapshots.find(snapshot=>snapshot.output.result.result.data.snapshotId===click.input.input.snapshotId);
  assert.ok(source);const node=source.output.result.result.data.nodes.find(node=>node.targetId===click.input.input.targetId);assert.ok(node);clicked.push(node);
}
await mkdir(folder,{recursive:true});
const report={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:cp.run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(entry=>entry.kind==="round"&&!entry.review).length,autonomous:true,manualRepairs:0,outcome:"completed",claimedSuccess:false,finalRevision:bundle.archive.revision,documentUnchanged:true,clickedTargets:clicked,activities,finalMessage:cp.run.finalMessage,limitation:"This verifies scoped navigation and inspection, not full text-feature/UI coverage. The agent reported no text-specific controls exposed in its filtered snapshot."};
await writeFile(join(folder,"completion.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({phase:report.outcome,documentUnchanged:true,clicks:clicked.map(node=>node.label??node.name??node.text),snapshots:snapshots.length}));
