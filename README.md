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
