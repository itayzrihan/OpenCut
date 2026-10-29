# Earshot integration

The `upstream/` directory contains every tracked file from Leonxlnx/earshot at
`591fa3e028032e6dce56620a20e932e35667e8d8` (0.4.0), unchanged. `manifest.json`
records all 282 source files by path, length and SHA-256; `provenance.json` names
the repository, release and licenses. Keep upstream/LICENSE and the CC0 credits
in upstream/docs/CREDITS_FIT.md when redistributing. The upstream documentation
and skills are reference material for the application's agent, not host commands.

Migration status: **bridged**. The recipe state and editing capabilities belong
to OpenCutRuntime. The classic application adapts that state to browser audio and
export through `src/earshot/render.ts`; it does not persist a second project model.

The bank includes all 252 sounds. `bank.render` computes raw float PCM from the
pinned Python recipes, NumPy and SciPy. No WAV/MP3 asset is generated on insertion,
editing or preview. The same PCM enters playback and the export mix. The timeline
stores source, seed and controls, so queued snapshots keep the chosen recipe.

`node classic/scripts/prepare-earshot-runtime.mjs` prepares a self-hosted Pyodide
0.28.3 runtime. Every build download is pinned by SHA-256. NumPy 2.2.5, SciPy 1.14.1
and libopenblas 0.3.26 are the only additional runtime packages. Torch, external pretrained model
weights, microphones and recording dependencies are not installed or loaded.
Generated runtime resources are excluded from Git and must be included in the
application's packaged public assets. There is no CDN fallback during playback.

Code executes in a dedicated blob Worker created inside a sandboxed iframe with
an opaque origin. Its CSP only permits blob resources; external/same-origin
network requests, parent DOM access and OS filesystem access are unavailable.
The parent verifies and transfers local runtime bytes before starting the worker.
Custom code receives a separate interpreter, a seeded NumPy generator and a copy
of the clip's `source_spec`. Cancellation and time limits terminate its Worker.
Output is bounded to 30 seconds, 48 kHz, one or two finite float channels.

Seven sequential upstream kernels normally compiled by optional Numba use
JavaScript equivalents in the browser. The NumPy/SciPy recipes remain unchanged;
tests compare the equations at 1e-10 tolerance and all 252 upstream fingerprints
(length, peak time and envelope). This avoids slow Python per-sample loops in
WASM. Full source editing remains available via a short clip-local `render(params,
r)` module; `createEarshotSourceCode` starts with an exact bank-render wrapper.
The wrapper honors duration, pitch and apex. Arbitrary replacement code controls
its synthesis using `params` and `source_spec`; echo and final clipping boundaries
are applied by the adapter.

Verification:

- `bun test classic/apps/web/src/earshot/catalog.test.ts` checks all presets and
  the same validation fixture as the Rust capability registry.
- `node classic/scripts/test-earshot-runtime.mjs` renders all 252 sounds in real
  WASM, compares fingerprints, tests kernel parity, deterministic custom code,
  echo and exact PCM parity when starting to edit a preset. `--smoke` renders
  three representative sounds while retaining all other checks.
- The browser isolation harness verified actual Chrome builtin/custom synthesis,
  opaque origin, CSP refusal of an XHR after deliberate JS-bridge access, and
  cancellation of an infinite custom-code loop.
