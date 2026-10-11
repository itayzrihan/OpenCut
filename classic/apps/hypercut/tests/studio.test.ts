import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHypercut } from "../server/app";
import { CanonicalStudio } from "../server/canonical";

test("original Studio file API commits to Rust, rejects stale edits, undoes and survives a host restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypercut-studio-"));
  const host = await createHypercut(dir);
  const base = `/api/projects/${host.canonical.id}`;
  const request = (path: string, init?: RequestInit) => host.app.request(`http://127.0.0.1${path}`, init);
  try {
    const initial = await (await request(`${base}/files/index.html`)).json();
    const content = initial.content.replace("Your next edit starts here.", "שלום היפרקט");
    const save = await request(`${base}/files/index.html`, { method: "PUT", headers: { "If-Match": initial.version }, body: content });
    assert.equal(save.status, 200, await save.text());
    const state = await (await request("/api/hypercut/state")).json();
    assert.equal(state.project.extensions.hypercutStudio.files["index.html"], content);
    const stale = await request(`${base}/files/index.html`, { method: "PUT", headers: { "If-Match": initial.version }, body: "stale" });
    assert.equal(stale.status, 409);
    assert.equal(host.canonical.source().files["index.html"], content);
    const undo = await request(`${base}/history/step`, { method: "POST", body: JSON.stringify({ direction: "back" }) });
    assert.equal(undo.status, 200, await undo.text());
    assert.equal(host.canonical.source().files["index.html"], initial.content);
    host.canonical.close();
    const reopened = new CanonicalStudio(join(dir, "session.json"));
    await reopened.open({ files: {}, assets: {} });
    assert.equal(reopened.history().redo.length, 1);
    reopened.step("redo");
    assert.equal(reopened.source().files["index.html"], content);
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("canonical Studio validation, dry run and rollback prevent divergent file state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypercut-atomic-"));
  const host = await createHypercut(dir);
  const canonical = host.canonical;
  try {
    const before = canonical.snapshot();
    assert.throws(() => canonical.commit({ files: { "index.html": "ok", "../escape": "bad" }, assets: {} }, "invalid"));
    assert.deepEqual(canonical.snapshot(), before);
    assert.throws(() => canonical.commit(canonical.source(), "stale", undefined, 0));
    const input = { projectId: canonical.id, expectedRevision: canonical.revision,
      source: { files: { "index.html": "changed" }, assets: {} }, label: "dry run" };
    canonical.runtime.invokeSync("project.studio.source.commit", input, { dryRun: true });
    assert.deepEqual(canonical.snapshot(), before);
    // Force durable-save failure after a real upstream write, then verify both authorities.
    await rename(join(dir, "session.json"), join(dir, "saved.json"));
    await mkdir(join(dir, "session.json"));
    const base = `http://127.0.0.1/api/projects/${canonical.id}/files/index.html`;
    const current = await (await host.app.request(base)).json();
    const response = await host.app.request(base, { method: "PUT", headers: { "If-Match": current.version }, body: current.content.replace("HyperCut</div>", "Failed</div>") });
    assert.equal(response.status, 500);
    assert.deepEqual(canonical.snapshot(), before);
    assert.equal(await readFile(join(host.projectDir, "index.html"), "utf8"), current.content);
  } finally { canonical.close(); await rm(dir, { recursive: true, force: true }); }
});

test("native upload keeps media bytes out of the canonical history and restores deleted bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypercut-media-"));
  const host = await createHypercut(dir);
  const base = `http://127.0.0.1/api/projects/${host.canonical.id}`;
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=", "base64");
    const data = new FormData(); data.append("files", new Blob([png], { type: "image/png" }), "sample.png");
    const upload = await host.app.request(`${base}/upload`, { method: "POST", body: data });
    assert.equal(upload.status, 201, await upload.text());
    const source = host.canonical.source();
    assert.ok(source.assets["sample.png"]);
    assert.equal(source.files["sample.png"], undefined);
    const replace = await host.app.request(`${base}/files/sample.png`, { method: "PUT", body: "bad" });
    assert.equal(replace.status, 409);
    const remove = await host.app.request(`${base}/files/sample.png`, { method: "DELETE" });
    assert.equal(remove.status, 200);
    const undo = await host.app.request(`${base}/history/step`, { method: "POST", body: JSON.stringify({ direction: "back" }) });
    assert.equal(undo.status, 200);
    assert.deepEqual(await readFile(join(host.projectDir, "sample.png")), png);
  } finally { host.canonical.close(); await rm(dir, { recursive: true, force: true }); }
});
