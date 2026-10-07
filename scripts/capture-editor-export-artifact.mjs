// Read-only recovery of a scoped persisted ArtifactStore export for external QA.
// Does not claim that Chrome downloaded it, and never exports provider context.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const [projectDirectoryArg, outputDirectoryArg] = process.argv.slice(2);
if (!projectDirectoryArg || !outputDirectoryArg) throw new Error("Expected owned project directory and QA output directory");
const directory = await realpath(projectDirectoryArg);
const project = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
const projectId = basename(directory), accountId = basename(dirname(dirname(directory)));
if (project.metadata.id !== projectId) throw new Error("Project directory identity differs");
const session = JSON.parse(project.__opencutEditorSession);
const bundle = session.saved.bundle;
const checkpoint = JSON.parse(bundle.agentCheckpoint);
const saved = bundle.artifacts, conversation = bundle.conversation;
for (const scope of [checkpoint.run.scope, saved, conversation]) {
  if (scope?.accountId !== accountId || scope?.projectId !== projectId) throw new Error("Persisted export belongs to another scope");
}
const entry = conversation.entries.findLast((item) => item.export);
if (!entry) throw new Error("No persisted conversation export");
const artifact = saved.archive.items.find((item) => item.metadata.id === entry.export.artifactId);
if (!artifact || artifact.metadata.mimeType !== "video/webm" || artifact.metadata.byteSize > 64 * 1024 * 1024 || artifact.dataBase64.length > 90_000_000) throw new Error("Export is unavailable or exceeds the artifact bound");
const bytes = Buffer.from(artifact.dataBase64, "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (bytes.length !== artifact.metadata.byteSize || sha256 !== artifact.metadata.sha256) throw new Error("Persisted export checksum differs");
const output = resolve(outputDirectoryArg);
await mkdir(output, { recursive: true });
await writeFile(join(output, "artifact-store-export.webm"), bytes);
await writeFile(join(output, "delivery.json"), JSON.stringify({ projectId, runId: checkpoint.run.scope.runId, artifactId: artifact.metadata.id, sha256, byteSize: bytes.length, inputProvenance: "persistedArtifactStore", browserDownloadVerified: false }, null, 2) + "\n");
console.log(JSON.stringify({ artifactId: artifact.metadata.id, sha256, byteSize: bytes.length, browserDownloadVerified: false }));
