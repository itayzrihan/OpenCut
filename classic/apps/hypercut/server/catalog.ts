import type { RegistryItem } from "@hyperframes/core/registry";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const REGISTRY = "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 10 * 1024 * 1024;
type Cache = { fetchedAt: number; items: RegistryItem[] };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object";
function item(v: unknown): v is RegistryItem {
  return record(v) && typeof v.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v.name)
    && ["hyperframes:block", "hyperframes:component"].includes(v.type)
    && typeof v.title === "string" && typeof v.description === "string"
    && (v.tags === undefined || (Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === "string")))
    && Array.isArray(v.files) && (!v.preview || (record(v.preview)
      && [v.preview.poster, v.preview.video].every(p => p === undefined || typeof p === "string")));
}

/** Read-only public catalog metadata; never writes project state or installs files. */
export function createCatalog(cachePath: string, fetcher: typeof fetch = fetch, now = Date.now) {
  let cache: Cache | undefined;
  let pending: Promise<RegistryItem[]> | undefined;
  let retryAfter = 0;
  async function json(url: string) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Catalog response is empty");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > LIMIT) throw new Error("Catalog response exceeds size limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async function refresh() {
    try {
      const manifest = await json(`${REGISTRY}/registry.json`);
      if (!record(manifest) || !Array.isArray(manifest.items) || manifest.items.length > 4096)
        throw new Error("Invalid catalog manifest");
      const entries = manifest.items.filter((e: any) => record(e) && ["hyperframes:block", "hyperframes:component"].includes(e.type));
      if (!entries.length || entries.some((e: any) => typeof e.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e.name)))
        throw new Error("Invalid catalog entries");
      const items: RegistryItem[] = new Array(entries.length); let next = 0;
      const results = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (next < entries.length) {
          const i = next++, entry = entries[i];
          const dir = entry.type === "hyperframes:block" ? "blocks" : "components";
          const value = await json(`${REGISTRY}/${dir}/${entry.name}/registry-item.json`);
          if (!item(value) || value.name !== entry.name || value.type !== entry.type) throw new Error("Invalid catalog item");
          items[i] = value;
        }
      }));
      const failure = results.find(r => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      cache = { fetchedAt: now(), items };
      // Disk cache is optional: a read-only cache directory must not hide the catalog.
      try { await mkdir(dirname(cachePath), { recursive: true }); await writeFile(`${cachePath}.pending`, JSON.stringify(cache)); await rename(`${cachePath}.pending`, cachePath); } catch {}
      return items;
    } catch (e) { retryAfter = now() + 60000; if (cache) return cache.items; throw e; }
  }
  return async function list(): Promise<RegistryItem[]> {
    if (!cache) {
      try {
        const saved = JSON.parse(await readFile(cachePath, "utf8"));
        if (Number.isFinite(saved.fetchedAt) && Array.isArray(saved.items) && saved.items.length && saved.items.every(item)) cache = saved;
      } catch {}
    }
    if (cache && now() - cache.fetchedAt < TTL) return cache.items;
    if (cache && now() < retryAfter) return cache.items;
    pending ??= refresh().finally(() => { pending = undefined; });
    if (cache) { void pending.catch(() => {}); return cache.items; }
    return pending;
  };
}
