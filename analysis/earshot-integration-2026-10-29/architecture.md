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

## MCP follow-up

The immutable Earshot catalog and all pinned upstream files are now canonical
registry data, compiled from the same checked-in sources for native and WASM.
`audio.earshot.catalog.search/read` supplies all 252 entries, exact starter
recipes and editable Python. `audio.earshot.repository.list/read/search/artifact`
covers all 282 files with pagination, hashes and bounded binary artifacts. See
`docs/architecture/earshot-library-capabilities.md` for the reference contracts.

`audio.earshot.preview` preflights the full recipe in the existing opaque browser
sandbox and returns up to eight seconds of PCM as an ephemeral WAV artifact,
with measured peak/RMS. A caller can select successive windows of a longer
recipe. This listening artifact never becomes the timeline source or a media
asset. Cancellation releases the noncommitting host slot even if no reply
arrives. Insert/edit still use `timeline.classic.elements.insert` and
`timeline.classic.audio.procedural.set`, followed by `app.state.read`.

Automation has an explicit durable workflow: enqueue a job through
`project.classic.automation.edit`, then launch that same job with `.start`.
`.status` and `.cancel` address the same identity. Actions include
`sound-effects`, `word-animation`, and `full-auto` with `options.soundEffects`.
Initial startup verifies the queued source fingerprint, saves the isolated
worker and uses the existing batch executor. Retries reuse the same job; a
running worker never recaptures later source edits. Completion publishes a new
scene through the existing canonical automation transaction.

Live browser tools are derived from that browser's canonical registry and
project revision and projected through the authenticated Classic MCP bridge.
They are discoverable as `classic.canonical.<capability-id>`; native headless
capabilities keep their original IDs. This distinction prevents a caller from
editing the headless document while intending to edit the visible project.
No independent project state or Earshot-specific MCP transport tool is added.
Binary previews and reference files transfer into the MCP ArtifactStore.
Existing project export remains available through the Classic standalone
`start_export_task` plan and export status tools, including procedural sound.
Host operations that require an internal editing-agent session are advertised
unavailable on the external bridge instead of claiming unsupported execution.

This follow-up is tested using disposable browser/runtime fixtures, including
real preset and custom-code synthesis. Production port 3211 and the user's
projects remain untouched; activation still requires running the feature branch.

### MCP verification

The configured `earshot-mcp` command passed 35 editor-api tests, six native MCP
registry/wire tests, 49 browser/host/automation tests and five focused real-WASM
command-manager/agent-host tests. The browser test performs actual preset and
custom-source synthesis with the pinned Pyodide runtime. Application TypeScript
compilation and whitespace checks passed. One pre-existing environment-dependent
bridge-publication test is skipped by its own guard; actual MCP wire discovery,
preview artifacts, cancellation and retry behavior are covered separately.

An exploratory run of the entire 80-case command-manager suite reached its
480-second budget after 31 passing cases without a test failure. The configured
check selects the five affected MCP/internal-agent cases; it does not claim the
unrelated full manager suite completed. No paid provider call or user project
was used. Activation requires the feature branch's matching browser runtime and
MCP backend; older backends continue receiving the legacy tool set.
