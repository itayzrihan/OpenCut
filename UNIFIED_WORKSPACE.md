# Unified OpenCut workspace

`itayzrihan/OpenCut` is the single repository of record for OpenCut.

## Layout

```text
OpenCut/
├── classic/       Current full web editor and its Rust/WASM business logic
├── apps/          Rewrite desktop, web/API placeholders, and MCP executable
├── crates/        Rewrite Editor API and MCP projection
└── brand/         Shared brand assets
```

`classic/` was imported with Git subtree, including its history. It is ordinary
tracked source code: `git clone` and `git pull` retrieve it automatically, with
no submodule initialization step.

## Product status

| Area | Current source of truth |
| --- | --- |
| Full editor UI and timeline | `classic/apps/web` |
| Silence cutting | `classic/apps/web/src/timeline` and `classic/rust/crates/timeline` |
| Current project/local-drive persistence | `classic/apps/web/src/services/local-drive` |
| Rewrite desktop UI | `apps/desktop` |
| Typed Editor API | `crates/editor-api` |
| MCP server and projection | `apps/mcp` and `crates/mcp` |

Organizational unification does not by itself connect the rewrite MCP to the
classic editor state. Until a bridge or migration is implemented, MCP tools
operate the rewrite runtime. This distinction must remain visible in product
claims and tests.

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

Rewrite desktop and MCP:

```sh
cargo run -p opencut-desktop
cargo run -p opencut-mcp-server
```

Rewrite validation:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Source-control policy

1. New work is committed to this repository, including changes under
   `classic/`.
2. A feature is not considered migrated merely because a similarly named
   capability exists in the rewrite.
3. Keep the standalone `itayzrihan/opencut-classic` repository as a read-only
   recovery mirror until classic-to-rewrite parity is complete.
4. Preserve experiments on named branches instead of mixing older storage or
   timeline implementations into current production code.
5. Never remove the classic implementation until its feature inventory,
   projects, preview/export output, and MCP operations pass migration tests.

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
