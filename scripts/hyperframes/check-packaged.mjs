// Exercise the actual standalone HTTP route with two isolated real local
// accounts. No sessions, passwords or user data leave this local test host.
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const build = path.resolve(process.argv[2] || path.join(root, "classic/apps/web/.next-hyperframes-acceptance"));
const web = path.join(build, "standalone/apps/web");
const output = path.join(root, ".local/hyperframes-packaged", randomUUID());
await mkdir(output, { recursive: true });
const catalog = JSON.parse(await readFile(path.join(web, ".hyperframes-references/catalog.json"), "utf8"));
execFileSync(process.execPath, [path.join(root, "scripts/hyperframes/audit.mjs"), `--root=${path.join(web, ".hyperframes-references")}`, "--acceptance"], { stdio: "inherit" });
// Electron's extraResources copies public beside the standalone server. Reuse
// that exact public preview output for this isolated HTTP packaging check.
await cp(path.join(root, "classic/apps/web/public/hyperframes-reference-previews"), path.join(web, "public/hyperframes-reference-previews"), { recursive: true });
const project = JSON.parse(await readFile(path.join(root, "crates/editor-api/tests/fixtures/classic-project.json"), "utf8")).document;
const port = 43219, origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(web, "server.js")], { cwd: web, windowsHide: true, env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", OPENCUT_ACCOUNTS_DIR: path.join(output, "accounts") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); });
child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); });
const checks = [];
async function post(route, body, account, expected = 200, expectedAccount) {
  const response = await fetch(`${origin}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(account && { Cookie: account.cookie, "X-OpenCut-Account": expectedAccount ?? account.id }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (response.status !== expected) throw new Error(`${route}: expected ${expected}, got ${response.status}: ${JSON.stringify(result)}`);
  return { result, response };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Packaged host exited before ready");
    try { ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) throw new Error("Packaged host did not become ready");
  let previewsChecked = 0;
  for (const item of catalog.items.filter((item) => item.verification.status === "verified")) {
    const frame = item.prepared.evidence.frames[1];
    const response = await fetch(`${origin}/hyperframes-reference-previews/${frame.sha256}.png`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || createHash("sha256").update(bytes).digest("hex") !== frame.sha256) throw new Error(`Missing or altered packaged preview: ${item.id}`);
    previewsChecked++;
  }
  if (previewsChecked < 150) throw new Error("Packaged library is incomplete");
  checks.push("all150PreparedPackagesPassIntegrityAudit", "all150MidpointPreviewsServedWithPinnedBytes");
  const accounts = [];
  for (const suffix of ["a", "b"]) {
    const { result, response } = await post("/api/accounts", { action: "register", login: `reference-${suffix}`, displayName: `Reference test ${suffix}`, password: randomUUID() });
    accounts.push({ id: result.account.id, cookie: response.headers.get("set-cookie").split(";")[0] });
  }
  await post("/api/local-drive", { operation: "project.put", projectId: project.metadata.id, project }, accounts[0]);
  const item = catalog.items.find((item) => item.prepared);
  const file = item.prepared.files.find((file) => file.path === item.prepared.entryFile);
  const request = { projectId: project.metadata.id, expectedRevision: 0, id: item.id, upstreamCommit: catalog.upstreamCommit, filePath: `@prepared/${file.path}`, expectedSha256: file.sha256, offset: 0, limit: 12000 };
  const body = { projectId: project.metadata.id, request };
  await post("/api/editor-agent/hyperframes-references", body, null, 401); checks.push("anonymousDenied");
  await post("/api/editor-agent/hyperframes-references", body, accounts[1], 400); checks.push("foreignProjectDenied");
  await post("/api/editor-agent/hyperframes-references", body, accounts[0], 409, accounts[1].id); checks.push("staleAccountDenied");
  let source = "", pages = 0;
  for (;;) {
    const { result, response } = await post("/api/editor-agent/hyperframes-references", body, accounts[0]);
    if (!response.headers.get("cache-control")?.includes("no-store") || result.sha256 !== file.sha256 || result.offset !== request.offset) throw new Error("Incorrect packaged response contract");
    source += result.text; pages++;
    if (result.nextOffset === null) break;
    if (result.nextOffset <= request.offset) throw new Error("Pagination did not advance");
    request.offset = result.nextOffset;
  }
  if (createHash("sha256").update(source).digest("hex") !== file.sha256) throw new Error("Packaged bytes differ");
  checks.push("ownedProjectSourcePagesMatchPinnedDigest");
  await post("/api/editor-agent/hyperframes-references", { ...body, request: { ...request, offset: 0, expectedSha256: "0".repeat(64) } }, accounts[0], 400); checks.push("staleDigestDenied");
  const report = { status: "passed", scope: "standaloneElectronServerLocalAccounts", upstreamCommit: catalog.upstreamCommit, referenceId: item.id, sourceSha256: file.sha256, pages, previewsChecked, checks, limitations: ["Electron shell was not launched by this check", "HTTPS SaaS is a separate acceptance gate"] };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
} finally {
  child.kill();
  await writeFile(path.join(output, "server.log"), logs);
}
