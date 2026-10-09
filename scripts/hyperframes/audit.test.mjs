import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("library acceptance rejects altered source, prompt and certification counts", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(root, ".local/hyperframes-audit-"));
  await cp(path.join(root, "resources/hyperframes"), directory, { recursive: true });
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts/hyperframes/audit.mjs"), `--root=${directory}`, "--acceptance"], { encoding: "utf8", timeout: 300000, windowsHide: true });
  const baseline = run();
  assert.equal(baseline.status, 0, String(baseline.error ?? baseline.stderr));
  const catalogPath = path.join(directory, "catalog.json");
  const catalogBytes = await readFile(catalogPath);
  const catalog = JSON.parse(catalogBytes);
  const item = catalog.items.find((entry) => entry.verification.status === "verified");
  const entryPath = path.join(directory, item.prepared.sourcePath, item.prepared.entryFile);
  const entryBytes = await readFile(entryPath);
  await writeFile(entryPath, Buffer.concat([entryBytes, Buffer.from("<!-- unexpected edit -->")]));
  assert.notEqual(run().status, 0, "Altered prepared HTML must not retain acceptance");
  await writeFile(entryPath, entryBytes);
  item.prompt.text += " unreviewed instruction";
  await writeFile(catalogPath, JSON.stringify(catalog));
  assert.notEqual(run().status, 0, "Altered reconstructed prompts must be reviewed again");
  await writeFile(catalogPath, catalogBytes);
  const certificationPath = path.join(directory, "certification.json");
  const certification = JSON.parse(await readFile(certificationPath, "utf8"));
  certification.counts.total = 149;
  await writeFile(certificationPath, JSON.stringify(certification));
  assert.notEqual(run().status, 0, "A catalog flag is insufficient without matching certification");
  // Keep the isolated fixture as diagnostic evidence; never touch the source tree.
});
