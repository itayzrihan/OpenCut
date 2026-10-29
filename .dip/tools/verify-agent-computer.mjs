import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
let target = root;
const script = "classic/scripts/verify-agent-computer.mjs";
if (!existsSync(join(target, script))) {
  const listing = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (listing.status !== 0) throw new Error("Cannot locate the integration worktree");
  const record = listing.stdout.split("\n\n").find((entry) => entry.split("\n").includes("branch refs/heads/codex/deepseek-video-agent"));
  target = record?.split("\n").find((line) => line.startsWith("worktree "))?.slice(9);
  if (!target || !existsSync(join(target, script))) throw new Error("Agent computer integration source is unavailable");
}
const result = spawnSync(process.execPath, [join(target, script)], { cwd: target, stdio: "inherit", timeout: 420000 });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
