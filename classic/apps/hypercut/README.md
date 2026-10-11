# HyperCut

The **complete original HyperFrames StudioApp** (0.8.146) is the editor UI. HyperCut adds a canonical OpenCut Rust host behind its file API; it does not recreate Studio's layout with a new shell.

This is a working **development integration**, not the complete OpenCut replacement. Verified: native Design text edits, timeline split, local media import/insertion/playback, canonical Undo/Redo, stale-write rejection, persistence and restart recovery. Smart Takes, Full Auto, smart silence, OpenCut's custom panels, accounts/global libraries, export, capture and catalog installation are not connected yet. Native multi-file gesture history grouping is also pending. Unsupported host actions return an explicit error.

## Run

```sh
npm ci --workspaces=false
npm run build --workspaces=false
npm start --workspaces=false
```

Open http://127.0.0.1:3220. Stop with Ctrl+C. The host binds only to loopback and rejects cross-origin requests. A process lock prevents two hosts from writing the same storage. This server does not expose an MCP endpoint.

The existing canonical WASM package is required at `../../rust/editor-runtime-wasm/pkg/`. Rebuild after changes to Rust using `wasm-pack build classic/rust/editor-runtime-wasm --target bundler --out-dir pkg --no-pack` from the repository root. HyperCut dependencies are pinned in its separate lockfile; no cached npx files are modified.

For development run `npm run dev --workspaces=false`; it runs the API at 3221 and Vite at 3220. Stop the production-preview host first.

## Storage

`.data/session.json` stores the canonical document and bounded Undo/Redo history (up to 200 entries, additionally retaining at most about 16 MiB of older Studio source; at least the newest Undo boundary is kept). `.data/blobs` stores imported media. `.data/workspace` is a disposable materialization for native HyperFrames compilation and file operations. Do not edit this cache as a project folder; changes must go through Studio/the runtime. Back up the complete `.data` directory while the server is stopped. The host currently opens one new HyperCut project; project library UI remains pending.

Optional `HYPERCUT_DATA_DIR` and `HYPERCUT_PORT` configure this isolated host. Old prototype projects remain untouched in `hypercut-v1` browser IndexedDB; they are not the new Studio source format and are not automatically imported.

The earlier custom UI has been removed. Reusable projection/worker experiments are isolated under `experiments/classic-projection/` and are not mounted product state.

See [MIGRATION.md](MIGRATION.md), [feature-parity.json](feature-parity.json), and [VERIFICATION.md](VERIFICATION.md). Do not deploy this as an OpenCut production replacement until the remaining acceptance tests pass.
