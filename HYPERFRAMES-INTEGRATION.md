# HyperFrames integration into OpenCut

## Scope and completion requirements

Branch: `מיזוג-עם-העורך-של-Hyper-frames` (spaces normalized for Git).
Keep the full editor in `classic/` and its existing timeline. Projects must accept
HyperFrames compositions alongside ordinary clips, over them as layers, or alone.
Preserve all existing editing, AI, account, storage, preview and export features.
Improve the existing interface and performance based on measured differences.

This document tracks an ongoing integration. The source import contract below
is implemented; the product integration is not complete.

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| Dedicated branch | Git branch at the canonical repository | Created |
| Study UI, timeline, element model and performance | Source audit, visual comparison, measured baselines | Source audit and three-package capture benchmarks recorded; full interface and live playback comparison pending |
| Lossless source import into existing document | Registry tests, original source roundtrip, native clips unchanged | Implemented for native and Classic documents; registry, real WASM and browser folder flow pass |
| Folder/project import in the full editor | Import from user-selected Brag folder; resources persist across reopen | All eight Brag folders imported through the UI and reopened; the seven-folder sequence retains byte-identical source and 265 copied resources; crash recovery for interrupted staging remains pending |
| Mixed, overlaid and standalone compositions | Existing Classic timeline, live preview and export for all three | Synthetic overlay verified in Classic preview and MP4 between two native image layers; actual Brag/native overlay and two side-by-side occurrences verified in preview; standalone and remaining source coverage pending |
| Editable composition children | Expand/collapse in existing lanes; select, trim, move, source/variable editing and undo | Validated inventory, inspector and expandable rows within existing tracks implemented; rows follow compound placement/trim/split/undo and navigate to their timeline times; per-occurrence visual layer opacity/hide/reset now works through the canonical registry, with saved history and live/capture parity; declared text/style variables now edit one occurrence after runtime preflight; child timing and arbitrary source edits remain pending |
| Full-fidelity playback | GSAP, CSS, media, fonts, nested hosts, generated DOM; seek/trim/speed/audio tests | Official runtime tested on eight Brag projects; Classic capture and audio paths connected; up to four eligible live DOM compositions interleave with native layers, with independent occurrence timing; video/canvas live support and broader speed/fidelity coverage pending |
| Export parity | Representative frame and audio comparisons to pinned HyperFrames | Synthetic trimmed overlay and a 14-second mixed Brag/native MP4 verified; native and compound narration have zero measured timing offset; remaining Brag/media comparisons pending |
| Clearer existing UI | Browser review of hierarchy, labels, source status, selection and keyboard behavior | Layer inspector, preparation/failure feedback and Fit timeline control implemented; scroll/ruler updates recover correctly from React effect restarts; complete interface audit pending |
| Faster interaction/playback | Same-machine measurements for real projects and large mixed timelines | Adaptive captures and direct live DOM seeking implemented; one compound measured at 29.2 completed preview frames/s versus 9.2–10 with capture; two live compounds now reach 28.4–28.9 versus the former 9.8; four distinct packages and large-timeline coverage pending |
| Existing features retained | Feature inventory and applicable Classic/Rust suites plus browser workflows | 215 isolated web suites now pass all 979 tests with browser coverage enabled and zero skips; 232 Rust tests pass; test-fixture typing and full interactive workflow coverage remain open |

## Feature preservation regression audit (2026-10-04)

The web suite now runs through `bun run test:web` from `classic/`, one isolated
process per file. Bun is the default; the audio browser suite explicitly uses
Node, matching the server runtime. This prevents process-wide module mocks from changing other
suites. Tests requiring real Classic Rust exports explicitly declare the
`@opencut-test-wasm: real` preload. Tests with partial mocks merge the generated
WASM exports before their own overrides. A universal preload was rejected:
it made renderer startup, AI tools and caption timing tests bind real functions
where those tests deliberately needed mocks.

The audit repaired missing WASM setup/exports, initialized a signed-in browser
fixture for the AI client, updated the AI skill inventory, and corrected a
preview-frame mock that incorrectly expected a third `Array.from` callback
argument. No production editor behavior changed in this checkpoint.

### Results

- **215 web suites: 968 tests pass, zero failures, 11 optional browser tests
  skipped**, in 44.7 seconds with two workers on this machine. Coverage includes
  timeline editing, ripple/cut/trim and ordering (135 tests), AI (179), storage
  and renderer services (177), subtitles (61), editor managers and canonical
  commands (41), text (37), plus accounts, batch editing, backgrounds, masks,
  effects, transitions, retiming, templates and UI element bundles. Full report:
  `.local/hf-regression-final-20261004/summary.json`.
- Four suites were rerun after the final mock/precision cleanup: **75 tests
  pass** (`.local/hf-regression-postreview-20261004/summary.json`).
- **74 root Rust tests pass** across `opencut-editor-api` and `opencut-mcp`,
  including registry projection, transaction rollback, scope, authentication
  and loopback transport. **158 Classic Rust tests pass** across `agent`,
  `background-removal`, `time`, `bridge`, `effects`, `masks`, `podcast`,
  `premiere`, `storage` and `timeline`. Native GPUI/GPU/compositor tests were not
  included in that command. Logs: `.local/hf-native-regression.log` and
  `.local/hf-classic-rust-regression.log`.
- Product TypeScript (`tsconfig.build.json`) passes. The full test-fixture type
  audit still has errors, including fetch mock signatures, branded media times
  and incomplete fixture types. `tsconfig.test.json` makes this audit explicit
  with Bun types and ES2020; it is not a passing gate yet. The product build
  configuration remains separate. Diagnostics: `.local/hf-test-typecheck.log`.
- Real Chrome tests for capture, live document isolation, internal layer edits,
  host scope/capacity and declared variables all pass: five suites, ten tests
  (including two capture tests already counted in the default run). GSAP volume
  envelope sampling passes separately with the local Brag GSAP fixture.
  Reports: `.local/hf-regression-browser-20261004/summary.json` and
  `.local/hf-gsap-volume-regression.log`.

### Private audio migration coverage

Four preset tests previously required the removed public shared library.
Commit `023cc9db` intentionally moved that user-owned data into authenticated
account storage. The revised tests create synthetic private audio at the
presets' stable IDs, run the real legacy migration, and read both the manifest
and bytes through the actual authenticated routes. Renamed metadata preserves
IDs and exact source bytes; another account receives no library entries and
404 for the asset, while an anonymous request receives 401. Existing preset
clip timing assertions remain.

These tests prove the migration/routing contract. They do not verify that the
owner's real media has been imported on this installation, or make those sounds
available to fresh accounts. Presets still reference account library IDs;
missing-library feedback and the fresh-account preset experience need review.
Private media was not restored to `public/` or added to Git.

### Audio browser suite now uses the server runtime

The invalid nested-audio fixture extends a clip 0.1 seconds beyond its parent.
Phase tracing showed that canonical rejection completes in 1–2 ms under Bun
1.3.5, followed by a 30-second stall in the engine's final Chrome memory sample
and a five-second page-close timeout. Several runs then crashed Bun. Disabling
the sampler reduced the delay but did not eliminate the page-close timeout;
keeping preview resources alive and moving cleanup out of the error-unwinding
path also did not resolve it. Those experimental edits were reverted.

The unchanged production adapter handled the same fixture under Node 24.12.0
in **954 ms**, including rejection and browser disposal. The engine declares
Node as its supported runtime, and the Next server runs on Node. The three
real audio tests now use `node:test`, retaining their video-audio discovery,
nested occurrences, trims, rates, gains, fades, decoded PCM, account/project
isolation, cancellation and GSAP envelope assertions. A new assertion requires
invalid-probe cleanup within five seconds, then opens a valid composition and
captures a PNG with the same runtime and preview host. Memory sampling remains
enabled. Production capture/disposal code is unchanged.

`// @opencut-test-runner: node` explicitly selects this runtime in the isolated
runner; there is no retry or runtime selection based on pass/fail. A small
TypeScript hook loads the same source files and installed dependencies under
Node. WASM fixture bytes now load through `node:fs/promises`, shared with the
Bun suites. Node TAP totals and the selected runtime are recorded in each report.

Verification after the change:

- All three audio tests pass in **21.9 seconds** with Chrome and FFmpeg. Report:
  `.local/hf-audio-node-suite-20261004/summary.json`.
- The full suite with browser tests and the local Brag GSAP fixture enabled
  passes **979 tests in 215 suites, zero failures and zero skips**, in **90.1
  seconds** with two workers. This includes the default 968 tests and all 11
  previously optional browser tests. Report:
  `.local/hf-regression-with-browser-node-20261004/summary.json`.
- Changed TypeScript test files pass ESLint. The test type audit still reports
  51 existing fixture errors elsewhere, with none in the changed audio test or
  canonical runtime fixture (`.local/hf-audio-node-typecheck.log`).

Bun's CDP/cleanup issue is not claimed fixed upstream. The verified product path
and its audio regression suite now run in Node. Diagnostic evidence remains in
`.local/hf-disposal-phases.log`, `.local/hf-disposal-node.log`, and the earlier
Bun failure logs.

This regression audit is partial preservation evidence. The broader UI review,
full interactive workflows, remaining Brag exports, child timing editing and
four-package playback benchmark are still required before completion.

## Declared composition variables (2026-10-04)

The existing Graphic inspector now shows declared HyperFrames variables for the
selected clip: text, colors, numbers, booleans, enum choices, images and fonts.
Apply checks the changed animation before committing; Reset restores authored
values. Other occurrences stay independent. Values with the same name apply
throughout the selected compound, including repeated nested compositions.
Individual nested-host variable overrides remain a separate future capability.

`HyperframesSource.variables` stores explicit values alongside unchanged source
files/resources. Empty values are omitted, so old source fingerprints and saved
archives retain their identity. Rust reads declarations from HTML, enforces
matching types, numeric bounds, string lengths, enum choices, a 256-value limit
and a 256 KiB payload limit. One value must satisfy all matching declarations.
Malformed optional display metadata is normalized before reaching the UI.

The canonical capabilities are `hyperframes.variables.read`,
`hyperframes.variables.prepare`, and `hyperframes.variables.set`. The write
requires explicit project/scene/element/revision and a freshly observed manifest
for the derived source. The UI holds the revision across asynchronous preflight,
checks account/project/scene scope again, and offers cancellation. Shared source
assets fork for the edited occurrence; a dedicated asset can update in place.
Existing timeline placement and visible duration stay intact. A new source that
cannot cover the clip is rejected. Opacity overrides are rebound only when all
layer identities still match; a structural change requires resetting those
opacity overrides first. This is **Classic-only**, through OpenCutRuntime.

The render adapter installs values before authored scripts run. In pinned
HyperFrames 0.8.115, top-level `__hfVariables` alone does not reach nested scripts'
scoped `getVariables()`. OpenCut also applies explicit values when the runtime
populates `__hfVariablesByComp`, preserving its host defaults beneath those
values. Both live and capture use the same adapter. This scope adapter must be
retested when upgrading HyperFrames. Source identity includes variable values,
so frame, live-session and audio caches distinguish the variants.

Verification:

- Two new Rust registry tests cover validation, legacy fingerprints, unchanged
  file bytes, independent repeated clips, preflight fingerprint mismatch, dry
  run, retry idempotency, cancellation, locks, stale revisions, shortened source,
  changed layer identity, opacity preservation and undo/redo. Eight import and
  two opacity regression tests also pass.
- A real Chrome/WASM test verifies root script initialization, declarative text,
  CSS color, numeric size and enum layout. Two repeated nested instances receive
  the same explicit title. A title containing closing script tags remains text.
  Live/capture RGBA frames match at `0.5, 2, 0.5, 0.5` seconds, including capture
  reopen after live promotion. Persisted history restores the values and opacity.
- UI project `d42d8daf-3bfd-4807-8c26-b4f1aae5e27a` contains two copies plus native
  text and an image. Changing the left title to `Edited in OpenCut` and accent
  to `#66e3a4` leaves the right title/color original. Reload retains both edits;
  persisted Undo/Redo changes the edited accent back and forward. Cancel during
  preflight leaves the canonical values unchanged; reload restores the original
  size of 60. Reset restores the authored title; Undo restores the edited one.
  Both clips retain byte-identical original HTML. UI evidence:
  `.local/hf-variables-ui.png`.
- UI export is H.264, 640x360, 30 fps, exactly four seconds and 64,150 bytes.
  Its decoded two-second frame visibly preserves both independent appearances
  and native layers. This fixture has no active audio. Evidence:
  `.local/hf-variables-export.mp4`, `.local/hf-variables-export-frame.png`.
- Nine cache/client tests (256 assertions), five capture/session tests (25
  assertions; three optional browser tests skipped), scoped TypeScript,
  changed-file ESLint, Editor API Clippy, the release WASM build and binary
  export checks passed. Full editor regression and broader Brag coverage remain
  pending; this increment does not complete the integration.

## Per-occurrence visual layer controls (2026-10-04)

Classic compound clips now expose Hide/Show, opacity percentage and Reset in the
existing Composition layers inspector. Each edit belongs to that timeline clip.
Other uses of the same source keep their own appearance, and the package's HTML,
scripts, resources and authored animation remain unchanged. Audio layers remain
read-only here; visual opacity does not mute embedded narration.

The canonical `hyperframes.layer.opacity.set` capability requires an explicit
project, scene, element, layer key and revision. It validates locks, finite
opacity in `[0, 1]`, source identity and the complete observed manifest, and uses
normal transactions, dry runs, cancellation, idempotency and undo history.
`GraphicElement.hyperframesLayerEdits` stores the source/manifest fingerprints
and a bounded map of opacity overrides. Setting one removes that override.
Ordinary Classic commits and admin patches validate the same state.

`hyperframes.layers.render.prepare` produces the render plan. Each capture
reopen checks it against a freshly observed manifest; ambiguous `manifest/N`
rows cannot be edited. The shared live/capture DOM adapter resolves exact
occurrence paths and checks the authored ID, restores author styles before each
seek, then multiplies the evaluated opacity after the official runtime seeks.
Parent and child edits compose, while repeated seeks do not accumulate changes.
Render cache keys include the overrides. No extra timeline or editor state was
introduced. This editing capability is **Classic-only**, through OpenCutRuntime;
it has not been ported to the rewrite UI or rewrite timeline model.

Verification completed for this increment:

- Registry tests cover targeted edits/readback, repeated source occurrences,
  unchanged source packages, dry run, retry idempotency, cancellation, stale
  revisions, invalid targets/values, locked tracks, undo/redo, reset and rejected
  manifest changes. Existing timeline projection/history tests also pass.
- A real Chrome/WASM test edits a parent and one child in two repeated nested
  compositions, checks the unaffected sibling, and compares complete live and
  capture RGBA frames at `0.5, 2, 0.5, 0.5` seconds. They are identical. It also
  reopens capture after live promotion and round-trips the saved undo archive.
- Actual Brag UI project `980bd89b-dda1-48ae-9098-e660c98334a6` contains two uses
  of `advanced-audio-test-final`, native text between them and a native image
  below. Hide affected only the selected occurrence; Undo restored it. At 50%,
  the two DOM surfaces report opacity `1` and `0.5`. Reopening retained 50%, and
  persisted Undo/Redo restored 100%/50%. Source packages compare equal to the
  fixture before editing. Evidence: `.local/hf-layer-opacity-50.png`.
- UI MP4 export with the edit completed: 640x360, 30 fps, H.264, stereo AAC at
  44.1 kHz, 6.014 seconds and 479,221 bytes. Its decoded frame at 0.5 seconds
  shows the edited occurrence and preserved native/sibling layers. Evidence:
  `.local/hf-layer-opacity-export.mp4` and
  `.local/hf-layer-opacity-export-frame.png`.
- A second UI export after Reset, with all other settings unchanged, has
  identical decoded stereo PCM audio. SHA-256 for both outputs (PCM s16le):
  `c7db66bbb549caea21c18712c0a74c872a19a8d697d1fb98610931efe121ee64`.
  The decoded video comparison shows the opacity change on the selected source
  section. The project was returned to 50% with Undo after this comparison.
- Three Rust tests and 24 selected TypeScript tests passed (414 assertions),
  including the real Chrome test above. Three older optional browser cases were
  skipped in the non-browser regression invocation. Tests that mock modules ran
  in separate Bun processes. Scoped TypeScript, changed-file ESLint, Editor API
  Clippy (`--tests -D warnings`), the release WASM build and both binary export
  contract checks passed. These are scoped checks; the full editor suite remains
  outstanding.

Child retiming, movement, text/source/variable controls, video/canvas live
support and the broader preservation/performance audits remain open.

## Inspected evidence (2026-10-03)

Upstream source: [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes),
commit `b7343e3a95791bdc3448eddd6f00b4e73128b345`. Read-only local reference at
`.local/hyperframes-upstream`. Upstream uses Apache-2.0; preserve its license and
notices if code is reused. The current Rust source-package code is original.

User reference directory: `C:\Users\etiez\OneDrive\Documents\ChatGPT\Brag`.
`brag-reconstruction-2026-10-03/advanced-audio-test-final` pins HyperFrames 0.8.91:
720×1280, 30 fps, 6 seconds. Its inline script generates the visual scenes.
`npx --yes hyperframes@0.8.91 timeline --json` from that project reports only the
authored narration row. This is direct evidence that static HTML extraction alone
cannot reproduce this user's composition layers. Inspection did not modify the
reference project or its version pin.

### UI and timeline

- Studio composes its existing timeline from lane, ruler, playhead and overlay
  parts (`packages/studio/src/player/components/Timeline.tsx`). Exported Studio
  components need host contexts; mounting the complete Studio would introduce a
  second editor state and does not meet this task.
- `timelineViewportGeometry.ts` selects a visible time window with overscan and
  preserves a row anchor when geometry changes. Useful for expanding nested
  compositions without jumping the scroll position.
- `useTimelinePlayerLoop.ts` reads the playback adapter and broadcasts time to
  direct DOM subscribers; React state is synchronized at transport boundaries.
- Visual inspection of the already-open Studio at `localhost:3002` showed a
  96.9-second Brag project: fixed track names and clip counts, compact labeled
  thumbnail clips, one toolbar, a central preview, and a contextual inspector.
  The useful improvement is hierarchy and readable selection/context, not merely
  copying its colors. The reference also reports lint errors; its appearance
  does not establish source correctness or performance.
- Classic already has indexed/virtualized track layouts and a playhead subscribed
  to playback events (`visible-track-layouts.ts`, `use-timeline-playhead.ts`).
  Measure remaining layout work before replacing these mechanisms.
- First Classic improvement: move its existing playhead with `translateX`
  instead of changing `left` every frame. Geometry, scrolling, keyboard seeking
  and canonical playback events remain in place. Browser timing measurements
  are still required before reporting a speedup.

### Source, layers and timing

- HTML/CSS/JS plus media form the project; `data-*` attributes describe authored
  timing. The live runtime resolves script-created nodes, media durations and
  expressions (`core/src/runtime/startResolver.ts`, `clipTree.ts`).
- A display lane is not compositing z-order. Preserve source CSS and host nesting.
- The same source can appear in multiple host slots. Use an occurrence-scoped key
  plus source-file identity, not a global author ID, to address child layers.
- A root composition must stay intact for fidelity: flattening its children into
  unrelated native text/shape clips loses CSS, shared animation and dependencies.
- Classic's existing `graphics/html-raster.ts` strips scripts/audio/video and
  rasterizes CSS fragments through SVG. Keep that feature; add a separate renderer
  for full HyperFrames compositions.

### Playback and rendering

- The runtime provides a common seek contract. Its transport clock can follow
  audio and handles stalls (`core/src/runtime/clock.ts`). One OpenCut transport
  must drive composition time, trim offset and speed.
- Engine services include browser pooling, `beginFrame` capture, streamed FFmpeg
  encoding and parallel capture. Their presence is not a measured speed claim.
- Use a persistent isolated composition runtime for preview and deterministic
  capture for export; rebuilding HTML or screenshotting it on every preview
  frame would discard the main performance advantage.
- All generated binary results must use the bounded `ArtifactStore`. Durable
  imported media belongs to project media storage, not expiring output artifacts.

## Implemented contract and migration status

**Canonical source contract, Classic command/view adoption, folder import UI,
isolated runtime, compositor frames and timeline audio integration are implemented.
Multiple live previews are implemented; full media/export parity remains pending.** No alternate timeline was added. The lazy browser binding runs the same
`OpenCutRuntime` and owns adopted Classic history and validated document changes.
Projects without an adopted session retain the existing Classic path.

### Folder ingestion and isolated runtime (2026-10-04)

- `hyperframes.package.plan` is a pure registry capability shared by native and
  browser hosts. It validates relative paths and byte counts, identifies HTML
  entry candidates, excludes `.git`/`node_modules`, and classifies source versus
  binary resources. Other folders are preserved, including assets referenced
  only by scripts. Duplicate paths and paths outside the package are rejected.
  Package paths stay in a case-sensitive URL namespace; they are not copied to
  matching Windows paths. Binary bytes use existing asset IDs in the media store.
- The browser adapter preserves UTF-8 source, including BOMs, Hebrew and CRLF,
  and rejects malformed UTF-8. Fonts, WASM and other binary data use the existing
  project media store with type `file`; they cannot be inserted as ordinary
  video clips. Existing audio, video and image types remain available.
- `@hyperframes/core` and `@hyperframes/player` are pinned to 0.8.115. The preview
  document uses their runtime injection helper and the original entry URL.
  Runtime composition loading retains author script order, module URLs, nested
  hosts and dynamic fetches. It does not write staging files or alter source.
- The loopback preview host exposes only package members on a random 192-bit
  `<token>.localhost` origin. It has no editor controls or account cookies.
  Hostnames must match exactly; CSP isolates scripts from the app, and media
  responses support byte ranges. Each host caps cached text at 64 MiB and eight
  previews, expires idle entries after 30 minutes, and supports explicit close.
  This is derived rendering state, not another editor document store.
- All eight Brag folders loaded in the in-app browser through the official player
  and accepted a seek to two seconds. Durations were 20, 15.5333, 15.5333, 20, 6,
  96.9, 6 and 6 seconds; the last was resolved by executing its generated scene.
  A separate fixture verified nested HTML loading and a JSON fetch relative to
  an entry below the package root. The reference files and version pins were
  unchanged. Audio was muted during this probe, so this does not establish audio
  output parity or smooth playback performance.
- Preparing and registering these previews took approximately 6–90 ms per
  project in this local probe, after loading the WASM runtime and reading files.
  This is not an end-to-end import or frame-rate benchmark. The ignored scripts
  and report are `.local/hyperframes-runtime-probe*` and
  `.local/hyperframes-player-probe.ts`.

The authenticated host and existing Classic compositor now use these adapters.
Importer UI, live DOM preview, media/audio synchronization and real-project export
parity remain pending. Do not expose the importer before its supported behavior
and failure reporting are complete.

### Persistent frame capture (2026-10-04)

- The Classic host adapter now uses `@hyperframes/engine` 0.8.115 for persistent
  capture sessions. An isolated page stays loaded across seeks. The adapter
  connects the official runtime's `__player.renderSeek`/`getDuration` to the
  engine's `__hf` protocol; timing and animation remain in HyperFrames.
- A small, tracked Bun patch lets the engine navigate the exact original entry
  URL and keeps Chrome's sandbox enabled, including its GPU probe. There is no
  general browser automation or filesystem endpoint. The adapter accepts only
  the validated package and explicitly resolved resource bindings.
- Each page has a private browser, package origin and read-only request policy.
  There are at most four sessions, two queued frames per session and a
  16-megapixel frame limit. Capture cancellation closes the browser, failed
  initialization releases the slot, and idle sessions expire after two minutes.
  The engine's required scratch directory stays empty and is removed on close.
- `storeArtifact` and `removeArtifact` expose the existing Rust ArtifactStore to
  the renderer host. PNG bytes receive canonical IDs, checksums, expiry and
  capacity eviction. Closing a capture leaves already returned artifacts valid
  in that store; no agent needs a temporary frame path.
- Browser tests verify nested entry paths, dynamic JSON, nested HTML, CSS seek
  positions, transparent pixels, authored body backgrounds, queue ordering,
  failed preparation, cancellation and close. The synthetic fixture produces
  identical PNGs when seeking 0.5 → 2 → 0.5 seconds.
- All eight real Brag projects produced three frames with these same seek
  checkpoints. Seven produced identical repeated PNGs. In
  `brag-reference-recreation/composition`, 79 of 921,600 pixels differed around
  the 3D phone edges (maximum channel difference 55; mean absolute channel
  difference 0.000360). Exact repeatability for this case remains unresolved.
  No original source was modified. Probe artifacts were first read from the
  canonical store and then saved by the ignored inspection script.
- On this machine, initialization took 1.14–1.68 seconds per project and frame
  capture plus artifact read/write took 85–414 ms. This was software-GPU PNG
  capture, not a playback benchmark. The adapter provides an export/compositor
  fallback; a live DOM preview path is still required for fluid playback.
- The ignored probe and report are `.local/hyperframes-capture-probe.ts` and
  `.local/hyperframes-capture-probe-results.json`. Audio mixing, decoded video
  injection, arbitrary author timer virtualization, comparison with original
  HyperFrames exports remain unverified or unimplemented. This adapter is not
  yet exposed as an import feature.

### Classic compositor and authenticated host (2026-10-04)

- `/api/hyperframes` uses the existing loopback/account authentication and exact
  account/project ownership for every session and artifact. It resolves only
  registered project media. A separate host runtime validates source and owns
  the bounded ArtifactStore; it never attaches an editor document or history.
- Preview, thumbnails and export supply the canonical composition map to the
  existing scene builder. HyperFrames frames enter `GraphicNode`, so native
  ordering, transforms, opacity, masks and effects use the existing compositor.
  Source time includes the clip's trim offset. Imported intrinsic dimensions
  are stored and validated; older clips without those dimensions still load.
- Browser clients keep at most two capture sessions, evict old sources, close on
  project/reset/export cancellation, and invalidate when media bindings change.
  Failed captures discard their session so a later render can open a fresh one.
  Each clip owns its canvas; bitmap handles close after each draw. Canvas version
  stamps refresh GPU textures after seeks and resource changes.
- A separate local test account on port 3165 used a 640×360, 30 fps, four-second
  project: a native blue image, a moving HyperFrames square at 50% opacity with a
  one-second source trim, and a native green image above it. The ordinary Classic
  timeline and inspector rendered the result. Seeking to 0, 2 and 3.5 seconds,
  a 40-pixel position edit, and Undo were checked through the editor UI.
- The normal MP4 export produced 120 H.264 frames, 640×360, 30 fps and exactly
  four seconds. Decoded frames confirm purple at the square's expected source
  positions (150 px initially and 250 px at two seconds), opaque green above it,
  and only native layers after the three-second trimmed clip ends. Sampled pixel values
  differ by at most two levels from the fixture colors after H.264 encoding.
  The generated file and extracted frames are in ignored
  `.local/hyperframes-mixed-render-proof/`. The reference folders and user
  projects were not modified.
- This is the capture fallback. It does not establish smooth playback, embedded
  audio/video fidelity, speed support, all effect combinations, or Brag export
  parity. More than two distinct visible sources may require repeated browser
  initialization; that path needs the planned live preview and measured caching.

- `hyperframes.project.inspect`: pure bounded source inspection, no script
  execution, filesystem reads or URL fetching. Reports authored elements,
  instance hierarchy, references and unresolved runtime needs.
- `timeline.hyperframes.import`: explicit project ID and expected revision;
  source becomes a typed `MediaAsset.hyperframes` and one existing `compound`
  timeline item. Omitted start appends; explicit start overlays. An existing
  video/overlay track can be selected; otherwise adds an overlay track to the
  same timeline. Native project resolution, frame rate and existing items stay
  unchanged. Registry projects MCP automatically.
- Registry idempotency metadata, dry run, cancellation checks, undo/redo and
  canonical `app.state.read` are covered by tests.
- Registry retry receipts now distinguish dry runs from commits, so reusing a
  request key after an import preview still performs the real write once.
- Source text is retained exactly. Binary dependency paths bind to existing
  OpenCut media asset IDs. Unbound dependencies are reported in inspection.
- Immutable source packages are shared across in-memory snapshots and undo
  history, while saved JSON remains self-contained. Asset lookup during document
  validation is indexed so native clips do not scan the whole asset library.
- Schema version 4 adds the optional composition payload; older documents
  migrate through the existing exact-time migration.
- The FFmpeg-only renderer rejects a HyperFrames source asset explicitly until
  its composition renderer is installed; it must never silently omit it.

### User-facing folder import (2026-10-04)

- The Assets panel's existing Import button retains ordinary media import. Its
  adjacent menu opens **HyperFrames project folder**. The dialog chooses an HTML
  entry, then places a new graphic track at the playhead, at the end, or at zero.
  After import the preview seeks to the new clip. Progress, cancellation and
  runtime failures are visible in that dialog.
- `timeline.hyperframes.import` now accepts optional `classicResourceAssets`.
  Canonical validation rejects unrelated, duplicate, transient or overwritten
  media bindings. Resources and composition enter the document in one mutation.
  A dry run validates the prospective import before copying any binary data.
- The host pins multi-request work to its initiating account/project/scene and
  abort signal. Runtime readiness supplies generated duration before the actual
  edit. Failed uploads and cancelled imports discard only copied resources owned
  by that attempt's random upload token. Finalization removes that token. Normal
  media deletion still retains bytes for Undo. A cleanup failure is reported;
  a save failure after commit retains the new clip and its files.
- Rust Undo removes the imported bindings and clip atomically. Classic's existing
  media history policy retains the durable library bindings when undoing the
  timeline insertion, so Redo uses the same copied files.
- Browser proof used the isolated render-verification account. A folder with two
  HTML entries, a local GSAP library and a PNG was selected through the real
  directory picker. `main.html` had no authored duration; its registered GSAP
  timeline resolved to four seconds. Appending at four seconds made an eight
  second project. Undo/Redo and exiting/reopening restored the composition and
  image. A second import at zero verified overlay placement. Hashes of all saved
  source strings and copied PNG bytes match the originals; evidence is in
  `.local/hyperframes-folder-import-proof.json`.
- A deliberately unresolved composition exercised runtime failure after upload.
  With staged cleanup enabled, both the file count and media-index count were
  unchanged after rejection. The successful import's upload token was removed.
- At this stage embedded audio was explicitly marked unsupported in the dialog
  (superseded by the timeline audio connection recorded below). The actual
  Brag folder verification below extends the synthetic flow. The other seven Brag
  UI imports, generated children, fast preview, video fidelity and crash recovery for staged
  uploads remain pending. The new folder export was invoked through the UI, but
  its downloaded MP4 could not yet be recovered for frame verification; the
  earlier synthetic compositor MP4 remains the verified export evidence.

### Canonical runtime in the browser

- `classic/rust/editor-runtime-wasm` exposes the live capability registry,
  read-only snapshots, portable session bytes and bounded artifact reads. It
  depends directly on `crates/editor-api`; it has no independent editor model.
- `loadCanonicalRuntime()` is an asynchronous import. The registry and JSON
  Schema validators live in their own WASM module. An initial combined build
  increased the main Classic binary from 3,919,268 to 10,021,797 bytes; the
  separate build restores the main binary to exactly 3,919,268 bytes; the lazy
  runtime module is 6,304,295 bytes. This is a size check, not a playback speed
  measurement. Build and export checks cover both packages. The dev launcher
  checks for both generated binaries, and Webpack/TypeScript resolve their
  local generated packages together to avoid stale Bun package copies.
- Platform clocks, random initialization and Tokio features now support
  `wasm32-unknown-unknown`. Native filesystem/process capabilities remain
  discoverable with an explicit unavailable reason in a browser. Metadata-only
  media registration, source inspection and canonical editing remain available.
- Session persistence now separates serialization/validated restoration from
  native filesystem access. A failed restore leaves the document unchanged.
  A successful restore clears old retry receipts so an earlier receipt cannot
  falsely claim that an edit exists after loading an older saved revision.
- Actual WASM execution under Node verifies mixed import, byte-for-byte source
  preservation, dry run followed by commit with the same retry key, stale
  revision rejection, undo/redo, session restore, invalid-restore rollback,
  native capability rejection and bounded artifact access. These are runtime
  tests, not an end-to-end Classic UI or rendering test.
- A read-only WASM probe inspected all eight Brag packages and imported the
  seven with authored numeric durations into one canonical timeline. Restoring
  the serialized session reproduced the document. The eighth package needs
  live duration resolution; no duration was guessed. Media remained unbound
  in this source-only probe. Local probe: `.local/hyperframes-wasm-probe.mjs`.
  The final release probe took 445 ms to initialize the registry and about
  4–18 ms per import on this machine under Node. This excludes resource copying,
  browser UI work, script execution and rendering; those still need measurement.

### Existing Classic document boundary

- Schema 5 adds optional `Project.classic`: the original serialized Classic
  project plus durable media records. Unknown project, scene and feature fields
  remain in that document. Validation checks identity, rational frame rate,
  canvas, scene/track/element IDs, integer timing and composition/resource links.
  File, URL and buffer handles are rejected in durable media bindings.
- `project.classic.attach` loads that document; `project.classic.commit` accepts
  a validated whole-project edit. Both require project ID and expected revision,
  support dry run and use the existing registry. Commits use canonical history.
  A Classic project cannot also contain a native timeline or native media list.
- `timeline.hyperframes.import` now branches on the document representation.
  For Classic it inserts a `graphic` element with definition `hyperframes` into
  the active scene's existing graphic lanes, using the 120,000-tick clock.
  The source lives once in `hyperframesCompositions` in the same Classic project.
  Omitted position appends to the active scene; explicit position overlays.
  Other scenes and the main project's duration are handled independently.
- The existing Classic timeline element, effect, mask, caption and Parallax data
  remains intact. Root/native FFmpeg rendering explicitly rejects Classic
  documents until routed to their renderer. The graphic definition, live preview
  adapter and import UI are not installed yet; this is not a usable import flow.
- The WASM `invokeSync` entry point uses the same live registry for an explicit
  list of immediate transactions. Async/native operations are rejected through
  this entry point. The tests exercise attach, import, read, commit, undo and redo
  through the real JS/WASM boundary, without an asynchronous gap in a command.
- Classic's history snapshot codec now preserves the complete project and scene
  fields while stripping transient audio buffers and excluding thumbnails from
  history. Storage serialization/deserialization likewise retains additional
  project and scene fields. A shared Classic fixture checks Parallax, captions,
  masks, effects, retiming, fonts, agent history, future fields and exact source
  text through registry edits, undo, redo, serialization and reopen.
- The bridge preserves exact `30000/1001` frame rates. Converting that value back
  from rounded decimal seconds would otherwise change the Classic clock.
- `project.classic.session.attach` can now adopt the current Classic document
  and both existing history stacks atomically into an empty runtime. Every
  boundary is validated against the same project before anything changes;
  stacks retain their order and support dry run and retry keys. The matching
  `project.classic.session.read` returns the canonical session for persistence.
  Inert host context travels with each undo/redo action so the UI can restore
  selection or identify a media side-effect callback. Rust never executes that
  context. The host now reconnects live command callbacks and its project/media
  views when it adopts that session.
- History undo/redo now checks explicit project and revision context before
  changing either stack. MCP treats Classic attachment as a lifecycle action,
  so it does not try to activate a project that has not been adopted yet.

### Classic CommandManager integration

- `CommandManager.enableCanonical()` lazily adopts the current project and both
  history stacks. New imports call `timeline.hyperframes.import` inside a
  canonical transaction, then publish the resulting scenes into the existing
  managers. No additional timeline or history stack is retained in JavaScript.
- Ordinary project and media setters validate their durable state in Rust before
  publishing it. Scene track/list updates publish only after project validation;
  deleting the active scene selects a surviving main scene. Preview commits also
  enter CommandManager before changing committed tracks.
- Nested commands share one transaction. Failed edits restore the canonical
  document, views, selection and redo history. Registry change notifications wait
  until commit, and rollback removes canceled retry receipts while retaining
  earlier successful receipts.
- Live callbacks preserve Classic's selective undo behavior and media add/remove
  side effects. Redo updates the previous-selection context, so its next undo
  returns to the selection made immediately before redo. Existing asynchronous
  media-file persistence still has its original failure handling; this bridge
  does not make those external writes transactional.
- Classic keeps its full live history, including more than 200 actions. Compact
  persistence retains the existing 100-entry limit and stops at commands with
  nonpersistent media side effects. Reopened history uses canonical snapshots.
  Media file/URL handles stay in the host and are excluded from the archive.
- `project.classic.session.archive`/`restore` store immutable source packages once
  per SHA-256 fingerprint. Both in-memory history and restored boundaries share
  source references. Corrupt, missing or mismatched source references reject the
  entire restore. Unknown composition properties remain intact.
- `project.classic.session.status` reads revisions, availability and inert
  selection/callback context without serializing source packages.
  `project.classic.synchronize` preserves existing history for host refreshes.
- Real-WASM CommandManager tests cover adoption, mixed import, selective undo,
  selection, nested commands, rollback, media callbacks and compact reopen. The
  import chooser, graphic definition, preview, export and browser verification
  remain pending. Ordinary Classic sessions load this module only when needed.

### Classic reference probe and history cost

A local Node/WASM probe imported the seven Brag projects with authored durations
into the existing Classic fixture, preserving its main video lane and prior undo
entry. It then committed 20 edits, undid all 20, exported both history stacks and
adopted the saved session into a fresh runtime. Source text, timeline content and
both stacks matched. The eighth project still needs its generated duration.

On this machine, runtime setup took 496 ms, source imports took 2.8–18.2 ms and
the median full-document commit took 9.1 ms (maximum 17.1 ms). These measurements
exclude media copying, rendering and browser UI work; they do not establish
playback performance. The source document was 2,190,960 bytes, but serializing
history produced 51,791,348 bytes. Process RSS reached 601 MB while holding two
WASM runtimes, JS snapshots and the round-trip archive.

After source sharing and compact persistence, the same source document and 20
edits produced a 2,343,201-byte archive. Process RSS was 151 MB with the same
two-runtime round trip. Setup took 580 ms, imports 1.6–21.9 ms, and full-document
commits a median 6.5 ms (maximum 9.0 ms). Source, both history stacks and existing
Classic tracks matched after restoration. These are Node/WASM storage and edit
measurements, not browser playback measurements. Probes are in ignored
`.local/hyperframes-classic-probe*` and `hyperframes-classic-compact-probe*` files.

## Preview cache verification (2026-10-04)

Classic now compares the bound resource values before invalidating HyperFrames
rendering. Canonical media republishing, loading notifications, names, thumbnails
and unrelated media no longer dispose the capture client. File/URL replacement,
binding revision, missing state and storage metadata still invalidate it. Values
are copied for comparison so in-place relinking is detected. Dependencies of
previously cached sources remain observed until reset, including after deletion
and restoration through Undo. Project/account changes invalidate old contexts.

The render client retains up to 24 decoded frames, capped at 64 MiB of estimated
RGBA storage. It reuses them across render-tree rebuilds and identical source
copies; eviction and disposal close the ImageBitmaps. Oversized frames are drawn
and immediately released. In-flight decoding after cancellation also releases
its bitmap without drawing. These are derived rendering caches; canonical editor
state and history remain in Rust.

An authenticated API probe used the imported synthetic GSAP folder at 640×360.
The first frame took 999 ms including session startup. Twenty identical-time
requests after cloning the projected document/media took 0.49–0.76 ms each and
made no additional capture requests. An uncached seek took 53 ms. Resetting the
cache and recapturing the original frame took 2,120 ms, including session close
and reopen. The decoded RGBA hash matched after reset, while seeking changed the
pixels. This probe decodes with Sharp and excludes browser/GPU paint time;
it is not a real-time playback benchmark. Evidence and the repeatable probe are
in ignored `.local/hyperframes-cache-proof.json` and `.local/hyperframes-cache-proof.ts`.

The actual editor also rendered a mixed native/HyperFrames timeline after moving
the red composition 48 px and restoring its position with Undo. The cache tests
cover bounds, cancellation, resource changes, source edits and account/project
switching. A separate real-WASM CommandManager test performs 20 canonical edits
plus Undo/Redo: media objects are republished while one open and one capture serve
all rendered requests. Fresh-frame capture, audio, multiple-composition browser
churn and the fast live preview remain outstanding.

## Runtime layers and Classic inspector (2026-10-04)

The isolated capture host now reads the official `__clipManifest` after runtime
readiness. Rust validates and persists its source fingerprint, runtime version,
resolved duration, bounded layer list, parent occurrence keys, package paths,
timing, media offsets/rates, natural durations and authored audio attributes.
Temporary preview URLs and host filesystem paths are not stored in the manifest.
Original source bytes remain the editing authority.

- `hyperframes.manifest.validate` is a closed-world Read capability.
  `hyperframes.manifest.set` updates an existing composition through a closed-world
  Write transaction with project/revision checks, idempotency, cancellation,
  dry run and undo. Folder import can commit the manifest with its resources and
  clip in the same transaction. Native and Classic documents use the same model;
  the browser UI is Classic-only. Live desktop MCP forwarding remains pending.
- The Graphic inspector shows a searchable, indented list of layers and their
  source times. Each row expands to show its file, media reference and timing.
  Rendering starts with 100 rows and offers more on demand. Existing imports can
  read their layers without reimporting. This operation reuses the project preview
  client, checks its scope and resource revision, and publishes through the
  canonical CommandManager. Local component state is limited to search, progress
  and disclosure controls.
- Preview clients release their sessions and decoded frames on a non-persisted
  `pagehide`, including reload/navigation. A page retained in the browser's
  back/forward cache keeps its client. This avoids consuming capture slots until
  idle expiry when the old document is already gone.
- Identity uses runtime IDs and composition ancestry, with a distinct DOM path
  for each occurrence. Repeated nested hosts are tested. Anonymous or ambiguous
  nodes retain observed timing and diagnostics without guessed source identity.
  The runtime list is not a complete inventory of every untimed decorative node.
- All eight Brag references loaded and yielded 176 layers, including 12 audio
  occurrences and 13 videos. The v2 recreation has 10 layers with unresolved DOM
  identity; the full reconstruction has 30. All media occurrences were observed.
  Narration, music and impact paths, timing and authored volumes were retained.
  Evidence: `.local/hyperframes-manifest-probe.ts` and its results JSON. This probe
  does not modify the Brag folders.
- The existing mixed Classic project displayed the image layer, package media
  path and 0–4s range. Reading layers on older imports persisted to the project;
  UI Undo/Redo removed/restored the manifest while keeping the clip and native
  tracks. A source containing only untimed CSS decoration can report zero layers.
- The actual Brag `advanced-audio-test-final` folder imported through the directory
  picker and appended at 8–14s, keeping the existing native and HyperFrames clips.
  Its four layers (Narration, Opening, Claim and Proof) appeared immediately with
  their resolved source times; the preview displayed its opening at project time
  9s. Reload preserved all four layers, the imported media and timeline placement.
  Layer search and source-file details worked after reopen. Hashes of all source
  strings and three copied binary resources match the originals, and all uploads
  were finalized. Evidence: `.local/verify-hyperframes-brag-proof.ts` and
  `.local/hyperframes-brag-import-proof.json`.
- Reload testing exposed intermittent black previews in the in-app browser.
  The same saved project rendered correctly in a fresh tab and on some reloads;
  other reloads kept the canvas black while seeking and playback time advanced.
  The capture endpoint still returned the correct Brag frame (saved as
  `.local/hyperframes-brag-reopen-frame.png`). Temporary diagnostics also recorded
  completed compositor renders during a black-preview run, without a console
  error. A later reload showed the correct frame and selection handles. The
  cause is unresolved; no speculative rendering fix or diagnostic code is
  included in this change. Reopen data preservation is verified, but reliable
  preview restoration needs a regression fix and repeatable browser coverage.

The inspector is read-only. Expandable child rows in the existing timeline,
child edits, variable editing, audio mixing/export and fast playback remain
outstanding. A manifest records observations; it does not implement audio
playback or guarantee identity for generated anonymous elements. Replacing bound
media invalidates rendering, but stored natural durations require another read.

## Preview startup and recovery (2026-10-04)

- A native-only control project rendered its blue image and green overlay after
  reload. The mixed project also rendered correctly during later reloads and
  seeks. Temporary pixel probes observed valid source and compositor pixels;
  they changed timing and do not identify the intermittent black-preview cause.
- A separate startup race was reproduced: project loading can request its
  thumbnail before the concurrently started GPU is ready. `CanvasRenderer` now
  waits for the shared GPU initialization before mounting or rendering output.
  Failed initialization can be retried. This applies to native and HyperFrames
  projects, preview, thumbnails and export consumers of that renderer.
- Preview renders lasting more than 250 ms show “Preparing preview…”. A failed
  render or canvas mount shows an error and a “Retry preview” button. Retrying
  also retries the canvas mount; it preserves the timeline and current time.
  Timers are cleared on completion and unmount. Fast frames do not display the
  preparation notice.
- Browser verification injected one temporary capture failure at project time
  9.5 s (Brag source time 1.5 s) in the isolated test account. The error appeared;
  clicking Retry preview reopened capture and displayed the correct Brag frame
  at the same time. The temporary server fault and pixel probes were removed.
- One regression test (13 assertions) covers delayed shared GPU startup,
  initialization failure, retry, thumbnail consumption and preview mounting.
  Four queue/output-scaling tests (11 assertions), scoped TypeScript and changed
  file ESLint also passed. This is a verified startup fix and failure-recovery
  improvement; reliable recovery from the separate intermittent black preview
  remains unproven.

### Audio rendering adapter (2026-10-04)

The pinned engine exports `parseAudioElements` and `processCompositionAudio`.
Its mixer owns fades, rate changes, effects, groups and automation, and writes
`audio.m4a` to preserve AAC priming metadata. The producer first resolves nested
media occurrences and then probes timeline volume changes before calling that
mixer. Reading only `<audio>` tags or copying the layer manifest is insufficient
for parity. The Classic host now uses these public engine APIs, the public core
media occurrence/group stamping helper and its volume-envelope probe. Timing
comes from the validated runtime manifest. A disposable page samples volume,
so future GSAP state cannot leak into the page used for visual capture.

- `hyperframes.audio.prepare` is a pure, cancellable Read capability in the
  canonical registry and WASM wrapper. It binds observations to the exact source
  fingerprint and pinned runtime, validates registered resource references,
  bounds timing/gain/rate/envelopes/effect JSON and checks consistent group
  settings. It replaces author-controlled mixer filenames with ordinal IDs.
  This derived plan does not alter the project, history or original source.
- The authenticated Classic render host exposes an `audio` action on an existing
  account/project-scoped session. It serializes audio work, shares concurrent
  requests, caches the artifact, checks expiry/eviction, supports cancellation,
  and keeps the visual session alive during mixing. Output uses the existing
  bounded ArtifactStore and scoped artifact reader. This is a Classic-only host
  adapter; native rendering and playback are not migrated by this change.
- Resource staging copies only registered inputs under generated filenames in
  a host-created scratch directory. FFmpeg/FFprobe paths are host configuration.
  The official media probe discovers audio in videos without authored metadata
  and skips silent videos. Authored mute, hidden ancestors and hidden buses are
  retained. Mixer failures and degraded automation fail explicitly.
- Work limits: 30-minute composition, 32 media nodes in the browser probe,
  32 planned tracks, one hour combined track duration, 100,000 envelope samples,
  4 MiB plan, 512 MiB staged resources and 64 MiB output. Audible looping media,
  unresolved source identity, media outside the imported package and clip windows
  outside root or nested composition bounds are rejected explicitly. Silent looping videos
  are skipped. These cases need further support before full parity is claimed.
- `classic/scripts/build-hyperframes-audio-probe.ts` regenerates the browser
  helper from pinned core implementations. Its Apache license and attribution
  are included under `classic/licenses` and `classic/THIRD-PARTY-NOTICES.md`.

Verification:

- 29 Rust import/package/manifest/audio tests passed. Five audio tests cover
  invalid plans, source/resource boundaries, cancellation, safe IDs, repeated
  preparation of 12 independent buses, nested-window preflight and unchanged
  canonical state. A real Chrome probe of nested audio extending past its host
  timed out; the canonical manifest check now rejects that unsupported window
  before evaluating the audio probe in the page. Cleanup of that fixture still
  reaches the engine timeout and forces browser shutdown; faster cleanup remains
  a follow-up.
- Nine real Chrome capture/audio/host tests passed (119 assertions), including
  repeated nested audio, timing, rate, fades, separate group gain, authored mute,
  GSAP volume above unity, video stream discovery, audio artifact ownership,
  concurrent cache reuse and continued visual capture after audio probing.
  Decoded PCM verifies the expected silent gaps and per-channel RMS amplitude.
- All eight Brag references rendered audio through the host. The six-second
  `advanced-audio-test-final` narration has zero sample offset against its source
  at 8 kHz, correlation 0.9999189 and gain 0.998223 after AAC encoding. Decoded
  output includes 16 ms trailing codec padding; timeline playback must use the
  canonical six-second clip window. This is audio-source comparison, not a
  downloaded mixed Classic export comparison.
- Local evidence: `.local/hyperframes-audio-probe-results.json`,
  `.local/hyperframes-audio-correlation.json` and
  `.local/hyperframes-brag-audio-0.m4a` through `-7.m4a`.
- The actual authenticated `/api/hyperframes` route also rendered narration from
  the imported mixed Classic project. Artifact checksum matched the standalone
  probe, a repeated request reused the same handle and another project received
  HTTP 404. Evidence: `.local/hyperframes-audio-api-proof.json` and
  `.local/hyperframes-brag-audio-api.m4a`. The isolated test server was restarted
  after rebuilding WASM so its process held the new runtime and host class.
- Scoped TypeScript, changed-file ESLint, editor-api Clippy, WASM export checks
  and nine real-WASM CommandManager tests (129 assertions) passed.

### Classic timeline audio connection (2026-10-04)

- `hyperframes.audio.clips.read` reads a project, scene and exact revision from
  the canonical runtime. It projects compound placement, trim, gain and volume
  animation into existing Classic audio mixer inputs. These are derived views;
  no additional document tracks or history entries are created. Source duration
  bounds exclude AAC padding. Visual hiding does not mute audio; explicit clip
  or track mute does. Graphic looping/retime remains unsupported by the visual
  source and is not introduced only for audio.
- The account/project-scoped render client checks artifact size and SHA-256,
  shares duplicate requests, caches silence, and retains at most eight audio
  files / 64 MiB. Resource replacement and project/account changes invalidate
  audio and frames together. Failed reads can be retried.
- Playback waits for compound audio through its existing preparation mechanism.
  The same clips feed export's decode cache, gain automation and mastering.
  Decode/mixer failures fail the operation; playback displays the error and
  pauses. Export cancellation now covers audio preparation as well as frames.
  The existing parallax playback mapping also receives these derived clips.
- Native Rust and real WASM tests cover placement, trim, authored duration,
  hidden/muted behavior, revisions, source identity, unchanged state, host edits
  and Undo/Redo. Collector tests verify shared decoding across multiple cuts and
  propagation of missing-audio errors. Thirty targeted Rust tests passed, as did
  ten real-WASM CommandManager tests (138 assertions), six audio client/cache
  tests (185 assertions), and one collector test (six assertions). Scoped
  TypeScript, changed-file ESLint, editor-api Clippy with `-D warnings`, release
  WASM build, and the 37 legacy / 13 canonical export checks passed.
- An actual audio-enabled Classic export produced a 14-second H.264/AAC MP4
  (640x360, 44.1 kHz stereo, 814,607 bytes). It contains native narration at
  0–5 seconds and the Brag composition at 8–14 seconds. Decoded PCM compared
  against the original narration at 8 kHz has zero lag for both, correlation
  0.999953 for native audio and 0.999871 for compound audio; the 5.2–7.8-second
  gap has zero RMS. The frame at 9.5 seconds shows the expected Brag text/circle.
  Evidence: `.local/hyperframes-native-and-brag-audio.mp4`,
  `.local/hyperframes-export-audio-check.json`, and
  `.local/hyperframes-audio-export-frame.png`. Export cancellation also returned
  the normal export form through the UI. Playback preparation completed and the
  playhead reached the end; audible live playback and smooth performance have
  not been established by this export check.
- Splitting the Brag clip through the normal timeline toolbar at 9.5 seconds
  (source offset 1.5 seconds) and exporting again preserved the entire decoded
  audio exactly. Both MP4s decode to the same float PCM SHA-256,
  `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  The split export passes the same timing/correlation checks. Evidence:
  `.local/hyperframes-split-native-and-brag-audio.mp4`,
  `.local/hyperframes-split-export-audio-check.json`, and the actual editor
  screenshot `.local/hyperframes-split-audio-timeline.png`. Undo through the
  editor restored the single compound clip after this check.
- Adding the imported narration resource as an ordinary native clip defaulted
  to five seconds because package resource metadata lacks its media duration.
  The native comparison above uses that actual five-second clip. Resource
  metadata probing is a follow-up; the compound itself retains its six seconds.
- Transcription and standalone audio extraction use separate entry points and
  do not yet include compound audio. Child audio controls, waveform display,
  live preview performance and the remaining unsupported nested windows need
  follow-up work.

### Composition layers inside existing tracks (2026-10-04)

- `hyperframes.layers.timeline.read` projects one Classic compound clip into
  ordered child rows. Rust preserves occurrence keys and hierarchy, intersects
  each layer with its ancestor windows and the compound's trimmed source window,
  and returns timeline ticks. Reads require an explicit project, scene, element
  and revision. No source execution, document changes or additional tracks occur.
- Existing track headers expand/collapse these rows beneath the compound. Labels
  remain in the fixed column, time bars share the existing ruler, and both use
  the same height in scrolling, selection and drop geometry. Rows are rendered
  only near the vertical viewport and bars near the horizontal viewport. Native
  clips, keyframe expansion and the existing timeline remain in place.
- Clicking a row selects its compound and seeks to that row's timeline start.
  This respects the existing AI range lock. Expansion is temporary view state;
  timing/identity are read from the canonical registry after edits and history
  changes. Projects lacking a runtime manifest direct the user to read layers
  in the inspector.
- Actual Brag UI verification: Narration spans 8–14 seconds, Opening 8–9.75,
  Claim 9.75–11.6 and Proof 11.6–14. Clicking Claim seeks to 9.75 seconds.
  Splitting there leaves Opening in the left clip, Claim/Proof in the right,
  and clips narration to each side. Undo restores the original four rows.
  Collapse restores ordinary track height. Enter expands the row without
  invoking the global jump-to-start shortcut; Space activates Proof at 11.6
  seconds without starting playback. All eight visible layer buttons become
  disabled while AI range selection is armed and recover when cancelled.
  Evidence: `.local/hyperframes-expanded-timeline.png`. Independent child timing/source
  edits are still pending; these bars currently navigate and show structure.
- Fourteen Rust source/manifest/Classic-layer tests, ten real-WASM command tests
  (141 assertions), thirteen existing track visibility/hit-testing tests
  (17 assertions), scoped TypeScript, changed-file ESLint and editor-api Clippy passed. Release WASM
  and its existing export contract were rebuilt and verified.

### Preview capture resolution and measured cost (2026-10-04)

- The persistent screenshot adapter now samples previews at the resolution
  needed by the output canvas and the resolved layer scale. It rounds upward
  to 1/8, 1/4, 1/2 or full resolution. The authored CSS viewport, source size,
  timing, source package and canonical document remain the same. Only derived
  PNG pixels change. The existing Classic compositor still controls layer order,
  transforms, opacity, masks and native/HF combinations.
- Preview frame and GPU invalidation keys include sampling resolution. Export
  forces full source resolution and cannot reuse a reduced preview bitmap.
  Capture options change only inside the serialized queue and are restored
  afterward. PNG header dimensions are checked and stored in ArtifactStore.
  Perspective, clip effects, scene effects, nested scenes and parallax retain
  full source captures because subsequent camera/effect stages can magnify them.
- On Windows / HeadlessChrome 152, three real Brag packages were sampled at
  0.5–1.067 seconds (18 sequential frames, first three omitted from statistics).
  The software-rendered host's median request-to-artifact times were:

  | Package | Full source | Half dimensions | Quarter dimensions |
  | --- | ---: | ---: | ---: |
  | `advanced-audio-test-final` | 153.8 ms | 64.4 ms | 50.4 ms |
  | `brag-vertical/composition` | 369.6 ms | 135.0 ms | 74.0 ms |
  | Reconstruction 96.9-second composition | 98.6 ms | 89.9 ms | 81.1 ms |

  These measure the isolated render host, excluding editor transport, bitmap
  decode and composition. The third sample covers only its opening second;
  it does not establish performance or repeatability of its later 3D scenes.
  At a fixed 1080x1920 frame, PNG screenshot encoding itself took 277 ms with
  hardware acceleration, versus 118 ms at half dimensions. WebP was not a
  consistent improvement: its 85-quality path was slower on partial-alpha
  content. Hardware acceleration alone did not remove the capture bottleneck.
  The product retains its existing PNG/software path with adaptive preview
  sampling. This is an interim improvement; a live DOM preview path is still
  required for smooth playback. Full intrinsic offscreen targets remain in use.
- Browser tests verify partial alpha, nested content at the source's far edge,
  forward/reverse seeks, concurrent mixed-resolution requests, invalid sampling
  rejection, and exact full-resolution pixels after a preview request. Cache and
  real-WASM scene-builder tests verify viewport resizing, source trim/placement,
  one shared browser, and full-resolution export. The real capture/host suite,
  frame cache/client tests, scoped TypeScript and changed-file ESLint passed.
  Eight existing transform, static-cache and frame-scaling checks passed using
  a local preload of the actual Classic WASM; their default Bun invocation
  still needs a harness fix for the generated `.wasm` module import.
- The actual Classic UI sought among Brag sections and exported the mixed
  14-second project after reduced preview captures. Its entire decoded video
  and float PCM exactly match the earlier full-resolution export:
  video SHA-256 `b76a85a1dc793e6618def4ebf34a1a458ae1e3871433b8fcc04eb1a112b73631`,
  audio SHA-256 `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  Evidence: `.local/hyperframes-after-preview-scaling.mp4`,
  `.local/hyperframes-scaled-preview.png`, `.local/hf-perf-software.json`,
  `.local/hf-perf-scaled-0.5.json`, `.local/hf-perf-scaled-0.25.json`, and
  `.local/hf-encoding-benchmark.json`. Sampling decisions and capture caches are
  platform rendering resources, so this adds no editor state or MCP mutation.

### Isolated live DOM preview (2026-10-04)

- The existing Classic preview now places an eligible topmost HyperFrames DOM
  layer over the compositor canvas. It uses the same render-tree timing, source
  trim, animation resolution, fit, rotation, scale, flips and opacity as the
  capture path. The authored viewport stays at its intrinsic dimensions and the
  surface scales to the existing preview. Native layers below it still render
  through the shared compositor. Selection handles and timeline navigation stay
  in the existing editor. Export always uses the complete capture/compositor path.
- Eligibility is deliberately limited to an unmasked, normally blended topmost
  compound without clip/scene effects, perspective, parallax or nested scene
  rendering. The isolated bridge rejects video/canvas layers, external resources,
  runtime failures and unsupported navigation. These cases automatically use
  the existing capture adapter; they remain supported by that adapter. General
  interleaving of native and multiple DOM surfaces is still pending.
- Live delivery is opened through the account/project-scoped render session. A
  trusted outer shell constrains the authored inner frame to its random package
  origin, including after attempted navigation. Both frames have opaque sandbox
  origins. Their only accepted commands are sequenced seeks; acknowledgements
  never invoke editor actions. CSP limits live resources to the registered
  package. Closing the session revokes delivery. The existing preview byte/count
  limits include the generated shell.
- Classic remains the audio owner. The bridge mutes media elements and runtime
  output, and prevents Web Audio nodes from connecting to the physical output
  destination while leaving analysis graphs usable. A browser test explicitly
  enables autoplay, starts authored audio and an oscillator, and verifies muted
  media plus zero connections to the output device. This avoids relying solely
  on the browser's autoplay permission policy.
- One of the client's existing two session slots is reserved for the current
  live surface. Preparing audio, thumbnails or captures for other compositions
  cannot evict its resources. Export, disposal and a return to capture release
  that reservation; both slots remain available to mixed-frame rendering.
  A replaced handle cannot release the new reservation. Switching project/account or replacing a resource
  still invalidates the derived resources. No additional editor state, timeline,
  document migration or mutation capability was introduced.
- Two real Brag packages were compared at source times 0.5, 2.5 and 5 seconds:
  `advanced-audio-test-final` (720x1280) and `brag-vertical/composition`
  (1080x1920). All six full-resolution RGBA comparisons were exact. In the latest
  software-Chrome run, 90 sequential seeks per package (first five excluded)
  had median acknowledgement times of 1.5 and 1.9 ms, with p95 of 2.6 and 8.2 ms.
  These timings measure the isolated live seek/relay, excluding paint, native
  composition and editor scheduling; they are not end-to-end playback FPS.
  The 96.9-second reconstruction correctly chose capture because it has canvas
  content. Its later 3D repeatability remains unverified.
- Tests cover fractional-frame flooring, repeated/reverse seeks, partial alpha,
  navigation blocking, media/Web Audio silence, exact account/project ownership,
  session close revocation, source revision invalidation, bounded session
  retention during other renders, canonical trim/transform projection, layer
  order, export exclusion, reservation release and runtime fallback. The real capture/live/host suite
  passed seven tests (102 assertions); the scoped cache/host/client and real-WASM
  renderer suites also passed. Actual UI playback reached the mixed project's
  end with the live surface still present after audio preparation.
- The actual 14-second mixed-project export after this change is identical to
  the previous capture-only preview export after decoding: video SHA-256
  `b76a85a1dc793e6618def4ebf34a1a458ae1e3871433b8fcc04eb1a112b73631`,
  float PCM SHA-256
  `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  The DOM surface was removed during export and restored afterward. Scoped
  TypeScript, changed-file ESLint and eight existing transform/static-cache/
  output-scaling checks (with the local real-WASM preload) passed.
- Local evidence: `.local/hf-live-benchmark.json`,
  `.local/hyperframes-live-benchmark.ts`, `.local/hf-live-*-*.png`,
  `.local/hyperframes-after-live-preview.mp4` and
  `.local/hyperframes-live-preview.png`.

### Native layers above live DOM compositions (2026-10-04)

- The topmost restriction described above is lifted for ordinary native layers
  using normal blending. The preview derives a native base and foreground from
  the existing render tree, places the live compound between them, and preserves
  the original order. Text, image, video, sticker and graphic nodes remain on
  their existing renderer paths. No document fields, editor state or capabilities
  were added; this is a Classic-only rendering improvement.
- The shared compositor prepares both native groups before submitting their
  output. It copies the foreground with transparent pixels into a separate canvas,
  then restores the opaque base without an asynchronous gap between submissions.
  A `copy` operation clears pixels from moved or ended clips. Texture IDs are
  distinct between the groups, and both groups are synchronized together so
  alternating renders do not evict and re-upload their textures every frame.
- The compositor's WebGPU surface now requests premultiplied output. This is
  restricted to compositor surfaces; other GPU effect-output surfaces retain
  their existing configuration. wgpu 29's browser implementation accepts this
  mode despite listing only Opaque in its capabilities. WebGL retains its
  supported surface mode and default alpha/premultiplied-alpha context settings.
- Direct browser checks with the rebuilt WASM passed on WebGPU and forced WebGL:
  empty pixels are `[0,0,0,0]`, half-alpha red at half opacity produces
  `[255,0,0,64]`, the sampled hybrid foreground/base matches the complete GPU
  composition exactly, and an ended foreground leaves no pixels. These are
  controlled 64x36 alpha/compositing checks, not complete media or FPS coverage.
- In the actual Classic UI, an ordinary text clip was added above the imported
  `advanced-audio-test-final` compound at 10.5 seconds. Content, font size,
  position and 0.65 opacity edits kept the live iframe visible with a native
  foreground canvas. Multiply removed the live surface and used capture;
  returning to Normal restored the live surface and foreground. Seeking beyond
  the compound's end removed the live surface; seeking backward restored it.
- The test text was temporarily removed to export the same 14-second baseline.
  The downloaded MP4's decoded video and float PCM hashes exactly match the
  hashes recorded in the preceding section. Undo restored the native text after
  export, and the live preview resumed with the foreground canvas. The verified
  export is `.local/hyperframes-after-native-live-overlay.mp4`.
- Renderer startup/queue tests passed two tests (23 assertions), the real-WASM
  scene/live tests passed three (35 assertions), and eight existing transform,
  static-node and output-scaling checks passed (19 assertions). Tests cover
  foreground order, native blend fallback, source timing, non-mutating tree
  partitioning, texture ID separation and opaque-base restoration even if the
  foreground copy fails. Scoped TypeScript, changed-file ESLint, targeted Rust
  formatting and both WASM export manifests passed.
- One compound is live at a time. Other HyperFrames compounds in the base still
  use capture. Backdrop-dependent native blend modes, scene effects, camera,
  parallax and unsupported compound content retain the full capture path.
  Multiple live surfaces, native video-specific browser checks, dynamic source
  changes and measured end-to-end playback FPS remain pending.
- Evidence: `.local/hyperframes-native-text-live.png`,
  `.local/hyperframes-with-live-native-overlay-project.json`,
  `.local/hf-overlay-gpu-probe.html`, `.local/hf-overlay-webgpu-result.json`
  and `.local/hf-overlay-webgl-result.json`.

### Measured Classic playback and remaining capture bottleneck (2026-10-04)

The editor now has an opt-in playback probe at `?renderPerf=1`. It records
completed preview frames, distinct timeline frames, gaps between those frames,
render duration, lag behind the existing playback clock and failed renders.
Preparation and paused editing are excluded. Seek, stop and disposal delimit
measurement windows, and stale in-flight frames cannot contaminate a later run.
Windows contain at most 240 completed samples. Console output stays local and
contains numeric diagnostics rather than source content. The existing pipeline
profiler also emits a JSON summary for inspection.

For controlled comparisons, adding `&hyperframesPreview=capture` disables live
surfaces for that document while retaining the same project, source, audio,
native renderer and preview resolution. This override requires diagnostics to
be enabled and does not change the saved project or export behavior.

Two six-second benchmark projects were prepared through the existing scoped
project/media APIs using the imported `advanced-audio-test-final` source. Both
use a native blue image, native translucent text and the compound's audio. The
second places two occurrences of the **same source and time** side by side.
This does not establish performance for different source packages.

| Actual editor scenario | First / repeated completed frames per second | First / repeated median render time | First / repeated p95 render time |
| --- | --- | --- | --- |
| One live compound between native layers | 29.24 / 29.21 | 3.1 / 3.0 ms | 7.0 / 6.5 ms |
| Same project, capture override | 10.00 / 9.17 | 75.6 / 82.7 ms | 127.4 / 154.1 ms |
| Two occurrences, current one-live/one-captured path | 9.84 / 9.84 | 79.0 / 81.4 ms | 139.3 / 129.9 ms |

- Target: 30 fps. Each run lasted approximately six seconds and reported zero
  render errors. The live runs completed 175 distinct frames each. The capture
  runs completed 60 and 55; the two-occurrence runs completed 59 each. The latter
  had mean transport lag around 80 ms. These are render-completion rates in the
  actual Classic UI, including source resolution and native composition, not
  physical display-refresh measurements or isolated seek acknowledgements.
- Environment: the same local Next.js webpack development server and Codex
  in-app browser, a 1280x720 browser viewport, DPR 1, a 640x360 logical scene and
  a 451x253 compositor output. The browser panel was hidden and the document
  reported `visibilityState: visible`. Production builds, visible-panel timing,
  full-screen playback and other devices remain unmeasured.
- The repeated two-occurrence pipeline summary attributes about 81.5 ms per
  frame to source resolution (two measured groups), about 1 ms to the two GPU
  submissions, and about 0.4 ms to texture synchronization. The existing generic
  `preview.frame.interval` statistic includes pauses between runs; use the new
  playback-only reports for throughput. Capture remains the dominant cost.
- These measurements identified the need for multiple live occurrences and
  explicit session lifetimes. At that checkpoint, one live surface pinned one
  of two client sessions and retained a headless capture browser. The host
  separation below removes the retained browser; the subsequent multiple-live
  implementation also removes the measured extra screenshot from this case.
- Probe tests passed three tests (nine assertions), covering disabled and paused
  collection, duplicate frames, late completion after seek/pause, bounded
  windows and failure counts. Scoped TypeScript including the new tests and
  changed-file ESLint passed. No canonical state or capabilities were added.
- Local evidence: `.local/hf-editor-playback-benchmark.json` (six raw reports
  and pipeline summaries), `.local/hf-playback-fixtures.json`,
  `.local/hf-playback-fixtures.ts`, and
  `.local/hf-playback-two-compositions.png`. Benchmark project IDs are
  `e8b3c007-9ed8-4cd1-a75f-c04c394814e9` and
  `28760c93-3b7d-4ff2-98b9-026ae72e0597` in the isolated integration account.

### Release capture browsers while live previews are displayed (2026-10-04)

The Classic render host now retains validated metadata, source resources and
live delivery independently of its headless capture browser. Promotion to a
live preview closes Chrome and revokes its original capture URL. A subsequent
screenshot or export opens a new sandboxed capture on demand. Returning to
live delivery closes that capture and reuses the existing live URL.

- Each scoped entry serializes screenshots and promotion. An active capture
  finishes before its browser closes; queued capture cancellation does not
  interrupt an earlier frame. Closing the entry aborts loading and queued work.
- The host retains at most six scoped entries. The existing four-browser and
  eight-origin bounds remain. Six live delivery origins leave two origins for
  one screenshot session and one disposable audio probe. This is a bounded
  resource budget, not a promise of six simultaneously displayed UI surfaces.
- Heartbeats retain metadata and live resources without launching Chrome.
  Entries idle for two minutes expire even after their capture browser has
  closed. Completed artifacts retain their normal scoped ArtifactStore lifetime.
- Two real-browser tests passed with 61 assertions: exact account/project
  isolation, original URL revocation, identical PNG after reopen, reduced-size
  capture, stable live URL, six retained live sources, audio probe capacity,
  entry limits and slot reuse. Four controlled lifecycle tests passed with 24
  assertions, including overlapping promotion/capture, lazy-open cancellation,
  queued cancellation and idle expiration. Scoped TypeScript and changed-file
  ESLint passed.
- Actual Classic UI verification used the existing six-second Brag benchmark:
  playback completed 169 distinct frames at 28.21 fps with zero render errors
  (development build, same 451x253 compositor viewport). MP4 export then
  reopened capture successfully: 180 H.264 frames at 640x360 plus AAC audio,
  420,573 bytes. FFmpeg decoded both streams without errors. Seeking to 2.5 s
  after export restored the live composition and native foreground text; the
  development server had no remaining Chrome child. This is a lifecycle
  regression check, not evidence of a throughput improvement over the previous
  single-live measurement. Evidence: `.local/hf-after-capture-release.mp4`,
  `.local/hf-after-capture-release.png` and
  `.local/hf-after-capture-release-playback.json`.
- This changes derived rendering resources only. Canonical state, timeline
  behavior and capabilities are unchanged. Multiple client leases, occurrence
  identity and multiple native/live segments were the next performance work,
  implemented and measured below.

### Multiple live compositions in the existing timeline (2026-10-04)

Classic now displays up to four eligible HyperFrames occurrences as independent
live surfaces. The scene builder supplies each canonical clip ID alongside its
source identity. Repeated source packages share delivery resources while each
iframe seeks its own trimmed source time and uses the clip's placement, opacity
and layer order. Reordering changes CSS stacking without reparenting iframes.

Native layers below, between and above these surfaces remain in the existing
GPU compositor. Each native segment above the base uses a transparent canvas.
All segments are prepared first, their textures are synchronized together under
distinct IDs, and their canvases are copied before the opaque base is restored
without an asynchronous gap. Ended native layers clear their previous pixels.

- The client reserves sources through independent, idempotent occurrence
  leases. Releasing one occurrence cannot evict another occurrence using the
  same package. Four source reservations leave one ordinary capture cache slot;
  releasing them trims back to the original two-session LRU.
- Effectful copies can still require screenshots while another occurrence of
  their source is live. Only one such pinned source keeps a warm capture browser;
  switching capture sources releases the previous browser through the existing
  host promotion while preserving its live URL. This leaves capacity for the
  ordinary capture slot and disposable audio probe.
- Backdrop-dependent blends and scene wrappers stay below the selected live
  surfaces. Masks, unsupported perspective, canvas/video content and runtime
  failures continue through the full capture path. Export retains that path.
  These limits remain part of the incomplete broader integration.

Actual playback of the unchanged two-occurrence Brag benchmark at 451x253
compositor pixels in the same development browser improved from **9.84 / 9.84
fps** to **28.37 / 28.85 fps**. The new runs completed 170 / 173 distinct frames
with zero render errors; median render time was 3.9 / 3.5 ms and p95 was 26.1 /
23.8 ms. This measures completed preview renders against the existing transport,
not physical display refresh. Production, full-screen and broader-project
measurements remain outstanding. Reports: `.local/hf-multiple-live-playback.json`.

The two-occurrence project exported both from live preview and from the capture
override. Both files are 528,101 bytes. All decoded video frames match
(`118e1939b029bff83bf52b6696b2ee023de8629ca5d4a04d2fbc787573abad12`)
and decoded float PCM matches
(`54b3d756f534a52c8aa4ccb7555c40b3d92f8ad656c9bfdfdc4e9692fe399f20`).
Evidence: `.local/hf-multiple-live-export.mp4` and
`.local/hf-multiple-capture-export.mp4`.

A separate isolated project (`fa29717a-140f-40e2-a2be-32f24aa601f6`) verified
overlapping occurrences with a one-second source offset, a native text layer
between them and another in front. At 1.5 s the compositions showed different
source states and correctly occluded the middle text. At 2.5 s that text had
ended and no yellow pixels remained visible. At 5.5 s the trimmed occurrence
had ended: only one iframe and one foreground canvas remained. Evidence:
`.local/hf-interleaved-fixture.ts`, `.local/hf-interleaved-live-1_5.png`,
`.local/hf-interleaved-live-2_5.png`, `.local/hf-interleaved-live-5_5.png`.

Verification: three real-WASM render-tree tests passed (62 assertions), seven
client/cache tests passed (236 assertions), and two renderer queue tests passed
(30 assertions). Coverage includes shared-source timing, canonical occurrence
IDs, native segments, reordering, blending fallback, the four-surface bound,
lease release, capture browser rotation, and uninterrupted GPU copy order.
Scoped TypeScript and changed-file ESLint passed. No editor state, capabilities,
source packages or saved production projects were changed by this adapter work.

## Complete Brag folder import and timeline navigation (2026-10-04)

The seven remaining references were selected with the actual browser folder
picker in an isolated Classic project. The first was imported into an empty
timeline; the following six used **After existing clips**. Together they form a
179.9667-second sequence. All seven reopened and rendered at a sample two seconds
into their own source; the separately verified `advanced-audio-test-final` brings
actual Brag UI import coverage to all eight references.

| Brag folder | Start (s) | Duration (s) | Source files | Copied resources | Runtime layers |
| --- | ---: | ---: | ---: | ---: | ---: |
| `brag-vertical/composition` | 0 | 20 | 9 | 27 | 18 |
| `brag-reference-recreation-v2/composition` | 20 | 15.5333 | 10 | 25 | 27 |
| `brag-reference-recreation/composition` | 35.5333 | 15.5333 | 8 | 42 | 17 |
| `brag-output/composition` | 51.0667 | 20 | 11 | 36 | 20 |
| `brag-reconstruction-2026-10-03/advanced-audio-test-v2` | 71.0667 | 6 | 9 | 2 | 4 |
| `brag-reconstruction-2026-10-03/composition` | 77.0667 | 96.9 | 16 | 131 | 82 |
| `brag-reconstruction-2026-10-03/advanced-audio-test` | 173.9667 | 6 | 9 | 2 | 4 |

The persisted 72 source files and all 265 resources match the reference bytes by
SHA-256, with no remaining upload tokens. Fonts, narration, images and binary
resources resolve from project storage after reload. The importer preserves
package members, including generated thumbnails and preview files. It does not
filter those outputs yet; they can clutter the Media panel. Generic folder names
also produce several clips called `composition`, which needs a naming control.
No reference file was edited. This check establishes import, persistence and
sampled preview coverage, not full export or audio playback parity for all eight.

The UI exercise exposed two navigation issues, now addressed:

- **Fit timeline to view** uses the existing zoom controller to display the full
  duration in 90% of the current track viewport. It starts at zero, keeps the
  playhead time, and persists through the existing timeline view-state setter.
  It includes displayed caption/AI timing when that extends beyond ordinary
  clips. It also resets a manually scrolled view when its zoom is already fitted.
  Zoom buttons now have explicit accessible names. This is a Classic viewport
  improvement; no document content model or second timeline was introduced.
- Scroll measurement previously retained a canceled animation-frame ID across
  React Strict Mode's effect cleanup/setup. Updates then stayed disabled, so the
  ruler and virtualized viewport could remain at zero width. Each observer
  setup now owns and cleans up its own scheduled frame. Browser verification
  showed labels through the full three-minute sequence and working scrolling.

Evidence: project `c2402764-34c5-44fc-a700-c57dfc1a3479` in the isolated integration
account, `.local/hf-brag-folder-audit.json`, `.local/hf-brag-reopen-1.png` through
`-7.png`, and `.local/hf-brag-timeline-fit-final.png`. The audit script rereads saved
project state and hashes imported source/resources against the original folders.
Controller tests cover fitted geometry, unchanged playhead, scroll reset,
viewport resizing, empty/short timelines and limits. The observer lifecycle test
covers cleanup/setup, coalesced scroll events, resize and listener removal.
Nine focused timeline tests passed (31 assertions), scoped TypeScript passed,
and changed-file ESLint reported no errors, with one pre-existing event-target
assertion warning in the zoom controller. Browser checks also confirmed that
the fitted view survives reload and the saved playhead near 176 seconds renders
the final generated composition once resource preparation finishes.

## Next implementation sequence

1. All eight Brag UI imports and durable resources are verified. Verify downloaded
   exports across the remaining references and add recovery for a crash during
   staging. Improve imported clip naming and generated-resource visibility.
2. The synthetic folder flow now covers import, Undo/Redo and reopen. Source sharing, compact persistence, history adoption,
   media callbacks and canonical view projection are implemented and covered by
   real-WASM tests. The native MCP process still reaches the live editor through
   the existing Classic bridge; forwarding newly registered capabilities to that
   browser runtime needs a transport contract and tests.
3. The measured two-occurrence bottleneck is resolved for eligible live content.
   Verify four distinct packages and mixed live/captured occurrences in the UI;
   extend video/canvas and dynamic resource support after fidelity tests. Broaden
   playback measurements to the remaining projects and large timelines.
   Keep transport and edits canonical and local
   control endpoints authenticated and loopback-only.
4. Extend the implemented expandable timeline rows with child selection and canonical edits;
   resolve anonymous/generated source identity before offering source edits.
5. The frame capture adapter is connected to the existing compositor. Resolve
   the 3D repeatability case, video injection,
   author timers, remaining audio windows and multi-composition cache behavior. Verify Brag references and
   mixed compositions against actual exports.
6. Implement measured UI/performance improvements; run the full preservation and
   completion audit above. Do not equate green source-import tests with completion.

## Validation commands

```powershell
cargo test -p opencut-editor-api --test hyperframes
cargo test -p opencut-editor-api --test hyperframes_package
cargo test -p opencut-editor-api --test classic_hyperframes
cargo test -p opencut-editor-api --test classic_history
cargo test -p opencut-editor-api --test classic_archive --test classic_atomic
cargo test -p opencut-editor-api
cargo run -p opencut-editor-api --example inspect_hyperframes -- <project-directory>
cd classic
wasm-pack test --node rust/editor-runtime-wasm
bun run build:wasm
```

The example is a read-only static source probe; it skips generated output, hidden
directories, dependencies and symlinks, and reports binary references as unbound.

### Current verification and outstanding baseline failures

- Runtime manifest: 20 Rust HyperFrames/import/manifest tests passed. Four cover
  validation limits, stale sources, repeated host identity, Classic/native state
  reads, revision checks, dry run, cancellation, idempotency and history. Nine
  real-WASM CommandManager tests passed (129 assertions); ten folder orchestrator
  tests passed (180 assertions). Six capture/host tests passed (64 assertions),
  including real Chrome generated DOM, repeated nested audio, authored mute,
  offsets/rate, package paths and capture regression coverage. Ten cache/client/
  graphic-frame tests passed (272 assertions), including page lifecycle cleanup,
  reuse for inspection and project/account/cancellation boundaries. Scoped TypeScript, changed-file ESLint
  and Editor API Clippy passed. Full web baseline failures below remain open.

- Preview caching: 26 tests passed with 538 assertions across rendering/cache,
  real-WASM CommandManager and folder-import orchestration. Scoped TypeScript and
  changed-file ESLint passed. Actual editor transforms/Undo and authenticated
  capture measurements are recorded above. The complete playback and export
  performance audit remains outstanding.

- Folder UI/orchestration: 16 Rust source/Classic import tests passed, including
  atomic resource binding and invalid-import rollback. Seven real-WASM command
  tests passed with 85 assertions; ten import orchestration tests passed with
  167 assertions; six storage/request tests passed with 42 assertions. The render
  client readiness/cache test passed with 54 assertions. Scoped TypeScript,
  including the changed local-drive routes, passed. Changed-file ESLint has no
  errors; existing assertion warnings remain in storage/server/route files.
  Browser folder selection, generated duration, placement, Undo/Redo, reopen,
  byte preservation and failed-import cleanup are described above. The saved
  mixed preview is `.local/hyperframes-folder-import-preview.webp`.

- Compositor/host additions: eight capture/host tests passed with 80 assertions,
  including three real Chrome tests; client lifecycle/account tests passed with
  50 assertions and frame/GPU invalidation tests with 12 assertions. Twelve Rust
  Classic import/history/archive/atomic tests passed, including intrinsic size
  validation and older clips. The browser and decoded MP4 evidence is above.
  Scoped TypeScript passed. ESLint passed for the new adapter and changed render
  paths, with two existing assertion warnings in the AI catalog file. Six
  real-WASM CommandManager tests (73 assertions) and the two folder tests also
  passed after the integration.

- Capture additions: nine folder/preview/capture tests passed with 72 assertions,
  including two real Chrome tests; six browser-binding WASM tests, scoped web
  TypeScript and capture ESLint passed. WASM binding Clippy passed with
  `-D warnings`. The export-table check now covers 13 canonical and 37 existing
  Classic exports. The actual Brag probe captured all eight compositions, with
  the 3D repeatability limitation recorded above.

- Folder/runtime additions: four native package-planning tests, five real-WASM
  folder/preview tests (38 assertions) and four local-drive tests (20 assertions)
  passed. The browser check above also covered nested HTML and dynamic JSON.

- Editor API: 20 existing tests, 8 HyperFrames source tests, 5 Classic import
  tests, 3 Classic history tests, 2 compact archive tests and 1 atomic transaction
  test passed.
- MCP: all 13 tests passed, including registry projection, atomic rollback and
  Classic attachment through the generated tools.
- Editor API and MCP Clippy with `-D warnings` passed after the session adoption
  and history target changes.
- Canonical browser binding: all six WASM integration tests passed, including
  synchronous Classic edits, adoption of existing history and retry behavior
  after restoration and grouped host transactions.
- Both release WASM packages built successfully; 37 existing Classic exports
  and 11 canonical runtime exports passed the binary contract check. Clippy with
  `-D warnings` passed for the native Editor API and the WASM binding, including
  tests. The loader passed ESLint.
- The lazy runtime binary after compact archives and transaction APIs is about 6.7 MB;
  the original Classic WASM remains 3,919,268 bytes. Earlier load timings above
  predate the Classic bridge.
- Six real-WASM CommandManager/ScenesManager tests (73 assertions), three session adapter
  tests (16 assertions), the two legacy CommandManager tests and the separate
  storage round-trip test passed. The existing preview-overlay test also passed.
  They check complete project/scene preservation, including source text and
  undo/redo. ESLint and a scoped TypeScript check passed for the changed Classic
  code and its integration tests. The full web TypeScript
  check reports errors in other test files (fetch mocks, branded time values and
  test fixtures); it reported none in the files changed for this bridge. A full
  web type-check pass remains outstanding.
- Classic: 36 tests passed for timeline components, playhead geometry and audio
  silence defaults. Two stale audio assertions were corrected to the intentional
  0.3-second default from commit `b2b7d03e`; product behavior was preserved.
- The broader Classic timeline invocation reports 62 passes, 4 failures and
  2 module errors. `cut-silence.test.ts` also fails in isolation: its
  `mock.module("opencut-wasm")` omits `resolveAudioSyncRetrim`, now imported by
  the audio timing code. The real WASM was rebuilt and all 37 required exports,
  including this one, passed `verify-wasm-exports.mjs`. This is an outstanding
  test-harness issue, not evidence of successful full regression coverage.
- All eight Brag folder imports are now verified through the UI, persistence and
  sampled previews. Full playback/performance and broader Brag export parity
  remain outstanding. The audio connection section records the completed mixed
  Brag/native MP4 check; multiple-live export equality is recorded above.
