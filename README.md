<table width="100%">
  <tr>
    <td align="left" width="120">
      <img src="https://assets.opencut.app/branding/symbol.svg" alt="OpenCut Logo" width="100" />
    </td>
    <td align="right">
      <h1>OpenCut</h1>
      <h3 style="margin-top: -10px;">A free and open source video editor for web, desktop, and mobile.</h3>
    </td>
  </tr>
</table>

[![Discord](https://img.shields.io/discord/1386309140057690133?label=Discord&logo=discord&logoColor=fff&color=5865F2&style=flat)](https://discord.gg/zmR9N35cjK)
[![X](https://img.shields.io/badge/follow-%40opencutapp-000?logo=x&logoColor=fff&style=flat)](https://x.com/opencutapp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat)](LICENSE)

## Status

This repository is now the canonical, unified OpenCut workspace. It contains:

- `classic/` — the current full TypeScript/Next.js editor, including silence
  cutting, timeline editing, AI workflows, local-drive persistence, and the
  production web application.
- `apps/` and `crates/` — the Rust/GPUI rewrite, Editor API, desktop shell, and
  self-describing MCP control plane.

The two implementations are kept in one Git history so a normal clone or pull
cannot silently omit product work. They are not yet one runtime: the current
MCP controls the rewrite runtime, and classic features must be migrated or
bridged explicitly before the MCP can operate the production editor.

The rewrite roadmap includes:

- An Editor API
- First-class third party plugins (made possible by a plugin-first architecture)
- Desktop, mobile, and browser from one codebase (Rust core)
- A self-describing MCP server (for AI agents)
- Headless mode (automation, batch rendering)
- A scripting tab directly in the editor

See [UNIFIED_WORKSPACE.md](UNIFIED_WORKSPACE.md) for the source-of-truth,
development, synchronization, and migration rules.

## Development

Install [proto](https://moonrepo.dev/proto) if you haven't already:

**Linux, macOS, WSL:**

```sh
bash <(curl -fsSL https://moonrepo.dev/install/proto.sh)
```

**Windows (PowerShell):**

```powershell
irm https://moonrepo.dev/install/proto.ps1 | iex
```

If shims fail to run, allow local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

From the repo root:

```sh
proto use    # installs the tools pinned in .prototools
```

```sh
moon run web:dev       # localhost:5173
moon run api:dev       # localhost:8787
moon run desktop:dev   # see apps/desktop/README.md
moon run mcp:dev       # MCP over stdio
```

To run the current full editor:

```sh
cd classic
cargo install wasm-pack # one-time prerequisite
bun run build:wasm
bun install --frozen-lockfile
bun run dev:web
```

### Classic browser and Electron targets

The complete editor under `classic/` has one UI and one editor state model, but
two optimized delivery targets. No product feature is copied between them.

| Target | Development | Production | Runtime profile |
| --- | --- | --- | --- |
| Browser | `bun run dev:web` | `bun run build:browser` | Compressed HTTP responses, tree-shaken package imports, no production source-map download, and a conservative worker CPU budget that preserves browser responsiveness. |
| Electron | `bun run dev:electron` | `bun run pack:electron` or `bun run dist:electron` | The same Next.js UI in a sandboxed window, uncompressed loopback traffic, eager V8 code caching, a larger Chromium disk cache, high-performance GPU preference, continued background processing, and a larger worker CPU budget. |

Run either target from `classic/` after `bun install`. `dev:electron` starts the
normal web development server at `http://127.0.0.1:3000` and opens it in
Electron, so the same session can also be inspected in a browser. The packaged
app builds with `OPENCUT_RUNTIME_TARGET=electron`; the browser build uses
`OPENCUT_RUNTIME_TARGET=browser`. Electron also marks its user agent at runtime,
which keeps the profiles separate while both clients share one development
server.

Electron defaults to the discrete/high-performance GPU. Set
`OPENCUT_ELECTRON_GPU=balanced` before launch on battery-sensitive machines.
Its HTTP cache budget defaults to 512 MiB and can be changed with
`OPENCUT_ELECTRON_DISK_CACHE_BYTES`. Browser source maps remain off in release
builds; set `OPENCUT_BROWSER_SOURCE_MAPS=true` only for a diagnostic build.

The Electron distribution is currently **classic-only**. It wraps the full
classic product and does not replace the GPUI rewrite under `apps/desktop`.
See [classic/apps/electron/README.md](classic/apps/electron/README.md) for
packaging and platform details.

## MCP / Editor API

The rewrite includes a transport-neutral Editor API and an MCP adapter. Editor
features register one versioned capability with the shared Rust runtime; MCP
then exposes it automatically as a typed tool, a discoverable operation, and a
readable contract resource. This keeps new editor work available to agents
without maintaining a separate hand-written MCP API.

The runtime now models multiple open project tabs, exact media time, assets,
tracks, layers, clips, text/captions, shapes, masks, effects, keyframes,
transitions, markers, selection, playback, workspace state, history,
persistence, media analysis, preview artifacts, jobs, and FFmpeg export.
Desktop panels and MCP use the same in-memory runtime, so an authenticated
agent can inspect the semantic UI, receive preview/window images directly, and
edit the active project while the desktop is open.

See [apps/mcp/README.md](apps/mcp/README.md) for architecture, client
configuration, the feature-registration contract, and security controls.

## Contributing

We're not set up to take outside contributions yet while the architecture is being designed. If you want to follow along, ask questions, or just hang out, [join the Discord](https://discord.gg/zmR9N35cjK) or [open an issue](https://github.com/opencut-app/opencut/issues).

## Sponsors

OpenCut is supported by companies that believe in open source creator tools.

- [**fal.ai**](https://fal.ai?utm_source=github-opencut&utm_campaign=oss): Generative image, video, and audio models all in one place.

Want your logo here? Reach out at [sponsor@opencut.app](mailto:sponsor@opencut.app).

## License

[MIT](LICENSE)
