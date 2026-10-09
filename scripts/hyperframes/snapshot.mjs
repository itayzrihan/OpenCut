// Acquisition only: never execute downloaded composition code here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = path.resolve(process.argv[2] || path.join(root, ".local/hyperframes-upstream"));
const commit = process.argv[3];
if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("Pass an exact upstream Git commit SHA");
const destination = path.join(root, "resources/hyperframes");
// A repeat acquisition of the same immutable generation must not erase
// reviewed prompts or costly rendering evidence. A new generation starts clean.
let previous;
try { previous = JSON.parse(await readFile(path.join(destination, "catalog.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const snapshot = path.join(destination, "upstream", commit);
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const tree = git("ls-tree", "-r", commit, "registry", "LICENSE").toString("utf8");
for (const row of tree.trim().split("\n")) {
  if (!/^100644 blob [a-f0-9]+\t(?:registry\/|LICENSE$)/.test(row))
    throw new Error(`Refusing non-regular or unexpected upstream entry: ${row}`);
  safeRelative(row.split("\t")[1]);
}
await mkdir(snapshot, { recursive: true });
const archive = path.join(root, ".local", `hyperframes-${commit}.tar`);
git("archive", "--format=tar", `--output=${archive}`, commit, "registry", "LICENSE");
execFileSync("tar", ["-xf", archive, "-C", snapshot], { windowsHide: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const registryBytes = await readFile(path.join(snapshot, "registry/registry.json"));
const registry = JSON.parse(registryBytes);
const folder = { "hyperframes:block": "blocks", "hyperframes:component": "components", "hyperframes:example": "examples" };
const items = [];
const names = new Set();
for (const reference of registry.items) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(reference.name) || !folder[reference.type] || names.has(reference.name))
    throw new Error("Invalid or duplicate registry identity");
  names.add(reference.name);
  const prefix = `registry/${folder[reference.type]}/${reference.name}`;
  const manifest = JSON.parse(await readFile(path.join(snapshot, prefix, "registry-item.json"), "utf8"));
  if (manifest.name !== reference.name || manifest.type !== reference.type) throw new Error(`Manifest identity mismatch: ${reference.name}`);
  const files = [];
  for (const relative of await walk(path.join(snapshot, prefix))) {
    safeRelative(relative);
    const bytes = await readFile(path.join(snapshot, prefix, relative));
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  const missingDeclaredFiles = [];
  for (const file of manifest.files || []) {
    safeRelative(file.path);
    if (file.target) safeRelative(file.target);
    if (!files.some((saved) => saved.path === file.path)) missingDeclaredFiles.push(file.path);
  }
  items.push({
    id: reference.name, kind: reference.type.split(":")[1],
    title: manifest.title || reference.name, description: manifest.description || "",
    tags: manifest.tags || [], dimensions: manifest.dimensions || null,
    durationSeconds: manifest.duration || null, parameters: manifest.params || [], variables: manifest.variables || null,
    registryDependencies: manifest.registryDependencies || [],
    sourcePath: `upstream/${commit}/${prefix}`,
    sourceUrl: `https://github.com/heygen-com/hyperframes/tree/${commit}/${prefix}`,
    manifestSha256: files.find((file) => file.path === "registry-item.json").sha256,
    files, declaredFiles: manifest.files || [], preview: manifest.preview || null,
    licensePaths: ["LICENSE", ...files.filter((file) => /(?:license|notice)/i.test(file.path)).map((file) => `${prefix}/${file.path}`)],
    prompt: typeof manifest.sourcePrompt === "string" && manifest.sourcePrompt.trim()
      ? { status: "original", text: manifest.sourcePrompt, provenance: { upstreamCommit: commit, path: `${prefix}/registry-item.json`, field: "sourcePrompt", manifestSha256: files.find((file) => file.path === "registry-item.json").sha256 } }
      : { status: "unreviewed", text: null, provenance: null },
    popularity: null,
    verification: { status: "captured", missingDeclaredFiles, dependencyClosure: false, preview: false, import: false, reopen: false, transparentOverlay: null },
  });
}
items.sort((a, b) => a.id.localeCompare(b.id, "en"));
if (previous?.upstreamCommit === commit) {
  for (const item of items) {
    const saved = previous.items.find((candidate) => candidate.id === item.id);
    if (!saved || saved.manifestSha256 !== item.manifestSha256 || JSON.stringify(saved.files) !== JSON.stringify(item.files)) continue;
    if (saved.prepared) item.prepared = saved.prepared;
    if (saved.review) item.review = saved.review;
    if (item.prompt.status !== "original" && saved.prompt?.status === "reconstructed") item.prompt = saved.prompt;
    item.verification = saved.verification;
  }
}
const catalog = {
  schemaVersion: 1, upstreamCommit: commit,
  registryUrl: `https://raw.githubusercontent.com/heygen-com/hyperframes/${commit}/registry/registry.json`,
  registrySha256: digest(registryBytes),
  acceptance: { minimumVerified: 150, minimumBlocks: 50, minimumComponents: 50 }, items,
};
await writeFile(path.join(destination, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(JSON.stringify({ commit, captured: items.length, kinds: Object.fromEntries(Object.keys(folder).map((type) => [type, items.filter((item) => item.kind === type.split(":")[1]).length])), missingDeclaredFiles: items.filter((item) => item.verification.missingDeclaredFiles.length).map((item) => item.id), verified: 0 }));

function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid relative path: ${value}`);
}
async function walk(directory, prefix = "") {
  const paths = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) paths.push(...await walk(path.join(directory, item.name), `${relative}/`));
    else if (item.isFile()) {
      if ((await stat(path.join(directory, item.name))).size > 32 * 1024 * 1024) throw new Error(`Oversized item ${relative}`);
      paths.push(relative);
    } else throw new Error(`Unsupported entry ${relative}`);
  }
  return paths.sort();
}
