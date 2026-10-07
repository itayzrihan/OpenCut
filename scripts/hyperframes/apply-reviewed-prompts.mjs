// Only IDs with explicitly authored prompts are projected. Source and sampled
// frames are pinned in the provenance; this never marks a package verified.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const resources = path.join(root, "resources/hyperframes");
const filename = path.join(resources, "reconstructed-prompts.json");
const promptBytes = await readFile(filename);
const prompts = JSON.parse(promptBytes);
const catalog = JSON.parse(await readFile(path.join(resources, "catalog.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (prompts.upstreamCommit !== catalog.upstreamCommit) throw new Error("Prompt generation differs");
let applied = 0;
for (const [id, text] of Object.entries(prompts.prompts)) {
  const item = catalog.items.find((candidate) => candidate.id === id);
  if (!item?.prepared || typeof text !== "string" || text.length < 100) throw new Error(`No prepared evidence or substantive prompt: ${id}`);
  if (item.prompt.status === "original") throw new Error(`Never replace an original prompt: ${id}`);
  const previous = item.prompt.provenance;
  if (previous?.sourceSha256 && previous.sourceSha256 !== item.prepared.sourceSha256) throw new Error(`Source changed since prompt review: ${id}`);
  const directory = path.join(resources, item.prepared.sourcePath);
  const source = await readFile(path.join(directory, "evidence/source.json"));
  if (digest(source) !== item.prepared.sourceSha256) throw new Error(`Source evidence differs: ${id}`);
  for (const frame of item.prepared.evidence.frames) {
    if (digest(await readFile(path.join(directory, frame.file))) !== frame.sha256) throw new Error(`Frame evidence differs: ${id}`);
  }
  item.prompt = { status: "reconstructed", text, provenance: {
    label: prompts.label, author: prompts.author, basis: prompts.basis,
    upstreamCommit: catalog.upstreamCommit, manifestSha256: item.manifestSha256,
    sourceSha256: item.prepared.sourceSha256, promptSha256: digest(text),
    frames: item.prepared.evidence.frames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })),
    reviewScope: "sampledFramesAndSource", generatedVideoEquivalence: "notGuaranteed",
  } };
  applied++;
}
await writeFile(path.join(resources, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(JSON.stringify({ reconstructedPrompts: applied, originalPromptsPreserved: catalog.items.filter((item) => item.prompt.status === "original").length }));
