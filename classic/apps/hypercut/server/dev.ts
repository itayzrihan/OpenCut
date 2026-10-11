import { spawn } from "node:child_process";
const api = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], { stdio: "inherit", env: { ...process.env, HYPERCUT_PORT: "3221" } });
const ui = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "3220", "--strictPort"], { stdio: "inherit" });
let stopping = false;
function stop() { if (stopping) return; stopping = true; api.kill("SIGTERM"); ui.kill("SIGTERM"); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
api.on("exit", stop); ui.on("exit", stop);
