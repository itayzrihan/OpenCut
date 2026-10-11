import { readFile, mkdir, writeFile, rename, open } from "node:fs/promises";
import { dirname } from "node:path";
import * as glue from "../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js";

export interface Source {
  files: Record<string, string>;
  assets: Record<string, { sha256: string; bytes: number }>;
}
let initialized: Promise<void> | undefined;
async function initialize() {
  initialized ??= (async () => {
    const bytes = await readFile(new URL("../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm", import.meta.url));
    const { instance } = await WebAssembly.instantiate(new Uint8Array(bytes).buffer, { "./opencut_editor_runtime_wasm_bg.js": glue });
    glue.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as () => void)();
  })();
  return initialized;
}
export class CanonicalStudio {
  runtime: any;
  constructor(readonly archive: string) {}
  async open(initial: Source) {
    await initialize();
    this.runtime = new glue.CanonicalEditorRuntime();
    let saved: Buffer | undefined;
    try { saved = await readFile(this.archive); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (saved) this.runtime.restore(saved);
    else {
      this.call("project.create", { name: "HyperCut" });
      this.commit(initial, "Create HyperCut project");
      await this.persist();
    }
  }
  call(id: string, input: unknown, metadata: Record<string, unknown> = {}) {
    return this.runtime.invokeSync(id, input, { metadata }).result.data;
  }
  snapshot(): any { return this.call("app.state.read", {}).value; }
  get id(): string { return this.snapshot().project.id; }
  get revision(): number { return this.snapshot().revision; }
  source(): Source { return this.snapshot().project.extensions.hypercutStudio; }
  commit(source: Source, label: string, historyGroup?: string, revision = this.revision) {
    return this.call("project.studio.source.commit", {
      projectId: this.id, expectedRevision: revision, source, label, historyGroup,
    });
  }
  history(): { undo: string[]; redo: string[] } {
    return this.call("history.list", { projectId: this.id });
  }
  step(direction: "undo" | "redo") {
    this.call(`history.${direction}`, {}, {
      "opencut/projectId": this.id, "opencut/expectedRevision": this.revision,
    });
  }
  checkpoint(): Uint8Array { return this.runtime.serializeWithHistory(); }
  rollback(bytes: Uint8Array) { this.runtime.restore(bytes); }
  async persist() {
    const bytes = this.checkpoint();
    await mkdir(dirname(this.archive), { recursive: true });
    const temp = `${this.archive}.pending`;
    await writeFile(temp, bytes, { mode: 0o600 });
    const file = await open(temp, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temp, this.archive);
  }
  close() { this.runtime.free(); }
}
