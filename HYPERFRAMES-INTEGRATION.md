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
| Study UI, timeline, element model and performance | Source audit, visual comparison, measured baselines | Source audit started; visual comparison and benchmarks pending |
| Lossless source import into existing document | Registry tests, original source roundtrip, native clips unchanged | Implemented for native and Classic documents; CommandManager adoption and real WASM integration tests pass; browser flow pending |
| Folder/project import in the full editor | Import from user-selected Brag folder; resources persist across reopen | Canonical folder planner, browser file reader and binary asset storage tested; importer UI and end-to-end reopen pending |
| Mixed, overlaid and standalone compositions | Existing Classic timeline, live preview and export for all three | Pending |
| Editable composition children | Expand/collapse in existing lanes; select, trim, move, source/variable editing and undo | Pending |
| Full-fidelity playback | GSAP, CSS, media, fonts, nested hosts, generated DOM; seek/trim/speed/audio tests | Isolated official runtime tested on all eight Brag projects; Classic compositor, trim/speed/audio/export integration pending |
| Export parity | Representative frame and audio comparisons to pinned HyperFrames | Persistent frame capture verified on eight Brag projects; compositor/audio integration and reference export comparison pending |
| Clearer existing UI | Browser review of hierarchy, labels, source status, selection and keyboard behavior | Pending |
| Faster interaction/playback | Same-machine measurements for real projects and large mixed timelines | Pending |
| Existing features retained | Feature inventory and applicable Classic/Rust suites plus browser workflows | Pending |

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

**Canonical source contract, Classic command/view adoption and isolated runtime
preview are implemented; importer UI and Classic compositor integration remain
pending.** No alternate timeline was added. The lazy browser binding runs the same
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

These adapters are tested independently. They still need authenticated host
lifecycle routing, importer UI, attachment to the existing Classic compositor,
transport/audio synchronization and deterministic export. Do not enable an
import button that creates a clip the current Classic renderer cannot display.

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
  HyperFrames exports and authenticated Classic lifecycle integration remain
  unverified or unimplemented. This adapter is not exposed as an import feature.

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

## Next implementation sequence

1. Static inspection and isolated runtime loading have passed on all eight Brag
   project folders, including the generated duration. Finish durable import
   orchestration, runtime error reporting and live child manifests.
2. Exercise the connected CommandManager in a real browser after adding the
   importer and renderer. Source sharing, compact persistence, history adoption,
   media callbacks and canonical view projection are implemented and covered by
   real-WASM tests. The native MCP process still reaches the live editor through
   the existing Classic bridge; forwarding newly registered capabilities to that
   browser runtime needs a transport contract and tests.
3. Add user-selected folder import, durable asset bindings and a persistent
   isolated HyperFrames preview adapter to the Classic renderer. Route all
   transport and edits through canonical transactions. Resource serving must be
   scoped to the imported package; keep local control endpoints authenticated
   and loopback-only.
4. Project runtime-generated child manifests into expandable rows of the existing
   timeline, retain host occurrence identity, and connect selection/inspector.
5. Connect the persistent frame capture adapter and bounded artifact output to
   the existing compositor; resolve the 3D repeatability case, video injection,
   author timers, audio export and cache invalidation. Verify Brag references and
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
- Local Next.js returned HTTP 200 for `/projects` on loopback port 3100. Browser
  inspection reached the account setup gate on that separate origin; live
  playhead behavior and end-to-end import remain unverified. No user account or
  existing project was changed for this probe.
