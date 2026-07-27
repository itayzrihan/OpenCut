# Desktop Development Plan

## Decision

Build the desktop application with **Tauri and the existing Next.js/React editor UI**. Keep Rust as the single source of truth for platform-agnostic business logic, and expose native capabilities to the UI through a small, typed Tauri command boundary.

Continue treating `apps/web/` as a replaceable UI shell. Do not move business logic into React, Tauri commands, or platform-specific adapters. The existing GPUI application should not receive new product work while the Tauri path is being validated; retain it until the replacement meets the exit criteria below.

This decision favors shipping speed, UI reuse, and cross-platform reach. GPUI can be reconsidered only if profiling demonstrates that the WebView itself prevents required editor performance and the problem cannot be isolated behind a native rendering surface.

## Goals

- Reuse the existing editor experience instead of rebuilding the timeline and controls.
- Run media processing, transcription, and filesystem operations locally.
- Keep expensive computation off the hosted web server.
- Support macOS and Windows first, with Linux following when packaging is stable.
- Preserve the browser version as a lighter, client-first edition.
- Keep business rules shared between web and desktop in `rust/`.

## Target architecture

```text
Next.js/React UI (`apps/web`)
             |
       typed desktop API
             |
       Tauri command layer
             |
   shared Rust crates (`rust/`)
        /                 \
native FFmpeg        whisper.cpp
```

The React UI owns rendering, interaction, and view state. Shared Rust crates own editor rules, timeline calculations, project operations, and other platform-independent behavior. Tauri commands are thin adapters for native filesystem access, process lifecycle, media tools, operating-system integration, and progress events.

## Product split

### Desktop

- Use native FFmpeg for probing, decoding, conversion, audio extraction, and export where appropriate.
- Use native `whisper.cpp` for local transcription.
- Store projects and media through native filesystem APIs.
- Work offline after installation and any optional model download.
- Never upload media unless the user explicitly selects a cloud feature.

### Web

- Keep browser-native media processing through Mediabunny, Web APIs, WASM, and WebGPU.
- Prefer local browser transcription when the device supports it.
- Offer an explicit server fallback only when required and communicate that audio will be uploaded.
- Keep protected operations such as authentication, synchronization, payments, and secret-bearing API calls on small server endpoints.

## Native boundary

Start with a deliberately small command surface:

- `probe_media`
- `extract_audio`
- `start_export`, `cancel_export`, and export progress events
- `install_transcription_model` and model download progress events
- `start_transcription`, `cancel_transcription`, and transcription progress events
- project open/save and file-picker operations
- capability and dependency checks

Commands should accept and return versioned serializable types defined alongside the Rust domain types. Long-running work must be asynchronous, cancellable, and report structured progress. React must not construct FFmpeg or Whisper command-line arguments.

## Delivery phases

### Phase 1: feasibility spike

- Create a minimal Tauri desktop shell that loads the production editor UI.
- Prove development hot reload and a bundled offline production build.
- Add one typed Rust command and one native file picker.
- Verify that WebGPU/canvas preview behavior works in the target WebViews.
- Measure startup time, idle memory, preview frame rate, and timeline responsiveness on representative machines.

Exit criterion: an existing project can be opened and previewed without a blocking WebView limitation.

### Phase 2: shared Rust API

- Inventory business logic still living in `apps/web/`.
- Move platform-independent logic into focused crates under `rust/`.
- Expose the same core through WASM for the web UI and native Rust for Tauri.
- Add contract tests so WASM and native results remain equivalent.
- Generate or validate TypeScript bindings to prevent command payload drift.

Exit criterion: new business logic can be implemented once in Rust and consumed by both targets.

### Phase 3: native media pipeline

- Package or reliably locate compatible FFmpeg/FFprobe binaries per platform.
- Implement probing, audio extraction, conversion, and export behind Rust services.
- Add cancellation, bounded concurrency, temporary-file cleanup, and structured error reporting.
- Keep Mediabunny for browser operation; choose the native path through a capability adapter rather than UI conditionals scattered throughout the app.

Exit criterion: desktop media operations complete locally and survive cancellation, restart, paths with spaces, and large input files.

### Phase 4: local transcription

- Integrate `whisper.cpp` behind a Rust transcription interface.
- Default to a practical quantized model; make larger models optional.
- Download models only after explicit user action, show size and storage requirements, verify checksums, and support deletion.
- Extract and resample audio locally with the native media service.
- Stream progress and partial results where supported.
- Keep the current browser worker implementation as the web-side implementation of the same conceptual interface.

Exit criterion: a user can install a model once and transcribe offline without media leaving the device.

### Phase 5: desktop integration and packaging

- Implement recent projects, file associations, drag and drop, autosave, crash recovery, and update handling.
- Define Tauri permissions with least privilege; do not expose a generic shell command API to the WebView.
- Sign and notarize macOS builds and sign Windows builds.
- Build platform-specific CI artifacts and test clean installation, upgrade, and uninstall flows.
- Add diagnostics that exclude project content and media by default.

Exit criterion: signed builds install and update reliably on supported operating systems.

### Phase 6: replace the GPUI shell

- Run a release candidate with representative real projects.
- Compare performance and feature coverage against the existing web and GPUI shells.
- Migrate desktop documentation and release workflows.
- Remove or archive the GPUI shell only after the Tauri application satisfies all release criteria.

## Performance policy

Do not assume that native execution automatically fixes UI performance. Profile these layers separately:

- React rendering and state updates
- timeline interaction latency
- preview compositor and GPU utilization
- WebView memory usage
- Rust command serialization overhead
- FFmpeg and Whisper execution
- disk and cache behavior

Move computation to native Rust when it is CPU-heavy, needs native libraries, handles large files, or benefits from OS integration. Keep interaction and presentation work in React. Avoid sending frame-sized buffers repeatedly across the Tauri IPC boundary; exchange file paths, handles, compact descriptors, and progress messages instead.

## Security and privacy

- Treat all WebView input as untrusted at the Tauri boundary.
- Validate paths, model identifiers, options, and project data in Rust.
- Use an allowlist of operations rather than arbitrary process execution.
- Apply a restrictive content security policy and disable unnecessary remote navigation.
- Keep API secrets out of the shipped client; proxy secret-bearing cloud calls through authenticated server endpoints.
- Clearly label every feature that uploads user content. Local transcription and export should make no network request after required assets are installed.

## Release criteria

The Tauri desktop application is ready to replace GPUI when:

- Core editor workflows match the web editor.
- Preview and timeline interaction meet agreed performance budgets.
- Native export and transcription work offline and can be cancelled safely.
- Large projects do not require copying complete media buffers through IPC.
- Project recovery works after an interrupted export or application crash.
- Signed macOS and Windows packages pass clean-machine testing.
- No business logic is duplicated between the web and desktop UI shells.

## Key risks

- WebView and WebGPU behavior differs across operating systems.
- Bundling FFmpeg may introduce licensing and distribution obligations that require review.
- Whisper models make installers or first-run downloads large.
- Native sidecars complicate signing, updates, and antivirus reputation.
- An overly broad Tauri command surface can weaken security and recreate business logic outside `rust/`.

Address these risks during the feasibility and packaging phases, before removing the GPUI application.
