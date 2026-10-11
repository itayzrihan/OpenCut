import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCatalog } from "../server/catalog";

test("catalog shares cold requests, caches metadata and remains available offline after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypercut-catalog-"));
  try {
    const entry = { name: "sample", type: "hyperframes:block" };
    const block = { ...entry, title: "Sample", description: "A sample", tags: ["social"], files: [], dimensions: { width: 1920, height: 1080 }, duration: 5 };
    let calls = 0;
    const fetcher: typeof fetch = async url => {
      calls++;
      return Response.json(String(url).endsWith("/registry.json") ? { items: [entry, { name: "example", type: "hyperframes:example" }] } : block);
    };
    const cache = join(dir, "catalog.json");
    const list = createCatalog(cache, fetcher, () => 1000);
    const both = await Promise.all([list(), list()]);
    assert.deepEqual(both, [[block], [block]]);
    assert.equal(calls, 2);
    assert.deepEqual(await list(), [block]); assert.equal(calls, 2);
    const offline = createCatalog(cache, async () => { throw new Error("Offline"); }, () => 1000 + 2 * 86400000);
    assert.deepEqual(await offline(), [block]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("catalog rejects unsafe registry paths and permits retry after cold failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypercut-catalog-"));
  try {
    let calls = 0;
    const list = createCatalog(join(dir, "catalog.json"), async () => {
      calls++;
      return Response.json({ items: [{ name: "../private", type: "hyperframes:block" }] });
    });
    await assert.rejects(list(), /Invalid catalog entries/);
    await assert.rejects(list(), /Invalid catalog entries/);
    assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
