# Batch Full Auto Edit and floating progress

Scope: **classic-only**. The rewrite is not modified or represented as feature-parity. Batch editing uses the existing canonical Classic `EditorCore`, its command/history transactions, and the same `runFullAutoEdit` implementation as the single-project button. No duplicate project document store or separate MCP mutation tool is introduced.

## Use

Projects → **Batch** → choose videos (or **Import from drive** for large local sources). Each video gets a new project. Choose any combination of Automatic Zoom, Automatic Transition Edit, Automatic Word Animation and Reveal, and Automatic Music, then start.

The mandatory recipe comes from Rust `fullAutoEditStages`: vertical cover, local face/body framing, silence removal at 0.3 seconds, Hebrew ivrit-ai Whisper large-v3 and one-row Auto Texts, caption finishing at 60% / 25%, Assistant bold font, punctuation hidden, centered text, black edge feather, then optional additions and save. The existing transcription and AI prerequisites still apply. No export runs automatically.

Full Auto prefers an imported Assistant Bold/ExtraBold when present. Otherwise
preflight loads the included static Assistant Bold face from the app's own font
assets; manual font import is no longer a prerequisite. Saved caption families
resolve to that same bundled font on reopen, without a Google Fonts request.
The font uses the accompanying SIL Open Font License. This is a Classic platform
font-loading fix; caption style and project mutations remain canonical. Font
load failure, cancellation and stale revision still stop before Smart Takes
caption cleanup. Tests cover missing custom fonts, bundled asset weight/Hebrew
coverage, reopening font resolution and preflight failure without edits.

A draggable floating progress control serves both single and batch edits. The ring measures completed recipe stages, not estimated elapsed time. Click opens the current video's stage list and completed-video count. The panel follows the dragged control with a damped spring; reduced-motion preferences disable the trailing motion. Arrow keys reposition the control; Enter opens details; Escape closes them. Failure/cancellation remains visible and never counts as successful completion.

## Isolation and recovery

- Both the in-project Full Auto Edit button and Projects Batch submit durable jobs to the same host queue. Each run has a root-mounted, same-origin iframe with its own canonical editor. Navigation leaves these workers mounted independently of the visible editor.
- Multiple runs may be queued. Waiting workers renew their leases but do not import, initialize GPU work, or run AI until the oldest active run completes. Cancellation is acknowledged even while waiting.
- The floating control represents every active run and current-session completions. Its selector opens each project's stages; the compact control continues reporting the executing job even when the panel shows another result.
- Single-project handoff freezes edits, flushes document and undo history, and verifies the saved revision before taking ownership. Document/history writes and enqueue operations share a host transaction queue. Queued imports reserve project IDs before creation.
- A viewer that observed a locked project cannot save its stale snapshot after the worker finishes. A fresh full project load must acknowledge the current ownership generation before editing resumes. This protects editor state retained in memory while on Projects or Home.
- The Projects screen shows queue status. Active batch projects are read-only, with persisted project/media snapshots refreshed every five seconds. Unrelated projects remain editable.
- Rust owns queue transitions and lock policy. The host stores queue metadata separately from project documents, serializes queue updates, and requires a private worker token for writes to locked projects. Public status responses exclude the token. Existing local-drive mutation endpoints enforce the lock, including media, fonts, history and deletion.
- Cancellation requests keep the project locked until the worker acknowledges cancellation and flushes completed work. Failed imports do not stop sibling jobs.
- **Keep the launching app tab open.** Reloading/closing it stops the worker; this is not an OS background service. After a three-minute missed heartbeat, jobs become interrupted and stale worker writes are rejected. Completed edits remain on disk for review. Interrupted jobs are not automatically replayed over partly edited projects; restart from fresh source projects.
- The JSON queue is coordinated within the single local Next host process. Multiple server processes sharing one storage root are not supported.

## Verification

Native lifecycle tests cover valid transitions, terminal-state immutability, and cancellation/failure. Host tests cover concurrent queued starts, token isolation, sibling failure, cancellation acknowledgement, expired leases, and read-only save/command protection. Worker tests cover separate project creation, bad-source isolation, serial editing, option forwarding, persistence and queued cancellation. Browser QA additionally exercises file selection, real imports and automation, drag/follow behavior and live viewing.

Browser verification on 22 September 2026: one intentionally invalid MP4 failed at import; both valid eight-second source clips completed all 10 stages with all four options enabled. Saved results are `624371de-46f6-4155-ae47-e3733d686cb2` and `24866cc0-94f0-439b-9573-94871f1967a7`. Disk assertions verified vertical cover, centered 60% / 25% captions, two zooms in each result, and music trimmed to each edited duration at −28 dB. Both results remain for review; no exports were made.

UI verification covered dragging with the expanded following panel, navigating into and out of a locked live preview, opening a different editable project while the worker continued, and starting/cancelling a single Full Auto Edit using the same floating control. This exposed and fixed two lifecycle issues: a newly created background project retained its loading flag, and live refresh previously cleared the scene underneath mounted preview components. Live refresh now loads a guarded snapshot without clearing the scene; changing project or lock mode remounts the editor provider.

Checks: 102 native timeline tests, 9 scoped host/worker/save tests; scoped ESLint has no errors (existing/type-assertion warnings remain). Whole-app TypeScript still reports unrelated existing errors; none were reported in the changed Batch/Full Auto/provider/project-manager surfaces.

See [BACKGROUND-AUTOMATION-QA.md](BACKGROUND-AUTOMATION-QA.md) for the expanded background-execution regression audit.

## Existing-project handoff (October 2026)

The editor remains mounted and inert under a saving banner during handoff. Switching to a locked preview preserves its canonical scene, media handles and renderer; the visible host stops its ownership heartbeat locally instead of reloading the project or making a lease-release request after the queue has fenced ordinary writes. When automation ends, the normal full reload reacquires the latest saved document before editing is enabled.

An idle worker iframe warms the browser route and confirms its ready handshake before a request can save/lock/queue a project. Its React host key is retained when it receives the first job, so handoff does not navigate a second iframe. This prevents first-use development route compilation from triggering Fast Refresh while a newly queued job is protected by the unload guard. A failed startup leaves no queued job. Intentional reload/closing during a running edit still prompts because it terminates the browser worker; the saved project survives and the queue lease eventually expires. This change does not claim reload-resume support.

An existing-project job still in `ready` can be cancelled immediately without an available worker. The canonical `cancel` transition releases its queue lock and invalidates late worker writes. Once `running`, cancellation remains cooperative until completed changes are saved. Import jobs retain their existing cancellation flow.

Capability status: classic-only host orchestration around the existing canonical runtime and Rust batch transitions; no duplicate project state or new transport-specific editor mutation.

Canonical session archive commits now allow up to 120 seconds for validation and durable storage; lease/read requests keep the 30-second default. Explicit transport timeouts still apply to all requests, and timeout recovery retains the exact idempotent pending save. This accommodates large Smart Takes history archives without treating a valid slow save as a lost acknowledgement.
