# Unified OpenCut workspace

`itayzrihan/OpenCut` is the single repository of record for POCUT.

## Layout

```text
OpenCut/
├── classic/       POCUT browser and Electron editor and its Rust/WASM logic
├── apps/mcp/      MCP executable and local session policy
├── crates/        Shared Editor API, agent, account policy, and MCP projection
└── brand/         Shared brand assets
```

`classic/` was imported with Git subtree, including its history. It is ordinary
tracked source code: `git clone` and `git pull` retrieve it automatically, with
no submodule initialization step.

## Product status

| Area                                                                   | Current source of truth                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Full editor UI and timeline                                            | `classic/apps/web`                                                                                       |
| Silence cutting                                                        | `classic/apps/web/src/timeline` and `classic/rust/crates/timeline`                                       |
| Virtual camera, depth, speaker tiles, learned UI assets                | Classic editor and its live MCP/AI capability catalog |
| Speaker Frame Breakout smart layer and Paper Grid                      | Classic UI/rendering and typed create/update/inspect/apply contracts in `crates/editor-api` |
| Unified Angles virtual multicam                                        | Classic UI/preview/export and typed angle contracts in `crates/editor-api` |
| Video framing for aspect-ratio conversion                              | Classic Settings and renderer, with the `timeline.items.fit.set` contract and serialized state in `crates/editor-api` |
| Editorial edge feather and feathered text assets                       | Classic editor and its live MCP/AI capability catalog |
| Current project/local-drive persistence                                | `classic/apps/web/src/services/local-drive`                                                              |
| Typed Editor API                                                       | `crates/editor-api`                                                                                      |
| HyperFrames project source import                                    | Typed import and folder planning in `crates/editor-api`, lazy WASM, canonical Classic history and compact archives; isolated official runtime verified with eight Brag projects. Import UI, Classic compositing/audio/export and native MCP forwarding remain pending; see `HYPERFRAMES-INTEGRATION.md` |
| MCP server and projection                                              | `apps/mcp` and `crates/mcp`                                                                              |

The local Classic editor connects to the stdio MCP through an authenticated
loopback bridge. It publishes the active project, playhead, timeline, selection,
semantic UI state, and its live AI tool catalog; those tools are projected
dynamically through the canonical MCP capability registry. Use the connected
Classic session for live browser or Electron edits. The native runtime also
supports headless operations. Remote deployments do not expose the local bridge.

## Development

Current full editor:

```sh
cd classic
cargo install wasm-pack # one-time prerequisite
bun run build:wasm
bun install --frozen-lockfile
bun run dev:web
```

Classic tests:

```sh
cd classic
bun test
```

MCP server:

```sh
cargo run -p opencut-mcp-server
```

Shared Rust validation:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Source-control policy

1. New work is committed to this repository, including changes under
   `classic/`.
2. Verify a capability through the POCUT browser or Electron entry point
   before claiming product support.
3. Keep the standalone `itayzrihan/opencut-classic` repository as a read-only
   recovery mirror.
4. Preserve experiments on named branches instead of mixing older storage or
   timeline implementations into current production code.
5. Verify projects, preview/export output, and MCP operations before replacing
   an existing editor feature.

## Updating the recovery mirror

The initial import came from `itayzrihan/opencut-classic`. If a deliberate
recovery-mirror update is required:

```sh
git remote add classic-origin https://github.com/itayzrihan/opencut-classic.git
git fetch classic-origin main
git subtree pull --prefix=classic classic-origin main \
  -m "Sync OpenCut Classic recovery mirror"
```

Routine development should happen directly in `classic/` here rather than in a
separate checkout.
