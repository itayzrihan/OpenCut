# opencut-wasm

Shared video editor logic compiled to WebAssembly. Used by the [OpenCut](https://github.com/opencut/opencut) web app.

## Install

```bash
npm install opencut-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "opencut-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./opencut_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This package is the compiled WebAssembly output — do not edit it directly.

## Local development

The web app resolves `opencut-wasm` directly from this generated package so
the JavaScript glue and `.wasm` binary cannot drift between copied dependency
caches. Build it from the repository root before starting the web app:

```bash
bun run build:wasm
```

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```

Restart `bun dev:web` after adding or removing a Rust export because a running
browser cannot hot-swap an instantiated WebAssembly export table.
