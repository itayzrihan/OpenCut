import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdir, open, unlink, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHypercut } from "./app";
const dataDir = resolve(process.env.HYPERCUT_DATA_DIR ?? ".data");
await mkdir(dataDir, { recursive: true });
const lockPath = join(dataDir, "host.lock");
async function acquire() {
  try { return await open(lockPath, "wx", 0o600); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid HyperCut host lock");
    try { process.kill(pid, 0); throw new Error(`HyperCut is already running (PID ${pid})`); }
    catch (e: any) { if (e.code !== "ESRCH") throw e; }
    await unlink(lockPath); return open(lockPath, "wx", 0o600);
  }
}
const lock = await acquire(); await lock.writeFile(String(process.pid));
const { app, close: closeRuntime } = await createHypercut(dataDir);
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));
const port = Number(process.env.HYPERCUT_PORT ?? 3220);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => console.log(`HyperCut — original HyperFrames Studio: http://127.0.0.1:${port}`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close(); await closeRuntime(); await lock.close(); await unlink(lockPath); process.exit(0);
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
