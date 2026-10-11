import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createStudioApi, PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { CanonicalStudio, type Source } from "./canonical";
import { initialHTML } from "./fixture";
import { digest, materialize, readCandidate } from "./materialization";
import { createCatalog } from "./catalog";
const error = (message: string, status = 409) => Response.json({ error: message }, { status });
const changed = (a: Source, b: Source) => [...new Set([...Object.keys(a.files), ...Object.keys(b.files), ...Object.keys(a.assets), ...Object.keys(b.assets)])].filter(p => a.files[p] !== b.files[p] || JSON.stringify(a.assets[p]) !== JSON.stringify(b.assets[p]));
export async function createHypercut(dataDir: string) {
  const projectDir = join(dataDir, "workspace"), blobs = join(dataDir, "blobs");
  const canonical = new CanonicalStudio(join(dataDir, "session.json"));
  await canonical.open({ files: { "index.html": initialHTML }, assets: {} });
  await materialize(projectDir, blobs, canonical.source());
  // All document reads and candidate writes share this queue. Prepared files
  // cannot become visible until the canonical commit and durable save succeed.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task); tail = result.catch(() => {}); return result;
  }
  const subscribers = new Set<(event: string) => void>();
  const notify = (a: Source, b: Source, token?: string) => {
    for (const path of changed(a, b)) {
      const content = b.files[path];
      const data = JSON.stringify({ projectId: canonical.id, path, affectsPreview: true,
        ...(content === undefined ? {} : { content, version: `"sha256:${digest(content)}"` }), writeToken: token });
      for (const deliver of subscribers) { try { deliver(data); } catch { subscribers.delete(deliver); } }
    }
  };
  const project = () => ({ id: canonical.id, dir: projectDir, title: "HyperCut" });
  const listRegistryCatalog = createCatalog(join(dataDir, "cache", "catalog.json"));
  const upstream = createStudioApi({
    listProjects: () => [project()], resolveProject: id => id === canonical.id ? project() : null,
    bundle: (dir, options) => bundleToSingleHtml(dir, { ...PREVIEW_BUNDLE_OPTIONS, ...options }),
    runtimeUrl: "/hyperframes-runtime.js",
    lint: async html => { const { lintHyperframeHtml } = await import("@hyperframes/core/lint"); return lintHyperframeHtml(html); },
    rendersDir: () => join(dataDir, "renders"),
    startRender: () => { throw new Error("HyperCut export adapter is not connected yet"); },
    getProjectSignature: () => String(canonical.revision),
    listRegistryCatalog,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return c.json({ error: "Loopback host required" }, 403);
    const origin = c.req.header("Origin");
    if (origin && origin !== url.origin) return c.json({ error: "Same-origin requests required" }, 403);
    await next();
  });
  app.get("/hyperframes-runtime.js", c => c.body(getHyperframeRuntimeScript(), 200, { "Content-Type": "text/javascript" }));
  app.get("/api/events", c => streamSSE(c, async stream => {
    const deliver = (data: string) => { void stream.writeSSE({ event: "file-change", data }).catch(() => { subscribers.delete(deliver); }); };
    subscribers.add(deliver); stream.onAbort(() => { subscribers.delete(deliver); });
    try { while (!stream.aborted) { await stream.writeSSE({ event: "heartbeat", data: "{}" }); await stream.sleep(15000); } }
    finally { subscribers.delete(deliver); }
  }));
  app.get("/api/hypercut/state", () => exclusive(async () => Response.json(canonical.snapshot())));
  app.get("/api/hypercut/status", c => c.json({ editor: "@hyperframes/studio/StudioApp", upstream: "0.8.146", canonical: true, featureParity: false }));
  // Catalog network I/O must never hold the editor's save/read queue.
  app.get("/api/registry/blocks", async c => {
    try { return c.json(await listRegistryCatalog()); }
    catch { return c.json({ error: "Catalog is temporarily unavailable; please retry" }, 503); }
  });
  // Presentation only: the canonical registry owns Undo/Redo and its persisted stack.
  const historyView = () => {
    const h = canonical.history(), paths = Object.keys(canonical.source().files);
    const entry = (id: string, label: string, undoes?: string) => ({ id, label,
      who: { kind: "person", name: "You" }, startedAt: canonical.revision + 1, endedAt: canonical.revision + 1,
      files: paths.map(path => ({ path, before: null, after: null })), pinned: false, undone: false, ...(undoes ? { undoes } : {}) });
    const back = h.undo.length > 0 && h.undo[0] !== "Create HyperCut project" ? entry(`back:${canonical.revision}`, h.undo[0]) : null;
    const forward = h.redo.length ? entry(`forward:${canonical.revision}`, h.redo[0], `original:${canonical.revision}`) : null;
    return { entries: [back, forward, forward ? entry(`original:${canonical.revision}`, forward.label) : null].filter(Boolean),
      back: back && { ...back, paths }, forward: forward && { ...forward, paths } };
  };
  app.get("/api/projects/:id/history", c => exclusive(async () => c.req.param("id") === canonical.id ? Response.json(historyView()) : error("Project not found", 404)));
  app.all("/api/projects/:id/history/*", c => exclusive(async () => {
    if (c.req.param("id") !== canonical.id) return error("Project not found", 404);
    const action = c.req.path.split("/").pop(), body = await c.req.json().catch(() => ({}));
    if (action === "claim") return Response.json({ claimed: historyView().back && { id: historyView().back!.id } });
    if (action !== "step" && action !== "undo") return error("This history operation is not connected yet", 501);
    const direction = action === "step" && body.direction === "forward" ? "redo" : "undo";
    const view = historyView(), target = direction === "undo" ? view.back : view.forward;
    if (!target) return Response.json({ ok: true, entry: null });
    if (action === "undo" && body.entryId !== target.id) return error("The project changed before Undo; retry from current history");
    const checkpoint = canonical.checkpoint(), before = canonical.source();
    try {
      canonical.step(direction); await materialize(projectDir, blobs, canonical.source()); await canonical.persist();
      notify(before, canonical.source(), c.req.header("X-Hyperframes-Write-Token"));
      return Response.json({ ok: true, entry: { ...target, id: `applied:${canonical.revision}`, undoes: target.id } });
    } catch (e) { canonical.rollback(checkpoint); await materialize(projectDir, blobs, before); return error(String(e)); }
  }));
  app.all("/api/*", c => exclusive(async () => {
    const url = new URL(c.req.url); url.pathname = url.pathname.slice(4);
    const method = c.req.method, isWrite = !["GET", "HEAD"].includes(method);
    if (isWrite && !/^\/projects\/[^/]+\/(files\/|file-mutations\/|gsap-mutation|duplicate-file$|upload$)/.test(url.pathname)) return error("This operation is not connected to the HyperCut runtime yet", 501);
    const before = canonical.source();
    if (isWrite && url.pathname.includes("/files/")) {
      const path = decodeURIComponent(url.pathname.split("/files/")[1]);
      if (path.split("/").some(part => part.startsWith("."))) return error("Private cache files are not editable project sources", 400);
      if (before.assets[path] && method !== "DELETE") return error("Imported media is immutable; upload a new file");
    }
    const checkpoint = isWrite ? canonical.checkpoint() : null;
    const createdBlobs = new Set<string>();
    try {
      const response = await upstream.fetch(new Request(url, c.req.raw));
      if (!isWrite) return response;
      if (!response.ok) { await materialize(projectDir, blobs, before); return response; }
      const after = await readCandidate(projectDir, blobs, before, createdBlobs);
      if (changed(before, after).length) {
        canonical.commit(after, "Edit in HyperFrames Studio"); await canonical.persist();
        notify(before, after, c.req.header("X-Hyperframes-Write-Token"));
      }
      return response;
    } catch (e) {
      if (checkpoint) {
        canonical.rollback(checkpoint); await materialize(projectDir, blobs, before);
        await Promise.all([...createdBlobs].map(hash => unlink(join(blobs, hash)).catch(() => {})));
      }
      return error(String(e), 500);
    }
  }));
  return { app, canonical, projectDir, close: () => exclusive(async () => canonical.close()) };
}
