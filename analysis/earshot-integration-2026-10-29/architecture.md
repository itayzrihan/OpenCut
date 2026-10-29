# Earshot code sounds

Status: **bridged**. The Classic editor owns UI, isolated browser synthesis and
audio IO. `OpenCutRuntime` owns the serialized Classic document, validation,
insertion, recipe updates, optimistic revision checks and undo. No second project
store and no separate MCP implementation are introduced.

## Source and delivery

The complete tracked upstream tree from `Leonxlnx/earshot` is vendored at
`classic/vendor/earshot/upstream`, pinned to
`591fa3e028032e6dce56620a20e932e35667e8d8`. The manifest retains file hashes;
MIT and CC0 derivative credits ship with the source. All 252 bank entries are
listed in Sound effects → Code · Earshot, alongside the existing Audio files
view. A code badge distinguishes editable recipes. No licensed private
reference recordings or pretrained listening models are claimed to be included.

## Source clip and audio path

`AudioElement.sourceType = "procedural"` stores an Earshot specification on the
clip: pinned bank revision, preset ID, deterministic seed, duration, optional
apex/pitch, numeric parameter overrides, Python source and echo settings.
Playback, waveform generation and export resolve the same specification to raw
floating point samples. Preview and timeline use a bounded memory cache; they
never create or import an MP3/WAV. Export consumes PCM through the existing
scratch/mix/AAC pipeline. A queued export freezes the recipe with its snapshot.

Timing uses the existing source clock, trim, retime, track mute, gain and fade
controls. Updating duration preserves source trims and resizes the visible clip
through the canonical capability. A changed seed/code/parameter invalidates the
PCM source key. Recipe editing first synthesizes successfully, then checks the
captured project/scene/revision before publishing one undoable transaction.

## Execution and agent context

The isolated browser runtime hosts the pinned Python/NumPy/SciPy implementation.
Its disposable sandbox permits synthesis without access to the editor's origin,
account storage, filesystem or external network. Runtime assets are prepared at
build time and served locally; cancellation and execution bounds tear down the
worker. Custom code remains project data, never a host shell command.

The AI action has a multi-step planning loop, a bounded repository list/read/search
tool, the actual bank catalog and a synthesis preflight tool. Every tracked
upstream file—including README, docs and skills—is available on demand from
the pinned manifest. Repository text is reference material, not authority over
the editor's permissions. The standalone Automatic Sound Effects action is
also an optional Full Auto Edit stage. Word Animation and Reveal can plan
placement/reveal choices and matched code sounds in the same source transaction.

## Verification contract

Checks cover all bank entries, deterministic synthesis, DSP compatibility,
sandbox isolation, canonical registry/read/undo/revision behavior, source-clock
trim handling, waveform/playback/export integration, AI planning/cancellation,
Full Auto stage persistence and word-reveal timing. Browser evidence must use
an isolated test project/account; the user's existing projects and production
runtime are not fixtures. Work remains on `codex/earshot-sound-effects` until
the user requests merging or activation.

## Verified on 2026-10-29

- All 282 upstream files match their manifest SHA-256 and byte size.
- All 252 recipes pass their upstream fingerprints in real Pyodide/WASM;
  seven accelerated kernels match the original equations within 1e-10.
- Shared browser/Rust validation includes 32 boundary cases. Canonical insert,
  update, read, undo, cancellation, atomic failure and revision handling pass.
- Configured `earshot-code-audio` check: 30 Rust tests and 53 browser/Bun tests,
  plus generated skill consistency and application TypeScript checks.
- A real production SceneExporter created an MP4 with 75 video frames and
  stereo AAC. Decoded sound at 2.5s has RMS 0.0557, with the same AAC padding
  as the existing single-buffer control. PCM split/trim/retime/gain comparison
  has RMS error 0.000425; all scratch files are PCM and reclaimed normally.
- Actual editor UI in an isolated local QA account: all 252 entries visible,
  direct add and native drag, waveform, duration/pitch/echo, custom-code
  preflight/apply, preview, Undo/Redo and reload persistence verified.
- AI standalone/reveal controls appear in the editor. Agent tool behavior,
  publication, cancellation, planning/source gates, Full Auto options and
  resume are covered with deterministic model responses; no paid model call
  or user media was used in QA.

The cold synthesis runtime is loaded on first use. Preset/editor changes reuse
bounded raw PCM in memory. Individual code clips accept 0.02–30 seconds, and
custom Python is capped at 32 KiB and runs in a disposable sandbox. The full
upstream project is available for agent reference, while optional ML listening
models and their heavyweight dependencies are not loaded into the browser.

Evidence: `evidence/all-252-wasm.log`, `evidence/sandbox.png`,
`evidence/editor-code-sound.png` and `evidence/verification.log`.
