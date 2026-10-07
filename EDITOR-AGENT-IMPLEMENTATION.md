# OpenCut editing agent implementation and acceptance ledger

The complete accepted specification is the plan **סוכן עריכה מלא ל־OpenCut,
בממשק של Visu**. This ledger tracks implementation evidence; a foundation or
passing unit test does not establish full product completion.

## 2026-10-06 Accepted completion plan: implementation checkpoint

### 2026-10-07 Resumed after disk space was restored

- The workspace browser build containing the isolated preview presentation
  canvas now passes: `.local/preview-isolation-browser-build-resumed.log`.
  It is running on loopback 3002. The earlier ENOSPC build is not reported as
  successful; external-drive build snapshots were not used as release evidence.
- Added `media.classic.remove`: explicit project/revision, 1..1000 media IDs,
  deduplication, optional cascade across every scene, bounded 10000-clip edits,
  atomic dry run/retry/history and retained source bytes. Retained HyperFrames,
  compound media and nested clip dependencies fail before publication. UI
  MediaManager invokes this same contract; it no longer runs the legacy
  filesystem-deleting command for ordinary removal. Permanent deletion/GC and
  general import remain separate work. The old command is retained until the
  migration's complete parity/removal gate is recorded.
- Four native removal cases and a real-WASM UI/history regression pass. The
  regression exposed a broad UI-history override of canonical media membership:
  new transactions now preserve native membership by default, with explicit
  resource retention for HyperFrames folder imports and external legacy effects.
  Historical contexts retain the old compatibility behavior. Project-scoped
  transient handles allow Undo after removal and reopening; detached unused
  blob URLs are released. No independent project state store was introduced.
  Targeted history/HyperFrames/callback checks: three passed with 49 assertions,
  `.local/classic-media-parity-targeted.log`. Full rechecks are in progress.
- Browser account access requested sign-in after restart. The user authorized
  a newly created local account. Local sign-in and the public ChatGPT
  subscription connection succeeded. Chrome displayed ERR_BLOCKED_BY_CLIENT on
  the ephemeral loopback callback page after authentication; the editor's
  connected profile/model list and subsequent real-provider task verified that
  the callback completed. No browser-security bypass was used. The separate
  Codex image connection also completed after restarting an expired OAuth flow.
  Its UI says connected/image access unverified until a real generation succeeds.
  Keyboard account/workspace confirmation worked where CDP mouse dispatch timed
  out; no browser-security settings were changed.
- Added Read `media.classic.image.inspect`: current project/revision/media and
  an owned generation artifact/SHA binding, static PNG <=16 MiB and 4096×4096,
  expanded 8-bit pixels, decoded buffer <=64 MiB. Rust checks complete decode,
  alpha counts/threshold bounds, source RGB statistics, dimensions and SHA;
  cancellation and invalid scope/input fail without document changes. Animated,
  16-bit, unbound/copied images and other formats remain explicit limitations.
  Five native cases and actual-WASM read/reopen checks pass. The inspector does
  not assess composited appearance or automatically certify prompt fidelity.
- Artifact persistence now discovers common serialized ArtifactRef values and
  artifactId/SHA bindings in the active project and same-project Undo/Redo
  history. Scoped conversation capture includes these dependencies even when
  chat entries are absent or truncated. Conflicting SHA bindings fail closed;
  unrelated artifacts and foreign projects are excluded. This closes the
  source-PNG disappearance found by the real-WASM inspector reopen regression
  without a new per-feature agent/storage table. Two native dependency cases
  and the WASM regression pass; final integration rechecks are running.
- Real-provider benchmark `he-basic-title` completed autonomously in a fresh
  account/project with the exact frozen prompt: one centered Hebrew title,
  0..360000 ticks, three review images, final state read and no steering/repair.
  Live UI Undo/Redo (revisions 4→5→6), saved-state comparison, reload/takeover,
  restored conversation and screenshot passed. Public evidence is in
  `.local/editor-agent-qa-live/he-basic-title/`. The aggregate gate records
  **1 attempted, 1 success, zero unsupported success claims**, with 19 cases
  unattempted; the full 18/20 release gate remains false.
- The first `en-ui-navigation` attempt paused on a real provider-overload error
  before editor receipts/mutations; no success is claimed for it. This exposed
  missing transient server recovery. Retry policy now lives in Rust: at most
  three disconnected sends or five temporary provider/HTTP sends, bounded waits,
  Retry-After support, and no retry for applied output, malformed/incomplete
  protocol, authentication, permission/model or permanent-quota failures.
  Hosts perform timers/IO only. No provider output reaches editor execution
  before successful completion, so discarded attempts cannot replay actions.
  Every retry rechecks account/project, cancellation and canonical revision.
  Six transport, six stream and 70 real-WASM manager cases pass (82 total,
  `.local/provider-retry-host-final/summary.json`); both TypeScript configs,
  scoped lint and optimized browser build pass. The new recovery build runs
  at 3003. Live rerun and the rest of the benchmark remain open.

The local changes below implement a substantial part of the accepted plan. This
checkpoint is **not full completion**. Existing local migration work and the
150 verified HyperFrames packages were preserved. No broad Git staging or reset
was performed; the changes remain in the existing development worktree.

### Canonical editing and discovery

- Ordinary move, split/retain-side, trim/retime/parameter update, clip clipboard,
  single/multiline text merge, transitions and background-removal configuration
  now use dedicated Classic registry contracts through CommandManager. Native
  tests and real-WASM manager parity cover exact ticks, validation, preserved
  fields and reopened Undo/Redo. Managed transition SFX and typing-reveal SFX
  now share those contracts and authored feature files, including companion
  replacement, exact segmentation, rollback and one-step history. Caption
  visual reflow and the remaining complex operations are explicitly bridged.
- Clipboard copy is a bounded project-scoped Read snapshot. Paste validates the
  entire batch and owned media before committing, preserves relative timing,
  places tracks using the product policy, and allocates fresh clip/keyframe IDs.
  Paste deliberately rejects a foreign clipboard identity. Owned source media
  now has a separate explicit read/copy contract; inspected clip drafts can be
  inserted with the returned media ID and newly allocated clip IDs. Dependency-
  heavy, linked-group and complete project transfer still require migration.
- Text split and merge share native word/row/timing helpers. Multiline merge
  preserves row styles and caption ownership; manual edits retain unrelated
  generated transcript words. Merging remains one reversible transaction.
- `projects.owned.read` lists the authenticated user's saved projects or pages
  through one source project's media and exact-tick clip data. Rust validates
  and projects saved Classic state, excludes provider/conversation/session and
  filesystem details, and returns a source fingerprint. `projects.owned.media.copy`
  copies one image/video/audio file up to 256 MiB into the current project with
  a fresh media identity, SHA and content-bound durable operation. A completed
  copy can be recovered using fresh target state even after the source changes;
  changed operation content, corrupt journals, foreign ownership and stale or
  cancelled canonical publication are rejected. Registration is one native
  Undo, and retry adds no revision/history. Source bytes/project stay unchanged.
  Five native cases, six actual-WASM filesystem cases and two transport cases
  passed (`.local/owned-project-native.log`, `.local/owned-project-host-initial.log`,
  `.local/owned-project-adapter.log`). This does not certify full dependency
  transfer, live model copying, or a packaged shell.
- The UI and runtime consume one shared 98-preset transition feature definition
  file. Catalog pagination tests follow its actual size, so another preset does
  not require agent/MCP wiring. Its text SFX definitions are shared too; the
  existing apply schema exposes `managedTextSfx` and clip-update exposes
  `managedTypingSfx`. No duplicate agent or MCP tool was added.
- Ripple plan/apply unions removed/truncated intervals, subtracts newly joined
  clips and excludes cross-track moves. The ordinary UI reactor invokes the
  native policy in its existing transaction, preserving one undo step. Legacy
  host-effect preflight, persistent ripple mode and linked-audio groups remain.
- CI builds the registry before auditing coverage. The current compiled map has
  159 capabilities, 34 reviewed feature families, 18 legacy classes and 112
  generic/legacy mutation sites. These are inventory counts, not completion
  percentages. `EDITOR-FEATURE-COVERAGE.md` records the remaining gaps.

### Agent context, image adapter and UI

- Completed-task public conversation seeds a project-scoped bounded follow-up
  context. Historical data is explicitly untrusted and does not replay actions
  or grant authority. Reload/checkpoint integration is covered locally.
- An honest `fail` action closes an unfinished task without asserting success,
  discarding edits or completing its plan. It cannot discard an unsettled host
  operation, including through a forged terminal checkpoint. Failed tasks and
  their receipts survive reopening; the next client request starts a fresh run
  with public conversation context, without replaying the retained edit. A
  real-WASM client regression covers this and reopened Undo/Redo. Late events
  after client disposal are suppressed.
  The final lifecycle/host/history recheck passed 82 cases without skips:
  `.local/editor-agent-failure-host-recheck/summary.json`.
- Render review now receives bounded paired successful invocations/results for
  every registry feature and current media metadata, rather than HyperFrames
  source evidence alone. It can inspect an image reference and exact arguments
  without another tool-specific agent adapter. Provider-supplied lookalike
  receipts cannot override appended host results; reasoning is excluded.
  Ordinary reads do not invalidate visual QA. All 42 native agent tests pass
  after this change (`.local/editor-agent-review-evidence-native-final.log`).
- Checkpoints retain at most eight recent descriptions only when they exactly
  match the live host-selected catalog and current authority. Changed, removed,
  unavailable and foreign descriptions are discarded. Old checkpoints remain
  readable without trusting historical tool responses. Restore performs no
  action replay or external IO; fresh state observation is still required.
- `imagegen.generate` has a separate authenticated Codex subscription adapter.
  Rust owns scoped planning, dispatch identity and durable no-replay policy;
  the host executes IO, validates/decodes bounded PNGs and publishes owned
  ArtifactStore/media references. A journal is claimed before provider IO;
  ambiguous outcomes remain uncertain and never trigger another generation.
  No automatic paid API fallback is enabled. Mock-provider tests cover duplicate
  prevention, recovery and ownership. Real subscription generation produced a
  1536×1024 PNG; the same completed operation was recovered into canonical
  media and a three-second timeline clip without changing its SHA256. Pixel
  decode verifies actual alpha. Public evidence is in
  `.local/editor-agent-image-live/after-recovery/report.json`; the pipeline
  verdict is distinct from task completion/visual prompt compliance. Subtle
  fill variations were identified. Real subscription image editing also
  returned a 1536×1024 purple PNG, using the original owned artifact. The durable
  request digest matches the exact prompt, reference ID/hash, transparency flag
  and operation ID. Decode verifies alpha; canonical registration and insertion
  at seconds 3–6 passed. Evidence and a browser screenshot are in
  `.local/editor-agent-image-live/purple-edit/`. Both live tasks ended honestly
  as **failed**, rather than asserting full visual compliance: the edited
  circle is slightly larger. This establishes generation/edit pipeline IO,
  references and recovery, not complete autonomous image-task acceptance.
  The new run ID differs from the prior failed run; the original clip remains.
- A separate real-provider follow-up completed the explicitly scoped visual
  correction: discovery/schema inspection, pre-edit renders, one canonical
  `timeline.classic.elements.update`, review, post-edit renders and final
  state read. Public evidence is in
  `.local/editor-agent-image-live/transform-correction/report.json` (run
  `6bbbb2a1-3753-4322-a639-6f216e0c7367`, revision 7→8). An independent comparison
  confirms only purple `transform.scaleX`/`scaleY` became 0.95 (apart from the
  transaction timestamp); both media SHA hashes, clips, timing and other state
  remain unchanged. The task used externally supplied alpha bounds. This is
  acceptance of the transform correction, not retroactive success of either
  earlier image task or evidence of the complete 20-case benchmark.
- That live QA found the mounted preview was the GPU's shared compositor canvas:
  offscreen review captures could visibly replace its frame while the playhead
  stayed unchanged. Preview now requests a renderer-owned presentation canvas;
  only explicit preview rendering publishes its pixels, inside the compositor
  queue, including native overlays. Export and frame consumers keep the raw
  compositor path. Five ordering/startup/isolation tests pass, including a
  failed capture and mixed canvas sizes; browser recheck is in progress.
- Live image QA exposed a missing shared-host registry during checkpoint
  validation and stale pre-pin ArtifactRef metadata. Both paths now use shared
  host registration and return post-pin metadata. Real-WASM reopening,
  persisted bytes, image media Undo/Redo and retained HyperFrames folder
  resources pass in the 79-case host/history recheck.
- `editor.ui.control` uses expiring opaque snapshot targets, trusted UI-only
  bindings, cancellation and account/project/revision fences. Browser DOM and
  actual isolated owned-window Electron Playwright tests pass. No arbitrary
  selector/script/shell or foreign-window access is exposed. Full selection,
  playback, drag and manual takeover coverage remain.
- The chat renders safe Markdown/GFM with per-block Hebrew/Arabic direction,
  LTR code, tables and task lists. Activity events track running/completed/failed,
  timestamps, duration and groups. The composer grows with its draft, guards
  pending file IO, accepts file drop/paste, preserves manual history scrolling
  and supports keyboard scrolling/copy actions. Stop/Resume are explicit
  non-submit buttons. Full Visu composer/layout/visual parity remains.
- Live browser testing exposed a stale ownership acquisition race. The IO client
  now observes the latest saved view after a definitive acquisition conflict,
  and ProjectManager opens the read-only takeover UI. It never silently retries
  takeover against a new owner. Ambiguous transport failures remain explicit.
  A real-WASM host test covers the race and no-write/no-replay behavior.

### HyperFrames library and local build

- The dedicated project examples page retains source, prompts, previews,
  filters, import/remix and the editor's chat session. The asset dialog remains.
- Optional semantic search uses pinned local BGE vectors and a pinned CPU q8
  query model, with Rust validation/ranking and explicit lexical fallback/search
  mode. Actual model/WASM retrieval evidence is in
  `.local/hyperframes-semantic-live/report.json`. No popularity rank is invented.
- Production and test TypeScript diagnoses from the prior audit were repaired.
  Both full TypeScript configurations and new compound-SFX scoped lint pass.
  Whole-source lint previously reached zero errors; final verification is
  recorded separately from historical evidence.
- Windows Webpack now canonicalizes only the known workspace-root spelling in
  resolved module paths. The live build previously loaded dependencies twice
  through `C:\DEV`/`C:\Dev`, consuming over 8GB. The corrected server log contains
  no duplicate-casing warnings. A boundary/platform test passes; unrelated paths,
  package versions and filename spelling are preserved.

### Verification evidence

A new export-only live request reproduced the correction run's original SHA
`58727761803328488580c963d0cb0345c97525e80552adff64314280691bb751`
without changing document revision 8 or source/timing. These are newly rendered
bytes, not recovery of the historical artifact. The persisted ArtifactStore
copy passed independent ffprobe and full FFmpeg decode: 132,749 bytes, VP9,
1920×1080, 4.8 seconds, 10fps, no audio. Sampled decoded frames show the complete
corrected title. Public delivery/report files are in
`.local/hyperframes-live-evidence/correction-live-run/reexport-artifact/` and
`decoded-reexport/`. Browser download verification remains **false**; the QA
checker now records input provenance explicitly. Chrome automation timed out
and access to `chrome://downloads/` was denied by browser URL policy. No bypass
or successful browser-download claim was made.

| Gate | Current result and evidence |
| --- | --- |
| Native editor-api, editor-agent and MCP | 245 passed, zero failures or ignored cases, serial execution; `.local/owned-project-native-full.log` |
| Web integration | Earlier full source suite: 277 isolated suites, 1186 passed, zero failed, 30 skipped; `.local/editor-agent-web-acceptance-recheck/summary.json`. Skips are not live acceptance evidence. Latest focused ownership/host/history recheck: 93 passed, zero failed/skipped, seven suites; `.local/owned-project-host-final/summary.json` |
| Electron development host | 9 passed across runtime, owned screenshot and scoped UI control; `.local/editor-agent-electron-final.log`. This is not packaged Electron acceptance |
| Architecture/library scanner | 20 passed; `.local/owned-project-scanner-tests.log`. Compiled map audit: 34 reviewed families and zero broken references; `.local/owned-project-architecture.log` |
| WASM | Latest optimized canonical build passed; `.local/owned-project-wasm-final.log`. Required exports verified: 49 legacy and 50 canonical, including all installed host policy exports; `.local/owned-project-exports-final.log` |
| Built local browser | Latest optimized Webpack browser build and production TypeScript passed; `.local/owned-project-browser-build.log`. New host capabilities are included on loopback port 3002. WASM async/await target warnings remain; this is not standalone package, packaged Electron or SaaS acceptance |
| Full TypeScript and scoped lint | Production/test TypeScript passed (`.local/owned-project-ts-final.log`, `.local/owned-project-test-ts-final.log`); six changed web files have zero lint errors/warnings (`.local/owned-project-lint-final.json`) |
| Managed text/audio policy | 7 native transition/update tests and two real-WASM UI cases passed, with 48 UI assertions; `.local/editor-agent-compound-sfx-native-final.log` and `.local/editor-agent-compound-sfx-parity.log`. Audible/rendered acceptance remains |
| Windows resolver / benchmark validator | One boundary test and one gate test passed. Validator fixtures are synthetic and do not establish live model success |

`resources/editor-agent-qa/tasks.json` freezes the 20 Hebrew/English acceptance
cases. `scripts/check-editor-agent-qa.mjs` validates the report, required checks,
scoped receipts and evidence SHA/files, rejecting mock provenance, missing or
corrupt evidence and unsupported success claims. The full real-provider benchmark
has **not** been executed; no 18/20 result is claimed.

### Remaining delivery gates

Complete rendered/audible compound text/SFX acceptance, caption reflow, general media import/removal,
complete cross-project dependency/clip transfer and complex Parallax migrations. Finish
the Visu UI comparison and remaining scoped UI surfaces. Complete autonomous
image-task visual compliance, attachment-provider acceptance, two-tab/account/project
lifecycle and post-reopen playback, transparent/underlay HyperFrames workflows,
actual browser export downloading (ArtifactStore bytes/SHA/full decode passed), all 20 model cases,
and packaged Electron. SaaS remains a separate later phase. Preserve existing
legacy functionality until parity is recorded. Commit checkpoints must include
their prerequisite migration files without sweeping unrelated local changes.

Baseline: `c79878ff`, branch `מיזוג-עם-העורך-של-Hyper-frames`, clean on
2026-10-05 before agent implementation. The existing HyperFrames migration is
retained; check its current evidence rather than repeating the older audit.

## Required deliverables

| Requirement | Status | Acceptance evidence required |
| --- | --- | --- |
| Every Classic project uses canonical state/history | Integrated locally; broader QA pending | Real ProjectManager/CommandManager/WASM lifecycle tests pass; real browser/Electron and complete feature parity remain |
| All existing feature families exposed | Pending | Executable UI/capability parity inventory, readback and visible output |
| Automatic future feature discovery | In progress | Registry discovery works; initial legacy-command CI gate and source inventory added, full UI/manager mutation enforcement pending |
| Correct Classic/rewrite applicability | In progress | Wrong-representation calls rejected before any mutation; dynamic discovery |
| Rust iterative harness and context/recovery | Core implemented and tested | Core/provider/real-WASM loops and paired durable local recovery pass; live model quality and complete tool coverage remain |
| Visu floating/docked chat | In progress | UI and streaming connected; authenticated browser and packaged Electron QA pending |
| Per-user and per-project skills/memory | In progress | Local Rust policy, versioned UI/registry operations and isolation tests pass; hosted storage and real authenticated UI QA pending |
| ChatGPT connection and image provider | Real subscription generation/edit pipeline evidenced; full visual task acceptance pending | Live generation, owned-reference editing, exact-request digest, decoded alpha, canonical insertion and failed-task lifecycle are recorded above. Both image tasks honestly failed full visual acceptance; the 20-case quality gate is still pending |
| Scoped UI control and observation | Implemented locally, partial presentation coverage | Opaque expiring snapshot targets, browser DOM and owned Electron Playwright passed; full selection/drag/manual takeover and packaged shell acceptance remain |
| Public SaaS accounts/storage/session ownership | Pending | HTTPS two-user tests, durable fenced writes, object storage |
| Pause on closed editor and resume | Local lifecycle integrated and tested | Paired archive/run save, ProjectManager exit/reopen and takeover pass in integration tests; real hidden-tab/network/account-switch QA and local unsaved recovery remain |
| HyperFrames remix/preview/improve/export | Defined live workflow and decoded bytes evidenced; broader acceptance pending | New export is byte-identical to the historical corrected run and passes independent ffprobe/full decode. Browser downloading, transparent-underlay/audio and broad motion coverage remain |
| Catalog metadata and 150 verified packages | Implemented and certified for pinned references | 150 source/license/prompt/preview packages retained; dedicated page and live pinned CPU/WASM semantic retrieval implemented. Certification does not certify future remixes |
| Full QA and rollout | Pending | Rust/WASM/web suites, packaged Electron, real hosted QA and observability |

Current overall phase: **development and integration, not final polish**. The
canonical editing/agent/knowledge/persistence foundations have substantial
implemented and tested coverage. The original deliverable still requires major
product work: remaining feature exposure and parity, complete Visu UI acceptance,
autonomous image-task visual compliance, lifecycle/provider QA, packaged Electron,
the 20-task model benchmark and external verification of returned exports.
Conversation/attachments, scoped UI automation and the verified HyperFrames
catalog now have implementation evidence below. SaaS is a separate later gate;
the first acceptance targets are local browser and Electron.
Do not convert passing local integration suites into a claim of AAA agent
quality or readiness for end users. The media ownership matrix passed 79 tests
in `.local/classic-web-tests/1791187193152/summary.json`; newer track-control
validation is recorded below. Neither is a complete product acceptance run.

The local batch queue now serializes across server processes, and project font
upload/metadata/delete/clear paths enforce the editor ownership fence at the
service boundary (see evidence below). Media upload/index/relink paths now use
the same fence and isolated staging. Project deletion and account-wide operations
still need this protection. Hosted SaaS ownership is not implemented.

## Architecture constraints

- EditorDocument/OpenCutRuntime remain the sole editor authority. Classic
  managers are host projections. Do not invoke rewrite timeline operations on
  the hidden empty rewrite timeline of a Classic project.
- Each feature declares its supported document representation and execution
  class in the canonical descriptor. Hosts and agents consume that declaration.
- Rust owns domain, harness and knowledge policy. TS executes host effects.
- API provider identity is separate from the OpenCut authenticated account.
- Web is installation-free: canonical actions and semantic DOM control;
  server Playwright receives immutable QA jobs. Electron owns its exact target.
- Preserve all existing product functions when replacing the old chat. Its
  tool list is not the new capability architecture.
- No success claim without matching current evidence for every row above.

## Evidence

2026-10-05 foundation:

- Added explicit document applicability and execution mode to the canonical
  capability contract. Registry discovery and invocation both enforce Classic
  versus rewrite applicability. Every built-in declaration now explicitly names
  its execution mode; WASM no longer keeps a capability-name sync allowlist.
- All loaded Classic projects attach the canonical runtime. Existing commands
  continue through the shared command/history bridge.
- `crates/editor-agent` owns schema-first discovery, contract invalidation,
  authenticated project/revision binding, retry identities, planning, steering
  epochs, receipts, pause/reconcile/resume decisions and completion gates.
  Context keeps complete provider rounds and references to evicted receipts.
- `RuntimeAgent` shares the actual editor runtime and performs bounded immediate
  transactional actions. Unsupported async/external effects are explicitly
  unavailable until their host adapters are implemented. This is not full
  feature coverage yet.
- The model protocol is generated from Rust and does not accept host lifecycle,
  identity, epoch or QA-attestation arguments. New registered feature contracts
  can be discovered and invoked without adding another model tool definition.
- Browser bindings and CommandManager publish agent edits into the actual
  Classic UI projections, storage and Undo/Redo. The model provider and chat UI
  are not connected yet; QA attestation currently has a host entry point whose
  renderer/vision implementation is still required.

Validation:

- `cargo test -p opencut-editor-api -p opencut-editor-agent --tests`: passed
  before the final model-protocol additions; includes three new applicability
  tests and existing HyperFrames/history regressions.
- Latest `cargo test -p opencut-editor-agent`: 9 tests passed, doc-tests passed.
  Covers real Classic edit/readback/undo, stale and invalid edit rollback,
  newly registered features, steering, retry reconciliation, context and model
  privilege boundaries. A prior doc-test attempt failed because a build rlib
  was missing; the complete retry passed.
- Final applicability refinement marks Classic commit/synchronize unavailable
  on rewrite documents while allowing initial attach. All three applicability
  tests passed again after this refinement.
- `wasm-pack build rust/editor-runtime-wasm --target bundler --out-dir pkg`:
  passed. Export verification passed for 37 legacy and 19 canonical exports.
- Real WASM command-manager suite: all 18 tests passed, including two new
  agent tests and concurrent silence feature changes in the same checkout.
- Targeted web lint passed after the adapter helper change. Whole-project
  TypeScript check reports 63 diagnostics in test files outside the current
  agent changes, none in the changed agent/command/project files. Full typecheck
  is not green and remains part of final acceptance.

Concurrent work appeared in the shared checkout during this implementation:
smart silence, caption repair and related timeline files, including additions
in `operations.rs`, `commands.ts`, `canonical-classic-session.ts` and the shared
command-manager test. Preserve those edits; do not commit or revert them as
agent-owned work. No agent commit has been created yet.

Next integration work: real provider streaming and cancellation, Visu-derived
floating chat, durable scoped run/knowledge storage, and remaining feature/host
adapters. The remaining requirements in the table still apply in full.

2026-10-05 provider and initial chat integration (supersedes the earlier
"not connected yet" foundation status):

- Added an independent implementation of the documented new Sign in with
  ChatGPT flow: dynamic local registration, PKCE/state/nonce, issued client
  binding, issuer/audience/subject JWT verification, encrypted per-OpenCut-account
  credentials, process-safe refresh locking and rotation checkpoints, account
  model discovery and public `/v1/responses` streaming. Sign-out aborts active
  streams and attempts remote revocation. Identity and plan-sharing status are
  separate. Existing experimental-chat credentials are not silently reused.
- Official documentation reviewed: `developers.openai.com/siwc/` token-sharing
  open-source sign-in, models-and-inference, profiles-and-sessions, website and
  the Sign in with ChatGPT cookbook. The DevKit was inspected read-only at
  `.local/siwc-devkit`, commit `f723814abdccec135b519c451fb6e1992ee5e933`.
  Its noncommercial license is unsuitable for the accepted SaaS deliverable;
  no DevKit source/package was copied or added as a dependency.
- Rust now builds bounded provider context and its generated tool contract,
  applies only completed responses, retains reasoning/tool round relationships,
  emits activity records, rejects replayed/superseded responses and pauses
  bounded runs. Resuming resets the round window without losing replay guards.
- Added a Visu-derived floating, draggable, resizable, minimized or docked panel
  in the editor. It displays public reasoning summaries, nested action inputs
  and outputs, plan state, model selection, streaming Markdown, stop/resume/
  steering and render samples. Docking allocates layout space. The kill switch
  is `NEXT_PUBLIC_EDITOR_AGENT=0`. This is a preview, not completed UI parity:
  file attachments, saved conversation/recovery and authenticated visual QA
  are still required.
- The host captures canonical compositor samples selected by Rust, places
  bounded images in the same ArtifactStore, and sends a separate image review
  request without editing tools. The review is bound to exact run epoch and
  editor revision. Failed reviews return issues to the editing context and do
  not unlock completion. Repeated reads do not resubmit an identical failed
  review. Sampled active-scene images do not establish motion/audio/export or
  all-scene QA; these remain required adapters and acceptance tests.
- Client cancellation discards partial responses and serializes rapid steering.
  Server API routes are authenticated through the existing account boundary;
  both new endpoints returned 401 without an account during the local smoke
  test. This is still the loopback host path, not the accepted public SaaS
  identity/session/ownership implementation.

Latest validation:

- `cargo test -p opencut-editor-agent --tests`: 12 passed, including provider
  rounds, replay/steering, render-review revision fencing and resume budget.
- `wasm-pack build rust/editor-runtime-wasm --target bundler --out-dir pkg`:
  passed after the final Rust changes. Export verification: 39 legacy and
  24 canonical exports (legacy additions include concurrent silence work).
- `bun test --timeout 20000 src/core/managers/__tests__/canonical-command-manager.test.ts`:
  all 20 passed. New integration drives the real WASM through a scripted SSE
  provider, edits/publishes/undoes the Classic project, transports review images,
  and verifies rapid steering. The provider and JPEG fixture are test doubles,
  not evidence of live inference or visual correctness. A prior concurrent run
  exceeded Bun's default 5-second timeout in the existing source-preflight
  test; the complete retry passed (that test took 3.7 seconds on retry).
- Six streaming/OAuth/vault tests passed, including split UTF-8/CRLF events,
  late failure after partial text, abrupt disconnect, PKCE/client binding,
  ciphertext owner binding and concurrent credential updates.
- Production TypeScript (`tsconfig.build.json`) passed after the final UI and
  transport changes. Targeted agent/API/bridge lint passed with zero warnings
  and zero errors.
- Started local Next development server at `http://127.0.0.1:3100` (session
  95179). Chrome reached the OpenCut sign-in gate. A user-input request asks
  the user to sign in there and then connect ChatGPT for real end-to-end QA.
  No real ChatGPT inference, authenticated UI screenshot, packaged Electron,
  or hosted two-user QA has been claimed.

Next work remains the **entire** accepted plan: durable run checkpoints tied to
canonical persisted revisions, per-account/project skills and memory, missing
feature/host adapters and coverage enforcement, scoped UI observation/control,
SaaS auth/storage/leases, verified catalog packages and real end-to-end QA.
Keep the goal active. Shared silence changes are still preserved and no broad
commit has been made from the mixed checkout.

2026-10-05 private knowledge and suspended host capabilities:

- Added Rust-owned versioned skills/memory with immutable built-ins, global and
  current-project scopes, project overrides/exclusions, owned-project read/copy,
  enabled state, soft archive and version restoration. Account/project filtering
  precedes retrieval and context budgeting. Content does not confer permissions.
- Local storage uses an authenticated per-account directory, process-safe lock,
  bounded Rust store, atomic rename and persisted idempotency receipts. Exact
  retries return the saved result; stale revisions/versions cannot overwrite
  another write. The UI provides search, editing, copying and version restore.
- The same live registry now exposes `knowledge.search`, `knowledge.read` and
  `knowledge.change`; there is no separate model-tool list. Skills can be read
  in version-pinned UTF-8 excerpts. Active memory and relevant skill summaries
  enter bounded context; new knowledge revisions invalidate buffered responses
  and prior QA. A model can explicitly learn other relevant skills on demand.
- Added a generic HostBridge: installed registry handlers suspend across host IO
  without holding an editor transaction or a mutable WASM agent borrow. Only
  exact installed descriptors gain host availability; unrelated open-world
  capabilities remain unavailable. Input and output schemas stay enforced by
  the registry. Malformed host output retains the pending operation for retry.
- The client reconciles the original request before resuming after an uncertain
  network result. A known pre-commit policy rejection is distinct from a lost
  transport/storage response. Completed receipts arriving during pause do not
  restart the run. Knowledge writes retain receipts but do not trigger video QA
  merely for changing an editing preference.
- This is live-session recovery, not durable editor/run checkpoint completion.
  Audit found that command history and project saves are currently separate,
  and restoring history synchronizes it to the independently loaded project.
  Atomic project-revision + run-receipt storage and ownership fencing must be
  implemented before claiming safe close/reopen or public SaaS recovery.

Validation so far in this stage:

- 20 native editor-agent tests passed, including scope/precedence/version/copy,
  bounded multilingual excerpts, registry-discovered new host capabilities,
  real knowledge-policy lost-response replay, pause and provider response fencing.
- Real WASM + local filesystem knowledge tests passed (3), including the model
  protocol -> registry -> host store -> replay -> paused receipt path.
- Command-manager suite passed all 21 tests, including the client resuming an
  uncertain host write with byte-identical request identity and no duplicate
  receipt. It also retains the concurrent silence and HyperFrames regressions.
- The knowledge HTTP endpoint returned 401 without authentication. No real
  account login/model inference or authenticated browser visual QA is implied.
- Final production TypeScript and targeted lint passed. Regenerated WASM build
  and export verification passed (39 legacy, 28 canonical exports). Native agent
  tests passed again after malformed-host-output validation (20 total).
- Final isolated web runner passed all 31 tests across 5 suites against the
  regenerated WASM, with no failures or skips. Report:
  `.local/classic-web-tests/1791179987440/summary.json`. This covers connection,
  streaming, uncertain host transport, real persisted knowledge and canonical
  command-manager integration; it does not replace live-provider/browser QA.

Remaining scope is unchanged: all feature families and CI enforcement, atomic
durable checkpoints and leases, SaaS auth/storage/WSS, full chat parity, scoped
UI control, image provider, HyperFrames packages/remix/export, and real browser,
Electron and two-user hosted QA. Do not mark the overall goal complete.

2026-10-05 canonical checkpoint/recovery contract:

- Fixed Classic archive restoration to retain its saved revision rather than
  restarting at revision 1. Restore still requires an empty runtime, validates
  all history/source data before adoption, supports dry run, and rejects invalid
  or non-incrementable browser revisions. Existing archive/history/atomic tests
  passed after this behavior change.
- Added bounded Rust run checkpoints bound to the exact canonical project
  fingerprint and revision. Restore cannot replace project contents or confer
  authority: account/project come from the host, grants are reset to the host's
  current limit, and non-pending loaded contracts are discarded for rediscovery.
- Reopened runs are paused. Old render handles, retrieved private knowledge and
  QA attestations are not restored; fresh knowledge and review are required.
  Provider replay identities, complete context rounds, plans and action receipts
  survive. Context compaction keeps receipt references to earlier rounds.
- Pending host recovery re-prepares the same invocation under the live installed
  contract and checks its exact request, scope and retry identity. It performs no
  host IO automatically. A lost already-committed knowledge response can be
  reconciled after destroying/recreating the runtime without duplicating a write.
- Added `agentCheckpoint` / `agentRestoreCheckpoint` WASM and session bindings.
  These are persistence primitives, not a claim that browser close/reopen is
  already wired. Project/history/run still need one atomic host commit with
  ownership fencing. Do not save the run record separately beside the old
  independently written project/history files and call that durable recovery.

Validation in this stage:

- Native editor-agent suite: 22 passed. Two checkpoint tests exercise real
  archive restoration, preserved Undo/revision, stale-content/account rejection,
  authority reset, expired QA and pending-write recovery across runtime recreation.
- Native editor-api archive/history/atomic suites: 6 passed.
- WASM build and export verification passed: 39 legacy, 30 canonical exports.
- Real WASM checkpoint suite passed (1), including rejection without modifying
  the target run, paused reopening, retained receipts and canonical Undo.
- Final production TypeScript and targeted lint passed. The isolated web runner
  passed all 25 tests across checkpoint, real knowledge storage and canonical
  command-manager suites. Report:
  `.local/classic-web-tests/1791180848750/summary.json`.
- The first regression run hit the known 5-second timeout in a multi-case real
  WASM preflight matrix (no assertion failure). The two multi-runtime preflight
  matrices now have explicit 20-second bounds; assertions were preserved. The
  complete runner passed afterward. The archive regression also now compares
  the actual restored revision instead of normalizing it before comparison.

Next persistence integration must replace the existing split `project.put` /
`history.put` save contract: capture the canonical archive and run record in the
same synchronous boundary, commit them with a project/session generation and
optimistic storage revision, await that acknowledgement before the next agent
effect, and reject stale editor/background-worker saves. The existing
`historySaveQueue` catches errors, so it cannot be used as a durable success
acknowledgement. The full original acceptance table still governs completion.

2026-10-05 atomic local session storage and ownership foundation:

- Added host-independent Rust session-store transitions: authenticated account
  and project scope, 90-second ownership lease, increasing fencing generation,
  explicit takeover with expected generation, optimistic storage revisions and
  bounded SHA256 exact-request replay receipts. Expired or transferred owners
  cannot commit, release, renew or replay writes. Failed transitions leave the
  record unchanged; observed clock rollback cannot revive an expired lease.
- A commit validates the canonical archive through the actual runtime registry,
  validates any run checkpoint beside that exact revision/content, and derives
  the materialized Classic project from it. The same editor revision cannot be
  reused for different archive contents, including media, sources and history.
- Added the WASM host binding and authenticated `/api/editor-session` endpoint.
  Local storage uses a process-safe per-project lock and one project.json atomic
  replacement, containing project projection, archive/history, run, lease and
  receipts. Temporary file contents are flushed before rename. Domain rejection
  is distinguished from an uncertain IO outcome. Initial adoption reads legacy
  project and history under this same lock; merely inspecting an unadopted
  project does not switch its storage format.
- Legacy project/history writes now share the lock and reject writes to adopted
  sessions. Generic project reads strip the private storage envelope; history
  reads project the canonical archive from the same stored record.
- Added the browser transport save queue. Lost acknowledgements retain the exact
  original request and reconcile it before capturing a later revision. Requests
  pin the account and carry existing background-worker write tokens.
- CommandManager can attach an atomic storage adapter, capture archive/run in
  one synchronous boundary, restore the saved canonical document and paused run
  without synchronizing stale host contents into it, and await acknowledged
  saves. Atomic save failures remain visible to flush/exit callers instead of
  being swallowed by the legacy history queue.

This is not yet activated in ProjectManager/EditorProvider. Before activation:
wire acquire/read as the single project/history load, heartbeat/read-only and
explicit takeover UI, autosave and close, every agent IO/receipt boundary, and
the existing background-worker handoff. Finish ownership guards for media/font
and project deletion/migration paths, preserve derived thumbnails, and replace
remaining direct legacy saves (including inactive-project metadata edits).
Do not claim end-user close/reopen or SaaS lease coverage yet. The local storage
adapter is not the planned PostgreSQL/private-S3/WSS adapter.

Validation so far in this stage:

- Three native session policy tests passed: exact replay, optimistic conflicts,
  takeover/expiry/clock rollback, scope isolation, mismatched checkpoints and
  same-revision content rejection with no partial commit.
- Three real-WASM/filesystem/browser-transport tests passed, including competing
  writes (only one commits), account isolation, rejection of legacy overwrites,
  paired project/history/run reopen and Undo, and a reply lost after commit.
- Command-manager suite passed all 23 tests, including atomic restore from a
  deliberately stale host view and visible save rejection. Existing silence,
  HyperFrames and provider-loop tests remain covered.
- Ten legacy local-drive, source roundtrip and save-manager regressions passed.
  Report: `.local/classic-web-tests/1791182298945/summary.json`.
- Production TypeScript and targeted lint passed. Existing local-drive server
  unsafe-assertion warnings are unchanged. WASM was rebuilt after final policy
  changes; final integrated verification is recorded below when complete.
- Final native editor-agent run passed all 25 tests. Regenerated WASM exports
  verified (39 legacy, 31 canonical). Final isolated web run passed all 27 tests
  across checkpoint, session-store host/client and canonical command manager,
  with no failures or skips:
  `.local/classic-web-tests/1791182351917/summary.json`.
- `git diff --check` passed. No live account inference, browser ownership UI,
  packaged Electron or hosted two-account verification is implied by these tests.

2026-10-05 editor lifecycle integration (supersedes the foundation's unactivated status):

- ProjectManager now acquires a host session before adopting the freshly read
  project/history pair. Subsequent opens restore the paired canonical archive
  and run; they do not merge the separately fetched legacy document into it.
  The preliminary old project read checks existence only.
- Autosave and custom-font project metadata saves use the atomic adapter.
  Derived thumbnails are separately bounded in the session bundle and restored
  with the project view without entering canonical editing/run fingerprints.
  Library renaming of an adopted, closed project uses a temporary canonical
  runtime under the same lease and commit contract, preserving Undo and the run.
- A second editor opens as a viewer. The UI has an explicit ownership-transfer
  action that reloads the latest saved version. Command guards disable edits
  after ownership failure; a 25-second heartbeat renews the 90-second host lease.
  Temporary transport failures retain the original pending save and allow
  reconciliation. Definitive stale-owner rejection requires a fresh open.
- Agent provider requests await persistence; pending host requests are persisted
  before IO, host receipts are persisted before continuation, and provider/review
  results are persisted before being presented as completed actions. Pause queues
  a checkpoint. Exit pauses the run, flushes and releases ownership; account/core
  reset disposes the old heartbeat. Read-only font hydration avoids copying
  missing font files into a project owned by another editor.
- Background workers carry their existing authenticated batch token and acquire
  a new canonical generation when loading a queued project. The batch guard
  still wraps session mutations. This is not yet full unification: the batch
  queue still needs cross-process serialization and all media/font/delete upload
  endpoints need the same ownership fence across their actual side effect.

Lifecycle test uses the actual ProjectManager, CommandManager, canonical WASM
and Rust session-store policy with a simulated HTTP transport and renderer/font
IO fixtures. It covers opening, agent edit, save, paused exit/reopen, thumbnail,
Undo, a second read-only editor, explicit takeover and rejection of the previous
editor's save without altering the stored record. This is stronger than the
earlier storage-only tests, but does not stand in for actual browser/Electron/
hosted account QA. Browser chat entries and attachments still need durable UI
history; only canonical run/provider state is checkpointed so far.

Remaining before considering lifecycle production-ready: fence every external
project mutation and deletion, unify background queue ownership across hosts,
verify reload/hidden-tab/network/account-switch UX with real browsers, provide
recovery for unsaved local edits after ownership loss, test future migration of
adopted records, and complete the SaaS storage/transport adapter. Full original
feature, HyperFrames library, image provider and deployment acceptance remains.

Validation for lifecycle wiring: the final isolated web runner passed all 37
tests across seven suites, including library renaming before reopen and its
retained Undo boundary. Report:
`.local/classic-web-tests/1791183359572/summary.json`.
Production TypeScript passed; targeted changed logic lint passed. Provider UI
has the pre-existing ripple-hook mutation and beforeunload assertion warnings.
Rust session tests (3) and regenerated WASM build passed with thumbnail support.

2026-10-05 cross-process background queue and session rejection handling:

- Replaced the process-only global batch mutex with an account-root keyed
  in-process queue plus a shared proper-lockfile transaction around reading,
  checking, performing the guarded operation and replacing queue.json. Queue
  replacements use exclusive temporary files, file sync, atomic rename and
  cleanup. Independent account roots do not share a mutex.
- Existing-project handoff and queued imports now observe the same serialized
  queue across local host processes. Lock order is batch queue, then project
  storage. Canonical session publication also checks the outer batch lock
  immediately before replacing project.json.
- Batch policy rejection before a write is now a distinct BatchWriteRejected.
  The editor-session API returns a definitive conflict for this rejection,
  while storage/transport uncertainty remains retryable. It no longer treats
  an active background owner's refusal as an unknown save outcome.
- Added actual separate-process tests for competing owners of one project,
  preservation of simultaneous submissions for different projects, and a
  handoff waiting for an in-flight save then rejecting its obsolete revision.
  The fixture uses the production queue and filesystem locking; domain stage
  transitions and project lookup are fixtures, not real signed-in browser QA.
- Added API tests proving rejected writes never enter session storage and
  uncertain IO retains its non-definitive response. Real WASM/filesystem tests
  prove losing the outer lock at each publication boundary leaves project.json
  byte-identical. Existing local lifecycle integration still passes.

Remaining ownership work: carry authenticated editor-generation authority into
every external project write, stage upload bytes outside the commit lock and
revalidate before publication, preserve deletion fencing after removing project
files, and cover legacy/migration/account-clear paths. The new queue lock must
not be held across an entire long media stream. No external mutation guard has
been activated by this change. The full original product plan remains active.

Validation: final targeted run passed 16 tests in five isolated suites, with
zero failures or skips (`.local/classic-web-tests/1791184611628/summary.json`).
Production TypeScript and git diff --check passed. Targeted ESLint reports no
errors; three existing batch-server type-assertion warnings remain. An initial
subprocess test attempt failed because its fixture path was one directory too
high; correcting that path made all three process tests pass. No native or WASM
source changed in this step, and no live inference or packaged/hosted QA is
implied by these results.

2026-10-05 project asset authorization and complete font write path:

- Added host-only Rust AssertWrite session policy. Unadopted legacy projects
  retain their import path; once a session is acquired, external writes require
  its exact live session ID and generation. Missing/partial authority, other
  account/project, takeover and expiry are rejected. The public editor-session
  API accepts only its five lifecycle operations, not this internal host action.
- Added an authenticated-request authority context and withEditorProjectWrite.
  It holds the batch queue then project storage lock, delegates policy to real
  canonical WASM, preserves observed clock state for adopted records, and
  rechecks policy/locks at asset publication. Authority comes from the current
  account scope and request fence, never a model-supplied identity grant.
- Project font upload, metadata updates, deletion and clearing now use the
  guard inside the storage service, including direct server callers. Upload
  streams use private account staging outside the project and outside the
  publication locks. Final publication reacquires the locks and validates the
  original owner. A rejected upload cleans its staging file. Uploaded font paths
  are unique, so staging/replacement cannot overwrite currently referenced
  bytes before metadata publication. Font deletion publishes index removal
  before collecting the unreferenced file.
- EditorSessionClient publishes its current fence into an account/project
  transport binding; disposal, release and definitive ownership loss remove
  usable headers. An old client's disposal cannot erase a new binding, and a
  late acquisition cannot revive a disposed client. ProjectManager disposes
  transport bindings on exit/reset. Local drive requests carry the fence.
- Font save/import workflows capture account, editor generation and batch
  headers before their first await and keep them across upload plus metadata
  publication. They do not silently adopt a newer owner's generation midway.
- Added real WASM/filesystem tests of all four font write paths, legacy imports,
  concurrent metadata writes, account/project isolation, and batch workers
  needing both authorities. A streamed upload remains paused while another
  session takes ownership; completing it then fails without replacing an
  existing font or leaving its staged bytes. A browser-transport test drives
  StorageService.saveProjectFont across takeover and verifies both requests
  retain the original fence. These fixtures do not replace authenticated UI QA.

Validation: all 26 native editor-agent tests passed. WASM rebuilt successfully;
39 legacy and 31 canonical exports verified. Final isolated web matrix passed
60 tests in 14 suites, no failures or skips:
`.local/classic-web-tests/1791185599676/summary.json`. Production TypeScript and
git diff --check passed. New guard/binding modules lint without warnings;
existing storage/route type-assertion warnings remain, no lint errors. The first
new transport-test run exposed missing fixture exports/WASM stubs; those fixture
dependencies were corrected before the final run.

Remaining: apply the same guard to media bytes/index/upload journals/relink and
preserve their retry/discard protocol; fence project deletion with durable
tombstones and cover migrations/account-wide clear. Do not claim these paths
protected yet. Orphan collection for immutable font bytes after a successful
upload followed by abandoned/rejected metadata, crash-time staging cleanup,
hosted storage and actual browser ownership/recovery QA remain. No live-model,
HyperFrames library, UI automation, SaaS or packaged Electron acceptance has
been substituted by this storage work; the full original goal stays active.

2026-10-05 media ownership, isolated uploads and durable discard recovery:

- Media index mutations, copying/linking paths, relink, uploads, upload journals,
  finalization, deletion and clearing now use the same service-level editor
  write authority as fonts. The HTTP route carries the original request fence;
  relink dispatch no longer nests the same batch lock around the guarded service.
- Uploads register a unique intent under the project lock, stream into private
  account staging without holding the lock, then reacquire and verify authority
  before publication. Each attempt has immutable destination bytes. Even ordinary
  uploads have an intent, so clearing the library fences delayed publication.
  A superseded stream cannot publish or remove the winning retry's files.
- Retry journals retain superseded paths until collection completes. Version-one
  journals using in-project temporary files remain supported. A regression test
  exposed that legacy temporary files were incorrectly treated as retained media;
  retry classification now includes both validated temporary and final paths.
- Discard publishes its intent and removes index references before collecting
  bytes. Legacy index-owned uploads with no journal now persist validated cleanup
  basenames first, so a collection failure after index removal remains recoverable.
  Retries preserve files referenced by other retained records; cleanup metadata
  cannot name another directory or an alternate stream. Terminal journals prevent
  late retain/discard requests from reopening an upload.
- Browser media saves and HyperFrames folder imports pin account, editor session,
  generation and batch authority before their first await. Import checks that
  authority again before canonical commit and retain. Cleanup keeps the initiating
  fence instead of borrowing a newer owner's authority. A leaking test fixture
  was corrected so the ownership-change regression tests its intended path.

Validation: the focused four-suite run passed 38 tests. The final integration
matrix passed 79 tests in 12 isolated suites, zero failures/skips, covering real
WASM editor lifecycle/Undo, session storage, separate-process batch ownership,
font/media writes, crash/retry uploads and HyperFrames imports:
`.local/classic-web-tests/1791187193152/summary.json`. Production TypeScript and
git diff --check passed. Targeted lint has no errors; existing storage assertion
warnings remain. Native/WASM policy did not change in this step. Fault-injection
tests establish retry behavior, not power-loss durability or authenticated UI QA.

Remaining: project deletion/tombstones, account-wide clearing, legacy migrations,
orphan/staging garbage collection and hosted storage. This closes the current
media implementation regressions, not the entire ownership or product milestone.
Full feature adapters and mutation coverage enforcement, durable conversation and
attachments, scoped UI automation, live ChatGPT/image inference, SaaS, 150 verified
HyperFrames packages and real browser/Electron/hosted acceptance still remain.

2026-10-05 Classic track controls through the shared capability registry:

- Added `timeline.classic.track.update`, a typed Classic-only immediate write
  capability for explicit name/mute/visibility values and direct UI toggles.
  It names the project, scene, track and optimistic revision, and uses canonical
  validation, cancellation, dry run, idempotency and transaction/history handling.
  Track mute/hidden values are now validated as booleans in the Classic model.
- TimelineManager's mute and visibility controls now call that capability through
  CommandManager's canonical transaction. Nested UI actions synchronize preceding
  host changes before invocation and publish the resulting canonical view. There
  is no additional agent tool or WASM dispatch allowlist for the feature. The
  editing agent discovers it from the same live registry and schema.
- Migration contract: **bridged** track mute/visibility (existing Classic shape,
  canonical Rust mutation, web UI projection). Removed the two unused TypeScript
  toggle command implementations after parity/history tests passed; all repository
  call sites use TimelineManager. Track naming is exposed by the canonical contract;
  no new rename UI is claimed. Track add/remove/reorder and other feature families
  still require migration and the complete coverage/CI inventory remains pending.
- Native tests compare the entire preserved Classic document, check other-scene
  targeting, wrong type/identity/revision, cancellation, exact retries, previews
  and undo/redo. Real WASM tests prove UI and discovered-agent controls produce the
  same serialized state and that their undo/redo survives reopening. An invalid
  second control in a compound UI action rolls the whole transaction back.

Validation: eight selected editor-api tests passed (three track-control tests,
three applicability tests, two archive tests); all 26 native editor-agent tests
passed. Canonical WASM rebuilt and 39 legacy/31 canonical exports verified.
The final command-manager run passed all 25 tests:
`.local/classic-web-tests/1791188061295/summary.json`. Six lifecycle/checkpoint/
session-host tests also passed with this WASM. The first new agent test omitted
the required planning step and was corrected before its final successful run.
Production TypeScript, targeted lint and diff checks passed again after removing
the unused legacy toggle implementations/exports; no remaining source references
to those command classes were found.
These are local integration tests, not live model, browser-button or packaged QA.
The complete accepted plan and remaining deliverables above stay active.

2026-10-05 explicit Classic track creation and ordering:

- Added `timeline.classic.tracks.layout` for typed add/reorder operations in an
  explicitly targeted Classic scene, with canonical revision checks, validation,
  cancellation, dry run, retry identity and atomic history. The live registry
  exposes the contract to the editing agent without a tool-list or WASM export
  change. It supports all six existing track types and the established defaults,
  bucket insertion and top-to-bottom order, including reordering the main track.
- Explicitly created tracks carry the serialized, validated `keepEmpty` flag.
  Existing post-command pruning respects it, so an agent-created empty track can
  survive intervening UI edits before receiving content. Automatically placed
  temporary tracks still use the prior pruning behavior. Explicit track removal
  remains available through the existing UI command.
- TimelineManager add/reorder, drag-to-new-track and speaker-frame breakout
  creation now use canonical transactions. Creating a track and inserting its
  element remain one undo boundary. Removed the unused AddTrackCommand and
  ReorderTrackCommand implementations/exports after native and real-WASM parity
  tests passed; shared placement helpers remain in use for implicit clip placement.
- Migration contract: **bridged** explicit track creation/reordering. This does
  not migrate every implicit new-track path inside existing clip commands.
  Track removal requires preservation of shared generated/manual caption sources
  and remains classic-only until that behavior is migrated and verified; it was
  not replaced with a lossy remove operation. Parallax property editing, complete
  feature inventory and CI enforcement also remain pending.

Validation: seven native editor-api tests passed across layout, track controls
and atomic rollback. Canonical WASM rebuilt after the keepEmpty change; required
exports remain 39 legacy/31 canonical. Final isolated web run passed 38 tests in
five suites, zero failures/skips:
`.local/classic-web-tests/1791189156287/summary.json`. Real-WASM tests compare all
six types against the existing placement helpers, normalize stale/duplicate order
entries, cover main-track reorder bounds, agent discovery/UI equality, compound
rollback and persistence through ordinary pruning reactors. Native tests cover
cross-scene/element ID collisions, canvas requirements, retries and dry run.
Production TypeScript passed again after unused-command removal; targeted lint
and git diff --check passed, and no source references to the removed classes
remain. Real signed-in browser drag/drop,
model inference and packaged/hosted acceptance have not been claimed. The full
accepted plan remains active.

2026-10-05 executable source inventory and initial architecture CI gate:

- Added a TypeScript-checker-based production source scanner under
  `classic/scripts/editor-architecture`. It inventories Command inheritance,
  manager methods, action definitions/bindings, JSX event handlers and literal
  canonical adapter calls. Resolved call paths provide capability candidates;
  generic Classic state synchronization is reported separately. Every inferred
  path explicitly retains `parityVerified: false`.
- Added a reviewed baseline for the 46 existing legacy Command classes,
  including their shared base and batch wrapper. The gate rejects additions
  outside the command directory too, inherited/aliased classes, changed class
  bodies/imports and lost ancestry from a broken or retargeted import. Ordinary
  formatting/comments do not alter hashes; string/regex/template content does.
  Existing classes can be removed as their behavior migrates. Baseline changes
  remain explicit reviewable migration exceptions, not automatic CI updates.
- Added a dedicated GitHub Actions workflow and isolated locked TypeScript
  package. It runs scanner tests, checks the baseline and uploads the candidate
  inventory. The local commands are architecture:check, architecture:inventory
  and architecture:test. The hosted GitHub workflow itself has not run here.
- Optional --with-runtime reads the actual compiled canonical WASM registry,
  records its SHA-256, and rejects missing or rewrite-only literal capabilities
  called by the Classic adapter. The registry snapshot has no loaded project
  or external host adapters; it is not an availability claim for a live agent.

Validation: all 9 scanner tests passed, covering alias/re-export/inheritance,
class expressions, JavaScript/MTS sources, moved additions, body/import changes,
formatting, deletion, missing base, invalid syntax, unresolved ancestry,
candidate reachability, generic persistence exclusion and registry mismatch.
An isolated copy of the actual source tree without application dependencies or
generated WASM passed the same 46-class baseline. npm ci of the isolated tooling
package passed. The actual source/compiled-registry check passed with 1,035
source files, 46 legacy classes, 359 manager methods, 33 action definitions,
34 bindings, 1,218 JSX event sites and 114 registry capabilities. All 25 literal
adapter call sites (24 distinct IDs) exist and support Classic. Report:
`.local/editor-architecture/inventory.json`. Formatting and diff checks passed.
No production behavior or Rust/WASM code changed in this step.

Remaining: this is an initial bounded gate, not the requested complete mutation
enforcement. Imported helper changes and inline manager/hook mutations remain
outside its fingerprints; higher-order callbacks, dynamic dispatch and JSX
spreads can remain unresolved. The report resolved 860 of 1,218 event handlers,
which is not an agent coverage percentage. Verified feature-family migration
statuses, UI/shortcut capability enforcement and full behavioral parity still
need implementation. Full feature adapters, conversation/attachment persistence,
scoped UI automation, live inference/images, SaaS, the verified HyperFrames
library and original end-to-end acceptance remain required. Goal stays active.

2026-10-05 Classic scene lifecycle and bookmark editing through the registry:

- Added `project.classic.scenes.edit` (create/rename/select),
  `project.classic.scene.delete`, and `timeline.classic.bookmarks.edit`
  (toggle/remove/update/move/bulk replace). All are Classic-only immediate
  reversible document capabilities, with explicit project/revision targeting,
  schema validation, dry run, atomic history and registry retry identities.
  Scene removal retains media/source bytes and is undoable; its Write authority
  does not grant filesystem deletion or expand the editing agent's permissions.
- ScenesManager's user actions and the reorganize-takes bookmark bulk write now
  invoke canonical transactions. Creating retains the established empty-scene
  defaults and does not select the new scene. Removing the active non-main scene
  selects the main scene; main-scene removal is rejected. Explicit scene
  selection now participates in canonical Undo/Redo. Rust owns UTC metadata dates
  using the existing host clock and chrono formatting without chrono clock IO.
- Individual bookmark actions use the project's integer frame grid, including
  fractional rates and the existing fallback for rates without integral ticks
  per frame. Stable ordering, coincident bookmarks, first-match toggle/update,
  all-match removal, range duration, notes, colors and group IDs are preserved.
  Optional properties can be cleared explicitly; the UI maps an explicitly
  undefined property to that clear operation. Unknown bookmark metadata remains
  intact on targeted edits. Bulk replacement preserves supplied times/order.
- Classic model validation now checks scene isMain booleans and existing bookmark
  arrays, safe integer times/range ends and optional text properties. Generic
  commits and history restoration use the same validation. Other document fields,
  shared composition sources and media bindings remain lossless.
- Migration contract: **bridged** explicit Classic scene lifecycle and bookmark
  actions (Classic serialized model, Rust mutations, host/UI projections).
  Removed all eight unused legacy scene/bookmark command classes and their exports
  after parity tests; removed their baseline entries without refreshing unrelated
  hashes. No source references to the removed commands remain. Low-level scene
  projection/normalization and parallax-specific creation are still existing host
  paths, not a claim that every scene-related mutation has migrated.
- Corrected the source inventory to distinguish actual Classic scene features
  from generic commit/session plumbing. Nested transaction callbacks are now
  reported as possible paths, explicitly without asserting their execution.
  Tests cover both distinctions. The report now finds the actual scene/bookmark
  capability paths, 38 remaining legacy classes and 117 compiled capabilities.

Validation: 16 native editor-api tests passed across scenes/bookmarks, Classic
archives/atomicity/tracks and applicability; all 26 editor-agent tests passed.
Canonical WASM rebuilt after the final Rust authority change and required exports
remain 39 legacy/31 canonical. All 40 web tests passed in five isolated suites:
`.local/classic-web-tests/1791192165329/summary.json`. They exercise real WASM,
ScenesManager/CommandManager, discovered agent commands, identical serialized
results (apart from wall-clock dates), rational/non-grid bookmark parity,
whole-action rollback and persisted scene Undo/Redo. The first new agent sequence
fixture incorrectly reused an old epoch and was corrected to consume each current
epoch. A later parallel run exceeded Bun's default five-second limit in two
WASM integration cases; explicit 20-second bounds on the long cases and the final
serial suite run passed without changing assertions. Production TypeScript,
targeted lint, Rust formatting and diff checks passed. All 11 scanner tests and
the actual source/WASM inventory check passed (28 explicit call sites).

This is local integration coverage, not signed-in browser-button, live-model,
packaged Electron or hosted SaaS acceptance. Remaining feature families, complete
UI mutation enforcement, conversation/attachments, scoped automation, images,
verified HyperFrames packages/remix workflows and full original acceptance remain
required; the complete goal remains active.

2026-10-05 Classic project settings and canonical preview gestures:

- Added `project.classic.settings.update`, a Classic-only immediate Write
  capability with typed schemas, explicit project/revision targets, exact retry
  receipts, dry run, cancellation checks, atomic transaction support and history.
  It changes rational FPS, canvas size, preset/custom mode, remembered original
  and custom sizes (including explicit null), and color/gradient/blur background.
  Rust updates both the Classic settings and their canonical project projection;
  clips are not implicitly resized or retimed. Unrelated scenes, media, sources,
  extension metadata and settings remain intact.
- Known optional Classic settings are validated on generic document commits and
  archive restoration as well. The validator preserves extension fields in
  existing documents. Empty/invalid patches, nonpositive dimensions/frame rates,
  negative blur, wrong scope and stale revisions fail before publication.
- ProjectManager.updateSettings now calls the canonical contract synchronously.
  Synchronous failures propagate into legacy compound command transactions so a
  bad settings edit cannot silently escape rollback as an unawaited rejection.
  Existing UI callers can still await the result.
- Live background previews are validated committed revisions. A bounded gesture
  ID and exact previous revision coalesce consecutive previews/final commit into
  one durable undo boundary. An intervening edit, undo/redo or a UI change to a
  different setting prevents coalescing. No uncommitted second document or long
  open transaction is retained across UI events. Closing/reopening the host resets
  the UI gesture identity while retaining committed state and undo history.
- Migration contract: **bridged** user-facing Classic project settings, including
  nested first-clip settings changes. The old UpdateProjectSettingsCommand stays
  in the frozen baseline for automatic imported-media FPS ratcheting/failure
  recovery and transient projection while replaying older import commands. Those
  paths still require migration; retaining the class is intentional, not parity
  proof for the entire project/media family. Existing command hashes are unchanged.

Validation: 19 native Classic/settings/applicability integration tests, 20
editor-api library tests and all 26 editor-agent integration tests passed. The
three settings tests passed again after tightening schema nullability. Final
canonical WASM built successfully; export checks remain 39 legacy/31 canonical.
All 39 real-WASM/web tests passed in four isolated suites (32 command-manager,
1 actual ProjectManager lifecycle/ownership, 1 checkpoint, 5 FPS helpers):
`.local/classic-web-tests/1791193711649/summary.json`. Coverage includes dynamic
agent discovery/invocation and UI state parity, persisted undo/redo, sequential
color previews, intervening edits, a different-setting change during a gesture,
atomic nested failure/success and second-tab read-only rejection. Production
TypeScript, targeted lint, Rust formatting of the new modules and diff checks
passed. The final source/WASM inventory passed with 118 compiled capabilities,
29 literal call sites, 362 manager methods and 38 unchanged legacy classes.
The inventory finds the new ProjectManager/CommandManager capability path;
candidate rows still deliberately do not claim verified whole-family parity.

All processes from this step finished. This remains development/integration:
live authenticated inference, visual browser controls, packaged Electron/SaaS,
remaining feature migrations and original HyperFrames/library acceptance are
still outstanding. The complete goal stays active.

2026-10-05 Classic source-audio extraction/recovery and JSON transport fidelity:

- Added `timeline.classic.audio.source.edit`: an immediate, Classic-only Write
  capability with explicit project/scene/track/element/revision targets, typed
  extract/recover/toggle actions, cancellation, dry run, retry receipts, atomic
  compound edits and durable Undo/Redo. It does not decode or write media.
- Rust preserves clip timing, trims, source duration (including explicit null),
  speed/pitch, volume and mute. Only volume animation is copied; visual effects,
  masks and other animation remain on the video. Copied curves preserve metadata,
  normalize scalar handles and receive independent IDs, including component keys
  not shared with the primary channel. IDs avoid collisions across scenes.
- Extraction uses the first available audio lane in normalized display order,
  accepts exactly touching intervals and otherwise creates an Audio track at the
  top. It disables the embedded source audio. Recover re-enables that audio and
  deliberately retains extracted clips, matching the existing product behavior;
  it can work without the original media binding. The discovered description
  explains that recovery does not merge or delete the extracted clip.
- TimelineManager now delegates to the same canonical transaction used by the
  agent. Removed ToggleSourceAudioSeparationCommand, its barrel export and only
  its reviewed baseline entry after native and real-WASM parity passed. Moved
  the old pure audio builder to a test-only reference fixture; production retains
  the audio eligibility/label helpers, with no duplicate extraction implementation.
- Fixed a shared WASM transport defect found by the parity test: direct
  serde_wasm_bindgen decoding of arbitrary JSON converted undefined object
  properties into null. Sync/async capability calls, invocation options and
  transaction context now use JSON serialization semantics before deserialization.
  Omitted properties stay absent, explicit null remains null, and array slots
  follow JSON semantics. Cyclic input fails before mutation. Regression tests
  cover deep document fields, both invocation paths, history, persistence and
  transaction context, without weakening the original Undo comparison.
- Migration contract: **bridged** explicit Classic source-audio extraction and
  recovery. This does not migrate all clip/audio properties, keyframe editing,
  media import/analysis/export or other remaining legacy command families.

Validation: 23 native editor-api integration tests, all 26 editor-agent
integration tests, all 11 architecture-scanner tests and production TypeScript
passed. Targeted lint, Rust formatting and diff checks passed. The isolated web
matrix passed all 55 tests in six suites, zero failures/skips:
`.local/classic-web-tests/1791195538028/summary.json`. This includes whole-project
parity, agent/UI equality, compound rollback and reopened extraction/recovery
history. Two existing long integration cases hit Bun's default five-second
timeout in the preceding run; their explicit bounds are now twenty seconds and
the final serial matrix passed with unchanged assertions. The source/compiled
registry gate passed with 1,025 production source files and 37 legacy classes.
After the explicit-null source-duration refinement, all four native source-audio
tests passed again, the final WASM built successfully, and both source-audio web
integration cases passed against that build (32 unrelated cases deliberately
filtered out). The web parity fixture now includes the explicit-null duration.
Export verification remains 39 legacy/31 canonical exports. Targeted lint and
formatting passed again, and the final actual-source/WASM architecture gate
passed with 30 literal capability call sites. All processes from this step have
finished; no live model or rendered browser acceptance is inferred from them.

Real playback, signed-in browser actions, live model inference, packaged Electron,
SaaS, complete feature coverage and the verified HyperFrames catalog/remix/export
acceptance remain outstanding. The full accepted goal remains active.

2026-10-05 Classic clip effects and live product renderer discovery:

- Added `effects.classic.catalog.read` and `timeline.classic.effects.edit`.
  The read capability exposes the host's actual product definitions, keywords,
  defaults, parameter types, ranges and choices, with query/type filtering and
  optional parameter expansion. The host publishes descriptions from the existing
  EffectsRegistry; there is no second hand-maintained agent effect list.
- Rust owns add/update/enable/toggle/remove/reorder mutations in the real Classic
  document. Contracts require project, scene, track, element, editor revision and
  catalog revision, with dry run, exact retries, cancellation, transactions and
  persisted undo. Parameters accept named string/number/boolean values and merge
  without dropping unrelated metadata. Add allocates independent IDs, uses the
  live product defaults, retains blur alias behavior, and requires an explicit
  opt-in for the existing custom fallback. Descriptions state that custom
  metadata alone does not prove a rendered effect. Removal preserves animation
  metadata, matching the prior UI's behavior; effect-keyframe editing is separate.
- Catalog revision is a SHA-256 content signature, not a resettable process-local
  counter. Changed definitions invalidate pending edits even across reopening;
  identical declarations retain their signature. Catalog publication is a bounded
  host-only API (`setEffectCatalog` in WASM), not an agent tool or project-state
  mutation. UI registry publication restores previously notified hosts if another
  host rejects it. Subscriptions are released with the editor session.
- Classic validation checks effect envelopes, identity uniqueness within a clip
  and known field types while preserving unknown fields and legacy omitted/null
  enabled flags. The initial stricter enabled requirement rejected a real saved
  fixture and was corrected rather than rewriting that fixture.
- TimelineManager's five effect actions use canonical capabilities. Consecutive
  parameter preview gestures coalesce into one committed undo boundary, with
  target/property identity and canonical revision fencing. The editorial template
  now groups legacy insertions and canonical effect addition in one transaction.
  Removed all five unused legacy effect command classes, their barrel, and only
  their five reviewed baseline entries after native/real-WASM parity tests.
- Migration contract: **bridged** explicit clip-effect actions and the template's
  effect-add path. Product renderer implementations/descriptions remain in the
  host. Existing pure instance builders used by other legacy import/AI preparation
  paths remain; their normalization/default behavior is compared in parity tests.
  This is not full migration of effect-keyframe, generic element/clipboard writes,
  all rendering hosts or every remaining feature family.

Validation: the complete editor-api native unit/integration test run passed,
including Classic archives/history, all effect mutations, settings/audio/tracks,
HyperFrames import/source/layer/library/variable regressions and applicability.
All 52 web tests passed in eight isolated suites with no failures/skips:
`.local/classic-web-tests/1791197578628/summary.json`. Real-WASM cases compare all
seven built-in effect defaults plus aliases and unknown/empty custom fallback,
preview undo, reopen history, compound rollback and agent/UI document equality.
A new product effect registered after an agent run starts is discoverable and
usable without agent wiring. Registry tests cover rejection rollback/disposal.
The initial multi-step agent fixture reused a superseded epoch; it now consumes
the current epoch after the catalog read. The focused lifecycle suite stubs its
renderer catalog, like its fonts/renderers; the separate parity suite loads the
real definitions and both WASM bindings. Production TypeScript and all 11 scanner
tests passed. Targeted lint has zero errors and one pre-existing unsafe-assertion
warning in editorial-template's unrelated response parser. The source/WASM gate
passed with 1,019 source files and 32 remaining legacy classes. Final lock-order
cleanup releases the document scope-check lock before acquiring the catalog lock.
The final WASM build completed; manifests and 39 legacy/32 canonical exports
verified. Both focused real-WASM effects cases passed (58 assertions), following
the three focused native effects tests. The final actual-source/WASM gate passed
with 364 manager methods, 33 actions and 1,218 JSX event sites. All processes for
this effects step have finished.

No real signed-in browser effect gesture, live model inference or packaged/hosted
acceptance is claimed. Full feature enforcement, durable conversations/artifacts,
UI automation, SaaS, image generation and the original HyperFrames library/remix
acceptance remain required. The complete goal stays active.

2026-10-05 Classic mask controls and freeform point editing:

- Added `timeline.classic.masks.edit` as an immediate Classic-only Write
  capability. The explicit project/scene/track/element/mask/revision contract
  supports removal, explicit inversion, inversion toggle, point deletion and
  insertion on a freeform segment, with cancellation, dry run, registry retry
  receipts, atomic transactions and durable Undo/Redo. Only video/image/graphic
  clips are maskable; duplicate or missing target masks are rejected.
- Rust now owns closest-segment sampling, straight/cubic splitting, control
  handle adjustment and recentering. Canvas coordinates/bounds and freeform
  geometry are validated; insertion bounds the path to 10,000 points. IDs are
  allocated within the document and avoid existing project IDs. Closed paths
  include the final-to-first segment. Point deletion opens a path when fewer
  than three anchors remain. Unknown mask/parameter/point fields survive edits;
  unrelated legacy masks remain opaque and can still be removed.
- TimelineManager's four explicit mask actions now call the canonical session
  through CommandManager. Insert/delete selections are included in the atomic
  host history and survive undo/redo and reopening. Compound failures roll back
  the project and the selection together. The same discovered capability is
  executable by the editing agent without a second tool definition.
- After native and real-WASM parity passed, removed the four legacy mask
  Command classes, their barrel and exactly their four baseline entries. Moved
  the old insertion implementation to a test-only reference fixture. Rendering,
  pointer interaction and remaining mask creation/parameter/pen-drawing paths
  are retained; this is **bridged explicit mask controls/point insertion and
  deletion**, not a claim that the entire mask feature family has migrated.

Validation: all three new native mask tests and both focused
real-WASM tests passed (213 assertions). Geometry is compared with the previous
Classic implementation for straight/curved, open/closed, transformed and
zero-width-bound paths. Tests cover whole-project preservation, durable
selection/history, dynamic agent discovery/UI document parity and compound
rollback. WASM built and all 39 legacy/32 canonical exports verified. Production
TypeScript, targeted lint, new Rust module formatting and diff checks passed.
The actual-source/WASM inventory passed with 1,014 source files, 28 legacy
classes, 365 manager methods, 33 actions and 1,218 JSX sites. In the first broad
web matrix, the large command-manager suite reached its 150-second suite limit
after 26 passing cases while the native regression build was also compiling;
no assertion failed before the timeout. The other four suites passed all 25
tests. The full native editor-api unit/integration regression run subsequently
passed, including Classic preservation/history and HyperFrames regressions.
The separate command-manager rerun completed 37/38 cases; its existing streamed
provider integration hit Bun's default five-second per-test timeout at 6.56s.
That five-round/visual-review real-WASM case now has an explicit twenty-second
bound, with unchanged assertions. The final separate rerun passed all 38 cases,
zero failures/skips, in 134.2s:
`.local/classic-web-tests/1791199314206/summary.json`. Together with the four
passing suites in `.local/classic-web-tests/1791198871964/summary.json`, all 63
distinct web tests in this validation scope passed. All processes from this
step have finished. This is local integration evidence, not browser acceptance.

No signed-in visual gesture or live-model acceptance is inferred from these
tests. Remaining requirements from the original plan are unchanged; the full
goal remains active.

2026-10-05 Classic mask creation, parameters and canonical previews:

- Added `masks.classic.catalog.read` and extended `timeline.classic.masks.edit`
  with create/update. The host publishes serializable definitions from the actual
  MasksRegistry, including parameter descriptions, defaults and declarative
  fixed/square/diagonal sizing. Rust allocates mask IDs, computes sizing, validates
  declared parameters and freeform geometry, and merges updates without dropping
  unrelated metadata. Creation retains the product's one-mask-per-clip rule.
- Catalog publication is bounded, atomic and host-only. Its content signature
  fences create/update requests against changed renderer definitions. Registry
  replacements retain order, roll notified hosts back after rejection and release
  session subscriptions. A newly registered renderer is discoverable and usable
  by the agent without a separate model tool or agent-side mask list.
- Mask menus, parameter fields and canvas handle previews now request canonical
  dry runs. Returned masks are presentation overlays; the pending request retains
  its project session, account, scene, document revision and catalog signature.
  Committing produces one undo boundary; cancellation leaves the document alone.
  Freeform append/close now commit through the same mask capability. Pointer
  interaction, snapping and pen-append geometry still contain host-side math;
  this does not claim complete Rust migration of every mask interaction.
- Real-WASM integration exposed an unnecessary host synchronization before a
  standalone commit that advanced its revision and rejected a valid preview.
  Synchronization now runs there only for earlier commands in a compound action.
  Intervening edits still reject the old request. Timeline projections retain
  their mask-preview identity after session teardown, so they cannot fall through
  to generic whole-track writes. Failed pointer previews/commits clear drag state
  and release pointer capture.
- Migration contract: **bridged** explicit mask creation, parameter writes,
  creation/parameter/handle previews and the existing explicit mask controls.
  Existing import/preparation builders and renderer implementations remain.
  New custom context-sensitive defaults must use the product's declarative sizing
  contract; arbitrary host callback execution is not exposed to the agent.

Validation: five native mask tests passed. Focused real-WASM tests passed with
183 assertions, comparing all ten built-in defaults at fallback, landscape,
portrait and zero-width dimensions, dry-run/commit equality, combined parameter
gestures, undo/redo, conflict rejection, session teardown and agent/UI equality
for a newly registered mask. The full isolated web matrix passed 67 tests in six
suites, zero failures/skips:
`.local/classic-web-tests/1791201031691/summary.json`. This includes all 41
command-manager cases, project lifecycle, JSON transport, canonical session,
mask snapping and catalog rollback/order/disposal. Final production TypeScript,
Rust formatting, diff checks and all 11 architecture-scanner tests passed.
Targeted lint has no errors; its remaining rounded-rectangle unsafe-assertion
warning predates this work. WASM built successfully and manifests/export checks
verified 39 legacy/33 canonical exports. The actual-source/WASM gate passed with
1,014 source files, 28 legacy classes, 371 manager methods, 33 actions and 1,218
JSX event sites. The complete `cargo test -p opencut-editor-api -p
opencut-editor-agent --tests` run finished successfully, including all 26 agent
integration tests, editor-api unit/integration tests, five mask cases and the
Classic/HyperFrames regressions. All processes started for this step have
finished. Final pointer cleanup also passed production TypeScript and targeted
lint/formatting; real browser pointer interaction remains an acceptance task.

These are local integration results, not authenticated visual/browser, live
model, Electron or SaaS acceptance. Complete feature exposure, durable chat and
artifacts, scoped UI automation, hosted isolation, images and the verified
HyperFrames library/remix/export acceptance remain required. The full goal
remains active.

2026-10-05 Classic keyframe timing and curve editing:

- Added `timeline.classic.keyframes.edit` for explicit project/scene targets and
  batches of up to 1,000 retime/curve edits. Rust owns stable key ordering,
  duration bounds, shared identities across composite components, handle bounds,
  null-versus-omitted handle patches and scalar/discrete validation. Existing
  animation paths come from the actual document, including effect, graphic and
  future custom paths; no second agent path allowlist was introduced.
- A failed edit rejects the entire batch. Contracts support dry run, exact retry
  receipts, optimistic revisions, cancellation and durable Undo/Redo. Unrelated
  channels, media and unknown fields are retained. Equal-time keys remain in
  stable order. Retiming works across components; curves target a named scalar
  component and cannot be applied to discrete channels.
- TimelineManager and keyframe dragging use the canonical capability. A drag
  captures its session/account/scene/revision before movement; intervening edits
  or teardown reject its commit. Rejected gestures release DOM listeners. Graph
  editor previews capture the same guard, and temporary projections are cleared
  after commit/rejection or unmount. Graph preview rendering and conversion from
  normalized curve controls to handle patches remain in the host.
- Removed the two replaced RetimeKeyframeCommand/UpdateScalarKeyframeCurveCommand
  classes, their exports and exactly their reviewed baseline entries after
  native/real-WASM parity tests. Remaining animation builders are still used by
  creation, removal, clipboard and other legacy edit paths and were retained.
- Migration contract: **bridged** existing keyframe retiming, scalar curve edits
  and their batch/drag paths. Keyframe creation/removal, value editing, clipboard,
  remaining graph math and complete animation-feature acceptance are outstanding.
  This step does not mark the whole keyframe family or complete goal finished.

Validation so far: three native tests passed for dry runs, exact retries, batch
rollback, malformed inputs, cancellation, bounds, composite preservation and
history after reopening. Three focused real-WASM integration cases passed with
80 assertions after the final preview cleanup. They compare retiming/curve
results against Classic across scalar, composite, discrete and custom paths;
exercise the actual TimelineManager and drag controller; verify stale-session
rejection and agent/UI document equality. WASM built and manifests verified
39 legacy/33 canonical exports. Architecture source/runtime validation passed
with 1,012 files, 26 remaining legacy classes, 374 manager methods, 33 actions and
1,218 JSX sites; all 11 scanner tests passed. Production TypeScript and targeted
lint passed, including the final graph-preview cleanup and revision guard.
The first broad web matrix passed the four supporting suites (17 tests), but
six older command-manager cases exceeded Bun's default five-second test timeout
while static checks were also running. Their failure reports were timeouts,
not assertion mismatches. Those six integration cases now have explicit
twenty-second limits without changing assertions. The complete separate rerun
passed all 44 command-manager cases, zero failures/skips, in 196.6 seconds:
`.local/classic-web-tests/1791202835375/summary.json`. Together with the four
supporting suites in `.local/classic-web-tests/1791202451858/summary.json`, all
61 distinct web tests in this scope passed. The final focused keyframe run also
verified that graph preview overlays are cleared after curve commits. All build,
test and static-check processes from this step finished; no model inference or
real browser gesture acceptance is implied by the fixture-driven drag test.

No authenticated browser gesture, live model, packaged Electron or hosted QA is
inferred. The full accepted goal and every other pending acceptance item remain.

2026-10-05 Live Classic animation target discovery:

- Added `animation.classic.targets.read` to the canonical registry. An explicit
  project/scene/track/clip read resolves parameter paths even before the first
  key exists. It returns base values, animation presence, catalog/document
  revisions and optional product parameter/channel descriptions. Exact path,
  case-insensitive label/path queries and pagination (maximum 100) keep discovery
  selective. Missing host catalogs, wrong projects/targets and stale requested
  revisions fail explicitly; reads do not mutate project state or history.
- Added the host-only `ClassicAnimationCatalog` with bounded, validated metadata
  and content-based revision identity. Classic sessions publish live element,
  graphic and effect registries automatically and detach subscriptions on failed
  attachment or teardown. Renderer, read/write and channel composition callbacks
  stay out of the serialized payload. Effects resolve against actual instances
  and the product's declared visual element types, not a separate Rust allowlist.
- Extracted specialized camera parameter declarations into the product's
  `specializedAnimationTargets` registry, consumed by both the existing UI
  resolver and the canonical catalog. Future specialized definitions now follow
  this same automatic path. Generic definition publication supports ordered,
  pre-commit subscriptions and rolls notified hosts back when a listener rejects
  a registration. WASM rejects metadata replacement during a document transaction.
- Migration contract: **bridged read/discovery** of Classic animation parameters.
  This is the prerequisite for canonical keyframe creation, not its completion.
  Upsert/removal/value coercion/color composition/clipboard remain on their
  existing edit paths; none of those legacy commands were removed in this step.
  Retime/curve canonical behavior from the previous step remains intact.

Validation: three new native catalog tests and the three existing native
keyframe tests passed. Four focused real-WASM/product tests passed with 1,077
assertions, checking metadata against the existing resolver across all current
element, graphics, effect and camera definitions; live future definitions;
rollback; transaction rejection; and disposal. A separate real-WASM CommandManager
case verified agent discover/describe/invoke through the actual session binding
without changing the project. The first matrix fixture lacked a valid source for
the HyperFrames graphic; it was corrected by importing a canonical source before
testing that definition. No product validation was relaxed.

WASM built successfully; manifests/export verification now checks 39 legacy and
34 canonical exports. Production TypeScript and targeted ESLint passed after the
specialized-registry refactor. All 11 architecture-scanner tests passed, and the
final actual-source/WASM gate passed with 1,014 source files, 26 legacy classes,
374 manager methods, 33 actions and 1,218 JSX event sites.

The first isolated eight-suite regression matrix passed 66 tests but reported
two five-second timeouts in existing command-manager cases (track creation and
pause/steering), plus a lifecycle fixture import failure. That fixture already
stubs renderer/font/default definitions; it now stubs the new animation metadata
binding at the same boundary, while real catalog/resolver tests remain separate.
Its new stub still publishes an empty validated catalog into real canonical WASM.
The two timed-out integration cases received explicit twenty-second limits with
no assertion changes. The final isolated rerun passed all 45 command-manager
cases and the lifecycle case (46 tests, zero failures/skips), in 308 seconds:
`.local/classic-web-tests/1791204528741/summary.json`. Together with the six
supporting suites (23 tests) in the initial report
`.local/classic-web-tests/1791204220526/summary.json`, all 69 distinct Web tests
in this scope passed. Final test-file lint/formatting and Rust formatting/diff
checks passed. All build/test/check processes started for this step are terminal.
No live-model, browser, Electron or SaaS acceptance is claimed. The full goal
remains active.

2026-10-05 Canonical Classic keyframe creation and value edits:

- Added `timeline.classic.keyframes.upsert`, using the same live product target
  catalog as discovery. Inputs explicitly name project/scene/track/clip/path,
  local integer ticks, values, optional IDs/interpolation, document revision and
  catalog revision. Batches of up to 1,000 edits validate and commit atomically;
  failures/cancellation roll back keys and ID allocation. Dry run returns the
  same resolved identities as a subsequent unchanged commit, and exact retries
  return the recorded receipt.
- Rust owns numeric step snapping/clamping, typed discrete/select validation,
  CSS color decomposition, ID/time reuse, component updates and curve/handle
  normalization. Existing exact-time keys are reused; explicit existing IDs
  take priority. Composite channels use the primary identity while retaining
  Classic's existing per-component time-collision semantics. Unknown metadata
  is retained rather than being pruned by old animation builders.
- Product channel layouts now declare `identity` or `linearRgba` codecs. UI
  callbacks are still renderer/legacy consumers; the canonical authoring path
  executes no host coercion or composition callback. Color parsing uses pinned
  MIT-licensed `culors` 1.6.0 (https://docs.rs/culors/1.6.0/culors/), with the
  product's existing sRGB-to-linear transfer behavior applied explicitly. Its
  color-mix extension is rejected to retain the current Culori input contract.
  A new codec needs canonical semantics as part of the product, not agent wiring.
- TimelineManager's general/effect upsert entry points invoke the canonical
  transaction and clear temporary previews on success/failure. Grouped writes
  retain a single Undo/Redo boundary. Removed the replaced UpsertKeyframeCommand
  and UpsertEffectParamKeyframeCommand classes/exports and exactly their reviewed
  architecture baseline entries after native and real-WASM/UI parity checks.
- Shared the existing recursive Classic ID collector between effect/mask/source
  audio/keyframe operations. Upsert scans IDs once per batch and includes later
  explicit identities in that set, avoiding repeated whole-project scans and
  collisions between explicit and generated IDs.
- Migration contract: **bridged keyframe creation/value updates** for declared
  product parameters, including effect/graphic/specialized targets. Existing
  retime/curve paths remain canonical. Deletion with playhead-value preservation,
  clipboard, remaining graph math and full animation-family acceptance remain.

Validation so far: all 21 scoped native tests passed (six keyframe cases, three
catalog, three effects, five masks, four source-audio). New authoring cases cover
dry run/retry identities, type/range/scope failures, batch rollback, cancellation,
ID collisions, metadata/curves and reopened history. Three real-WASM parity tests
passed with 500 assertions covering scalar/discrete operations, 296 numeric
coercion samples and 20 CSS colors (including wide-gamut/transparent/none cases),
comparing color channels within 1e-10. A focused real-WASM CommandManager test
passed 13 assertions for UI/agent equality on a newly registered effect, preview
cleanup, grouped rollback, Undo/Redo and reopening. Its initial agent test used a
stale epoch after a read; the fixture now consumes the refreshed epoch, retaining
the production steering guard.

Production TypeScript passed. Targeted ESLint passed after converting the new
test helper to the repository's object-parameter convention. Final WASM built;
manifests verify 39 legacy/34 canonical exports. Formatting/diff checks passed.
The final architecture gate passed (1,012 sources, 24 legacy classes, 375 manager
methods, 33 actions, 1,218 JSX event sites), along with all 11 scanner tests.
The nine-suite matrix reported 71 passes and two existing integration timeouts
at their twenty-second limit: project settings and fractional-rate bookmarks
(`.local/classic-web-tests/1791206212188/summary.json`). Both passed a focused
rerun with unchanged code/time limits. The full command-manager rerun then passed
all 46 cases, zero failures/skips, in 255.8 seconds
(`.local/classic-web-tests/1791206718357/summary.json`). Together with the eight
supporting suites, all 73 distinct web tests in this scope passed. These are
local integration checks, not live-model/browser/Electron/SaaS acceptance.
The full accepted goal remains active.

2026-10-05 Canonical Classic keyframe removal and playhead preservation:

- Added `timeline.classic.keyframes.remove` to the same live registry used by UI,
  agent discovery/invocation and MCP projection. Explicit project/scene/revision,
  catalog revision, absolute integer playhead ticks and up to 1,000 key references
  define one atomic edit with cancellation, dry run, exact retries and undo.
- Rust samples each original affected path before any key is removed. Scalar
  step/linear/Bezier interpolation (including Classic's twenty-iteration solver),
  stable equal-time ordering, linear/hold edge behavior, discrete fallback and
  linear-RGBA color formatting match the existing product helpers. Clip-local
  time is clamped before sampling. Removing the last key persists the sampled
  value using the same canonical product coercion as key authoring. Partial
  deletion keeps the base value. Explicit retain-base behavior preserves the
  existing effect-only removal control's different policy.
- General and effect-only TimelineManager deletion now use canonical
  transactions and clear previews on success/failure. Removed their two replaced
  legacy classes, empty export barrel and precisely their architecture-baseline
  entries after real-WASM/UI parity passed. Unknown unrelated animation data
  remains intact; invalid targets or unrepresentable sampled values reject the
  entire edit instead of silently dropping keys or partial changes.
- Migration contract: **bridged keyframe deletion** for live product targets,
  including effects and composited colors. This completes the former six
  keyframe command classes' replacement (creation/value, retime, curve and
  deletion). Clipboard and other animation/UI mutation paths, remaining graph
  math and complete animation-family/browser acceptance are still outstanding;
  zero classes in that folder is not complete feature-family proof.

Validation so far: nine native keyframe cases and three catalog cases passed.
New tests cover original-batch sampling, dry run/retries, exact scope/revision,
cancellation, duplicate removal references, metadata, undo/redo/reopened history
and rollback when final base-value coercion fails after keys were removed.
Two real-WASM parity tests passed 376 assertions (374 cases spanning partial/all
deletion, twelve scalar curve variants, equal times, out-of-range handles,
extrapolation, Hebrew text, boolean/select, RGBA and partial color channels).
The final focused UI/agent test passed 17 assertions, including future product effect
discovery, differing general/effect base policy, preview cleanup, compound
rollback and reopened Undo. Existing authoring parity also passed (500 checks).
The initial native test incorrectly compared dry-run and committed receipt
flags; it now verifies their documented difference plus matching predicted
revision/changed IDs. No production validation or timeouts were relaxed.

WASM built; manifests/export verification passed (39 legacy/34 canonical).
Architecture gate passed with 1,009 sources, 22 legacy classes, 376 manager
methods, 33 actions and 1,218 JSX event sites; all 11 scanner tests passed.
Final production TypeScript, targeted lint (zero warnings), formatting and diff
checks passed. The ten-suite regression matrix passed all 76 tests, zero
failures/skips, in 318.8 seconds:
`.local/classic-web-tests/1791207467738/summary.json`. It includes all 47
command-manager cases, project lifecycle and the supporting animation/catalog/
parameter/camera/motion/effect suites. The final focused UI test additionally
verified that general effect deletion persists the sample into that effect's
parameter map without changing element base parameters. All build/test/check
processes started in this step finished. Full live-model, browser, Electron,
SaaS and HyperFrames acceptance remain unverified and the goal active.

2026-10-05 Canonical animation clipboard capture and paste:

- Added registry capabilities `animation.classic.keyframes.copy` (read) and
  `timeline.classic.keyframes.paste` (write), consumed automatically by agent/MCP
  discovery. Copy reads explicitly scoped, revision-fenced selected keys from
  one Classic clip and returns portable values, relative ticks, interpolation
  and per-component curve patches. Missing/uncomposable selections are reported.
  This does not access the OS clipboard or transfer another project's media.
- Paste resolves the destination's live product catalog, adds/clamps local
  offsets, reuses exact-time identities, applies each item's curves sequentially
  and preserves the existing edge-handle normalization behavior. Direct key
  authoring and paste now call the same transaction-local Rust implementation
  for coercion, component writes and collision-safe ID allocation. Unsupported
  target paths and inapplicable curve components are reported explicitly. Input,
  revision, catalog, cancellation or applicable-curve failures roll back the
  whole batch; dry runs, exact retries and reopened Undo/Redo are covered.
- ClipboardManager and its keyframe handler now read/call the canonical
  contracts. The generic paste-handler contract supports canonical actions as
  well as remaining legacy element commands, with typed dispatch and no unsafe
  `never` assertion. The old PasteKeyframesCommand/export/baseline entry were
  removed after real-WASM parity passed; its pure implementation remains only
  as an independent test oracle. Preview state clears after paste success/failure.
- Fixed dependence on JSON object insertion order for composite key selection:
  UI queries and Rust clipboard capture use r/g/b/a order and then ordinal names.
  Clipboard item ties also use locale-independent ordinal property paths. This
  intentionally replaces locale-dependent tie ordering; timing and values are
  unchanged. Tests include differently ordered JSON maps and distinct component
  IDs at the same times, verifying target identity and curve behavior.
- Migration contract: **bridged animation clipboard** for a single source/dest
  clip. Element/media clipboard, broader cross-project dependency copying,
  remaining graph math and full animation/browser acceptance remain outstanding.
  The full accepted editing-agent scope is unchanged.

Validation so far: 12 native keyframe and three catalog tests passed, including
three new clipboard cases for read scope/no mutation, values/offsets/curve data,
partial support reporting, dry run/exact retries, failure rollback including ID
allocation, cancellation and reopening history. A fixture initially compared
JSON floating-point samples to integer JSON representations; expected numbers
were corrected to floats without changing production semantics.
Two real-WASM clipboard parity tests passed 57 assertions across scalar segments,
Hebrew text, boolean, color, offset clamps, same-time collisions, component IDs
and component ordering. Existing authoring/removal parity passed alongside them
(`.local/classic-web-tests/1791208512195/summary.json`, seven cases).
The actual ClipboardManager and discovered-agent integration passed 19 checks
for copying without history mutation, the same pasted project, preview cleanup,
compound failure rollback, single Undo and recovery after reopening.

WASM built and manifests verified (39 legacy/34 canonical exports). Production
TypeScript and targeted lint passed after replacing the preexisting unsafe
clipboard-dispatch cast with a generic correlated type. Architecture gate passed
with 1,008 sources, 21 legacy classes, 378 manager methods, 33 actions and 1,218
JSX event sites; all 11 scanner tests passed. Rust/TS formatting and diff checks
passed. The first eleven-suite matrix passed 74 tests and reported five existing
command-manager timeouts (two at twenty seconds, three at Bun's five-second
default), without assertion failures:
`.local/classic-web-tests/1791208639741/summary.json`. All five passed unchanged
in an isolated rerun (88 assertions, 17.64 seconds). Inspection confirmed that
canonical teardown frees the runtime and unregisters catalogs; no resource-leak
root cause was established. Repeated timing failures across these real-WASM
integration runs motivated one explicit sixty-second per-case budget for all
48 cases, retaining the runner's 480-second suite cap. Assertions and product
validation remain unchanged; these time limits are not performance acceptance.
The full command-manager rerun passed all 48 cases, zero failures/skips, in
289.2 seconds: `.local/classic-web-tests/1791209247400/summary.json`. Together
with the ten supporting suites (31 cases) in the first matrix, all 79 distinct
web cases in scope passed. Final test-file lint/formatting and diff checks also
passed. All build/test/check processes started in this step are terminal.
No live-model/browser/Electron/SaaS or complete HyperFrames acceptance is
inferred. The full goal remains active.

### 2026-10-05 Semantic editor observation through the canonical host bridge

Previous goal increment: progress (canonical animation clipboard and verified
history parity). Re-read the complete accepted plan and repository instructions.
The full goal remains active; this increment starts the missing interface-host
work rather than declaring the existing editing surface complete.

- Added the host-installed `editor.ui.snapshot` typed capability in editor-api.
  It is a Classic read, asynchronous, bounded, cancellable before/after host IO,
  explicitly project/revision fenced, and schema-discovered by the existing
  harness. No separate model/MCP feature table was added. Native/headless
  runtimes do not register it by default. The browser WASM host installs it;
  the server's temporary checkpoint validator installs its contract only to
  validate saved browser runs, without performing DOM IO.
- Added the `editorUi` browser host adapter and connected it to the actual
  EditorAgentClient. It verifies active account/project and reads only the
  uniquely marked active editor root in the Classic project page. It reports
  bounded accessible labels, roles, focus/disabled/selection/check/expanded
  states and viewport boxes. Ordinary new semantic controls appear on the next
  observation without agent registration. This does not prove activation or
  canonical coverage of those controls.
- Observation excludes input values, private regions, agent chat, embedded
  documents, other/nested projects, hidden and completely clipped controls.
  Label references cannot read outside the editor root or extract text-input
  content. Query/limit and traversal budgets bound context/work, including
  rejected private nodes. UI labels are explicitly untrusted content. No DOM
  events, arbitrary selectors, host functions or document writes are exposed.
- Pending reads survive paired editor/run checkpoint recovery and atomic
  session validation. Cancellation, document changes and mismatched host scope
  reject the result; malformed host schema does not consume the pending request.
- Migration contract: **bridged semantic observation**, not complete UI
  automation. Portals outside the root, richer accessibility relationships,
  canonical control activation, Electron's scoped Playwright/CDP adapter,
  screenshots and actual editor/live-model acceptance remain outstanding.

Validation: three new native editor-api tests passed for registry/host schema,
scope/revision/cancellation, bounded output and unchanged `app.state.read`.
The first test iterations used an incorrect rename capability and then wrong
Rational field names; these fixture errors were corrected to the existing
Classic settings contract. Existing agent runtime (nine), checkpoint (two) and
session-store (four) cases passed; a new pending-UI atomic-save test also passed
alongside the session-store suite (five). Total: 19 distinct native cases.

Real Chromium/WASM integration passed using the production browser host bundle:
Hebrew labels and states, automatic discovery of a newly inserted button,
account/project rejection, no input/private/iframe/cross-project leakage,
clipping, bounded rejected-node traversal, unknown-input rejection, pending
recovery and unchanged canonical state (25 assertions). This is a controlled
browser fixture, not packaged Electron or live-provider acceptance. Final web
matrix: six tests, zero failures/skips, 14.4s including storage-host and host
transport suites, `.local/classic-web-tests/1791210706459/summary.json`.
An earlier matrix also passed the existing WASM checkpoint case, giving seven
distinct web cases in scope (`1791210569115/summary.json`).

Canonical WASM built (2m54s); both manifests verified (39 legacy/34 canonical
exports). Production TypeScript, affected-file ESLint/Prettier, targeted Rust
formatting and diff checks passed. The broader TS configuration including all
tests reports unrelated test typing errors; no whole-tree TS pass is claimed.
Architecture gate passed: 1,009 sources, 21 legacy classes, 378 manager methods,
33 actions, 1,218 JSX event sites (candidate coverage only). All processes
started in this increment are terminal; no completion of the full plan is claimed.

### 2026-10-05 Declarative canonical controls and actionable UI observations

Re-read the full accepted plan and repository instructions after the user's
explicit resume. The previous engineering increment made progress; intervening
voice/status replies did not change implementation. Rechecked goal state during
this increment: active. No recurring external blocker was established.

- Added `CanonicalButton` and a bounded, account/project-scoped host binding
  for an actual DOM node. One declaration supplies the button's canonical
  invocation and its semantic action hint. Clicks and observations read the
  same validated captured declaration. Model text and authored DOM attributes
  cannot create bindings; disabled/unmounted controls remove their binding.
- `CommandManager.invokeCanonicalControl` uses the existing canonical
  transaction, active account/project checks, batch edit guard and publication
  of editor views. The session injects current project/revision; reserved scope
  overrides are rejected. Registry schemas, availability, policies and the
  synchronous transaction gate remain authoritative. Async/non-transactional
  operations require their own established host path, not this UI shortcut.
- Migrated the visible timeline mute/visibility icons to real labelled buttons
  using that component and the existing `timeline.classic.track.update`
  capability. Existing context-menu controls retain their canonical manager
  path. No second track edit implementation or agent capability table was added.
- `editor.ui.snapshot` v1.1.0 reports optional host-bound capability/input
  hints and pressed state. Hints carry the observed project/revision; Rust
  rejects mismatched scope and oversized hints. An agent still describes and
  invokes the original product capability under its own policy. A hint does
  not assert that an unknown capability exists or is available.
- The architecture inventory now resolves inline literal bindings on the real
  `CanonicalButton`, including import aliases, and joins them to the compiled
  registry gate. Same-named unrelated components are excluded. This covers
  explicit declarations, not every dynamically computed binding or legacy UI
  path. Full feature migration/future-feature enforcement remains unfinished.

Migration contract: **bridged action-bearing semantic controls**, initially
track mute/visibility. This improves read → describe → invoke using the shared
runtime, not arbitrary DOM clicking. Remaining work includes other controls,
owned portals and transient presentation actions, Electron Playwright/CDP,
screenshots, live-provider acceptance and every other outstanding plan item.

Focused evidence: three native UI tests passed, expanded with action hint
scope/revision/size failures. Two checkpoint and five session-store regressions
passed, including pending browser-observation persistence. The actual command
manager passed 24 focused assertions for account/project fences, reserved scope,
unknown/async capabilities, whole-transaction rollback, matching host views,
single Undo/Redo and reopened history. The new Chromium test renders the real
React button against a fixture editor host, then executes its captured action
and the observed agent action in real WASM and compares project results. It
also checks DOM-attribute spoofing, new declaration discovery, disabled and
unmounted controls. Its initial standalone bundle resolved multiple React
copies; deduplicating React in the test bundler fixed the invalid-hook failure
without changing product dependencies. A mistyped focused-test preload path
was corrected to the repository's existing `test-support/real-wasm.ts`.

WASM built (3m08s), manifests verified (39 legacy/34 canonical). Production
TypeScript, targeted ESLint, formatting and diff checks passed. Twelve scanner
tests passed; compiled-registry architecture gate passed (1,011 sources,
21 legacy classes, 379 manager methods, 33 actions, 1,217 JSX event sites).
Final matrix passed all 53 web tests, zero failures/skips, in 290.5 seconds:
`.local/classic-web-tests/1791213039277/summary.json`. This includes all 49
command-manager cases plus the new rendered-control browser test, semantic UI
browser test, host transport and checkpoint suites. Ten distinct native cases
passed in scope. All processes started in this increment are terminal. The full
goal remains active; no live-model, complete UI/Playwright, packaged Electron,
SaaS or full HyperFrames acceptance is inferred from these checks.

## 2026-10-05 Owned Electron Playwright and screenshot evidence

The active goal remains the entire accepted plan. The voice-only clarification
did not advance implementation; this continuation re-read the plan and current
tree and made implementation progress. The branch and shared dirty worktree
were preserved; no commit, staging or broad cleanup was performed.

Added a host-owned Playwright connection through Electron's webContents debugger.
It uses an ephemeral authenticated loopback WebSocket, a random bearer token,
one client, no browser-origin connections and no HTTP discovery endpoint.
The virtual CDP browser exposes exactly the selected OpenCut window. Root
browser/storage/target-management commands and unknown session IDs are rejected;
worker and other target attachment is not forwarded. Navigation, destruction,
debugger detachment and caller cleanup close the transport. No global Chromium
debug port is enabled. Page, CDP endpoint and token stay in trusted host code;
no renderer/model API accepts JavaScript, selectors, URLs or protocol commands.
Dependencies playwright-core 1.63.0 and ws 8.22.0 are declared in the Electron
app's production package, which now participates in the existing Bun workspace.
Packaged dependency inclusion is not yet independently verified.

The production preload exposes one fixed screenshot operation. Its main-process
handler accepts only the owned main frame on the application's editor origin and
route. The capture checks account, project root and route before/after Playwright
capture, clips to the visible editor and masks agent chat, private regions and
editable controls. The host returns JPEG bytes with bounded dimensions (2048
longest side) and size (2 MB); IPC errors omit Playwright connection details.
Other windows cannot invoke this handler to capture the main window.

Added canonical `editor.ui.screenshot`, installed through the new WASM
`installDesktopUi` host method only when the desktop bridge is available, before
agent restoration/start. Ordinary browser/headless registries do not advertise
it. The host adapter checks scope/cancellation around IPC and puts bytes in the
canonical ArtifactStore. Rust checks project/revision/cancellation, matches the
actual stored artifact metadata, and returns the artifact in the invocation
receipt without editing state or adding Undo history. The persistence validator
installs the descriptor solely to validate pending desktop checkpoints, without
performing screenshot IO. Screenshots currently share the temporary artifact
lifetime; durable conversation artifact persistence is still outstanding.

Provider requests now resolve image artifacts from actual run receipts,
generically for any capability: at most two PNG/JPEG/WebP images totaling 2 MB
of binary data, only for the observed document revision. Images are sent as
multimodal request content and labelled as untrusted captured evidence; they do
not self-attest video/audio correctness. Checkpoints retain references, not image
data URLs. Expired/missing artifacts and artifacts without this run's receipts
are not attached. Actual authorized model inference is still unverified.

Verification completed:
- Eight Electron tests pass, including one actual Electron integration fixture
  using production transport, screenshot adapter and preload. It exercises a
  Hebrew Playwright click, an independent second window, forbidden browser/CDP
  targets, unauthorized/origin/duplicate connections, real PNG capture, real
  scoped JPEG capture, masked pixel color, account/project/window rejection,
  disconnect/reconnect, navigation revocation and destruction. Hidden test
  windows use offscreen rendering: the initial non-offscreen fixture timed out
  waiting for screenshot pixels; enabling offscreen rendering fixed that fixture.
  This is not a packaged application or full project UI acceptance test.
- Twenty-four distinct native cases pass across editor UI (3), screenshot (3),
  agent runtime (10), model protocol (1), checkpoint (2), session store (5).
  Screenshot cases cover stale/cancelled/malformed scope and missing/spoofed
  artifacts; session persistence covers both pending semantic and screenshot
  observations. The new future-image capability case verifies automatic image
  attachment, size/count budget, receipt isolation and artifact expiry.
- Four web suites pass with real WASM where applicable: desktop screenshot,
  semantic browser UI, rendered canonical controls and host effects. The desktop
  suite uses an isolated IPC response fixture, not live Electron pixels; actual
  pixels are verified separately above. It verifies discovery, pending run
  restoration, scope/cancel fences, artifact receipts, multimodal model payload,
  reference-only checkpoint and removal of stale images after a real edit.
  Report: `.local/classic-web-tests/1791214964525/summary.json`.
- Final canonical WASM build passed (3m47s); manifests and 39 legacy/35 canonical
  exports verified. Production TypeScript passes. Targeted ESLint exits cleanly
  with the existing Next pages-directory configuration warning. Compiled-registry
  architecture gate passes (1,011 sources, 21 legacy classes, 380 manager methods,
  33 actions, 1,217 JSX event sites). JavaScript syntax checks pass.

The full goal is still active. Complete semantic control activation, the rest of
the canonical feature migration, live-provider acceptance, durable artifacts,
packaged Electron/SaaS two-account acceptance, the 150 verified HyperFrames
packages and full remix/export acceptance remain outstanding. The successful
internal Playwright click is transport evidence, not a claim that all editor
controls are agent-accessible. All processes started in this increment have
finished.

## 2026-10-05 Interrupted Classic removal migration repaired

The user's development/integration plan remains the full objective. Repaired
the dangling production barrel and parity-test import after moving the old
`RemoveTrackCommand` into `core/__tests__/legacy-remove-track-fixture.ts`.
The production track barrel now explicitly exports an empty module; track
actions run through the canonical `TimelineManager` paths. The legacy
`DeleteElementsCommand` remains for compound text/SFX operations pending their
own verified migration.

The reopened-history test now calls `loadHistory` before enabling the session
and Undo, matching the real lifecycle and the existing integration fixtures.
It passes without a product-history change. Migration contract: **bridged
Classic removal**, with UI and agent using `timeline.classic.remove`, caption
source cleanup in Rust, atomic failure and persisted Undo/Redo. Legacy Ripple
gestures and the compound text/SFX paths remain distinct unfinished work.

Verification on the repaired tree:
- Two isolated real-WASM web suites passed: 51 tests, zero failures/skips,
  including the eight-mode removal parity case and all 50 command-manager
  cases. Report: `.local/classic-web-tests/1791216825180/summary.json` (346.2s).
- Two native `classic_remove` tests passed for state readback, caption/media
  preservation, dry run/retry/history, invalid targets, cancellation and stale
  revisions.
- Twelve architecture scanner tests and the compiled-registry gate passed
  (1,010 production sources, 20 legacy classes). Production TypeScript passed.
  Its first run exposed the now-empty barrel lacking module syntax; adding
  `export {}` fixed that compile error and the fresh run passed.

This closes the interrupted increment, not the full product acceptance plan.
The next increment begins by moving Parallax marker direction/speed controls
from a TS snapshot command into the existing canonical track contract.

## 2026-10-06 Canonical duplication, Parallax marker controls and mutation ratchet

The previous goal turn made implementation and verification progress. After
continuation, the old build/test handles were missing and no compiler process
remained. The existing WASM file predated the Parallax change, so fresh builds
and tests were run; completion was not inferred from stale process metadata.

- `timeline.classic.track.update` now includes a typed Parallax change. Rust
  validates canvas/marker targeting, direction and finite speed, and owns the
  established 0..400 clamping policy. `TimelineManager.updateParallaxTrack`
  invokes that contract instead of creating a TS track snapshot. The serialized
  Classic validator also protects marker direction/speed, canvas membership and
  empty marker elements through generic commit/patch routes. Migration contract:
  **bridged marker controls**, not completion of all Parallax scene operations.
- Added `timeline.classic.elements.duplicate`. Runtime allocation produces
  noncolliding clip/track/keyframe identities, creates one new populated track
  per selected source in the existing grouping/placement order, preserves source
  media and clip fields, and reconciles manual text ownership. Composite key
  identities remain shared within each property. Every component-only key also
  receives a fresh identity, improving the legacy primary-component-only remap.
  The shared canonical keyframe normalizer and track-layout implementation are
  reused. Caption removal/reconciliation moved into a shared Rust helper without
  changing removal behavior. No second media copy or filesystem operation was
  introduced. Migration contract: **bridged Classic duplication**.
- `TimelineManager` now calls this capability through the canonical command
  transaction, selection and reactor path. The old duplication command moved
  into an excluded frozen parity fixture and its production export was removed.
  No agent tool table or duplicate MCP handler was added. A generated-MCP test
  proves automatic schemas/envelopes, duplication retries, marker updates,
  removal, `app.state.read` and three Undo operations on the same runtime.
- Extended the architecture gate to freeze 138 existing generic/legacy mutation
  call sites, including aliased command construction, existing legacy execute
  usage and project/scene/track projection calls. Named lexical owners, call
  fingerprints and identical-occurrence counts keep comments/formatting stable
  and permit deletions without renaming later distinct sites. New canonical
  invocations need no mutation-baseline edit. Production imports/re-exports of
  excluded fixtures are rejected, including literal dynamic imports/requires.
  Removed the retired removal/duplication class baseline entries. CI now also
  triggers for editor-api/editor-agent changes. This is a stronger migration
  ratchet, not full proof against arbitrary object writes, computed names or
  changes inside imported helpers; the scanner documents those remaining limits.

Verification:
- Two new native Parallax cases and two duplication cases pass. The final focused
  editor-api matrix passes 24 tests across duplication, keyframes, removal,
  layout and track controls. Before duplication's helper extraction, the complete
  editor-api test matrix passed 139 cases, including the marker validator.
  These runs overlap and are not added together as product acceptance.
- Fresh canonical WASM builds passed (2m19s for marker controls, 1m50s for the
  final duplication/helper code); manifests and 39 legacy/35 canonical exports
  verify. The compiled registry advertises the new action automatically.
- Five isolated real-WASM/legacy web suites passed 60 tests, zero failures/skips
  in 252.7s, including all 52 command-manager cases, removal parity, six-mode
  duplication parity, track ordering and animation clipboard. Report:
  `.local/classic-web-tests/1791246557805/summary.json`. Three focused manager
  cases also pass for duplication/Parallax/removal and reopened history.
  The first duplication fixture lacked word-run lineIndex required by the JS
  WASM input; supplying that existing product field fixed the fixture. After
  object-parameter lint repairs, its parity suite passed again at
  `.local/classic-web-tests/1791247012781/summary.json`.
- Seventeen scanner tests pass, including negative new-feature/snapshot/fixture
  cases. The compiled-registry gate passes: 1,009 production sources, 19 legacy
  classes, 138 reviewed mutation sites, 382 manager methods, 33 actions, 1,217
  JSX event sites. These are static coverage candidates, not parity attestations.
- Production TypeScript and affected web ESLint pass. The broader test-inclusive
  TypeScript check reports 96 diagnostics in existing test fixtures/mocks,
  including 12 earlier command-manager cases; no new duplication/removal or
  Parallax test diagnostics occur. Full test typechecking remains unfinished.
  Diagnostic log: `.local/editor-architecture/typecheck-tests-2026-10-06.log`.

The full development goal remains active. Remaining editing work includes
insertion, movement, splitting, generic updates, paste, compound text/SFX,
transitions, both Ripple policies and remaining media/Parallax operations.
Durable conversations/artifacts, complete UI control, live-provider acceptance,
the 150 verified HyperFrames packages, packaged Electron and hosted two-account
acceptance remain required. Read-only connection availability inspection found
one local account data directory and no saved ChatGPT connection in the new
product path; real inference therefore still requires the human connection flow.

The complete MCP library suite subsequently passed all 14 tests, including the
new generated Classic feature/history case. A loopback-only webpack development
server is running at `http://127.0.0.1:3100` (unified exec session `96930`) for
manual account and provider connection. The root returns 200; the authenticated
agent-connection endpoint returns 401 without a session. Read-only inspection of
the actual in-app browser confirms the account name/password Sign in form loads.
No login or OAuth consent was automated. The user will connect ChatGPT later;
this defers live-provider QA, not the remaining development. Their earlier
temporary OpenCut access details were found in the account-migration chat and
the existing private access file outside Git; credentials are not copied into
this repository or ledger.

## 2026-10-06 Cross-site OAuth return preserves the Strict account session

The user signed into OpenCut in Chrome and reported
`{"error":"Sign in to access this account's data"}` after OpenAI authorization.
Inspection found the legacy browser OAuth handoff completion wrapped in
`withAccount`, while the OpenCut cookie uses `SameSite=Strict`. The existing
loopback callback can navigate from an external sign-in document through a
redirect chain to that authenticated endpoint without the Strict cookie.
The new editor-agent connection remains a separate flow; legacy credentials
are not silently reused for it.

Added a credential-free, nonce-CSP return document for a cross-site GET to the
exact completion path with a UUID handoff. It consumes no handoff and sets no
cookie. Its relative same-origin navigation resumes completion through the
unchanged account authentication, account/session binding and one-use handoff
checks. A marker prevents repeated return-document navigation. Cookie flags,
session lifetime and OAuth permissions are unchanged. This is a host-auth fix,
not another editor state store or tool.

The real Chromium regression loads an external origin before returning, observes
the missing Strict cookie on the cross-site request and the restored cookie on
the same-origin request, then reaches authenticated completion. The first test
fixture used only HTTP redirects beginning from the app; Chromium retained the
cookie in that chain. Loading the external provider document corrected the
fixture to model the actual browser sign-in transition. Unit cases cover bounded
landing, no credential exposure, no unauthenticated handoff consumption, invalid
targets and loop prevention. Six isolated suites pass all 23 tests (OAuth helper,
device login, account server/scope, new browser regression and new-agent
connection). Report: `.local/classic-web-tests/1791248178239/summary.json`.
Production TypeScript, affected ESLint and the compiled-registry architecture
gate passed. The live Next endpoint returns the new 200 return document for an
anonymous cross-site UUID handoff; its same-origin resume still returns 401
without a signed-in account, confirming the authentication fence remains active.
The user was asked to retry the actual sign-in;
live provider success and inference remain unproven until that return completes.
Official OpenAI sign-in guidance was fetched to check state/PKCE/callback binding:
https://developers.openai.com/siwc/token-sharing-open-source/sign-in . It describes
the new Sign in with ChatGPT contract, not a replacement validation claim for the
legacy Codex login contract. The development goal remains active.

## 2026-10-06 Preserve the browser origin through the legacy OAuth handoff

The user's retry supplied the authoritative failing URL: the completion was on
`localhost:3100`, while their authenticated editor was on `127.0.0.1:3100`.
Next's normalized `request.nextUrl.origin` had been recorded as the app origin,
changing the host of the account's host-only cookie. The Strict-cookie return
document alone cannot restore a cookie on a different host.

Added validated `localRequestOrigin`, reused by the existing origin fence and
the legacy OAuth start/return path. It keeps the browser's actual Host rather
than Next's internal hostname, rejects non-loopback hosts/credentials/protocols,
and does not trust forwarded-host headers. Existing in-flight return paths may
be retained only on the same loopback service/protocol/port and are rebased onto
the authenticated browser host; outside destinations return to the app root.
Session cookie flags, OAuth binding checks and permissions remain unchanged.
Two new regressions plus the existing account/OAuth tests pass. A live anonymous
callback probe confirms its Location header now stays on `127.0.0.1:3100`.

The attempt to navigate the user's old handoff directly in Chrome was blocked
by the browser client. No browser protection was disabled or bypassed. The
controlled Chromium fixture was also strengthened to include the production
gateway's default sandbox response header; it still passes. Browser/provider
sign-in remains pending a fresh user-initiated attempt, since handoffs expire
after two minutes. The legacy connection and new editor-agent OAuth flow remain
separate.

## 2026-10-06 Canonical Classic clip insertion and batch placement

Added `timeline.classic.elements.insert` for all seven established element
types, with a typed creation draft, lossless extension fields and an atomic
1..1000-clip batch. Rust owns timing/defaults, media/type validation, main-track
anchoring, explicit and automatic placement, fresh identity allocation and text
ownership reconciliation. Automatic placement uses display order and interval
overlap; an insert index only affects newly created tracks. Existing track order
is normalized and unrelated track layout fields survive. Offline media records
remain insertable. Binary browser handles are excluded from the canonical draft.
Creation updates derived main-scene duration in exact integer ticks, timestamps,
and the first visual clip's known canvas/original dimensions and video frame rate
as part of the same Undo entry.

`timeline.classic.elements.catalog` reads the actual host-published graphic
definitions/parameter metadata, including in an empty scene; graphic creation
requires its current catalog identity. The existing product catalog, track-layout
operation and caption reconciler are reused. No agent-specific definition list
or handwritten MCP handler was added.

Migrated TimelineManager's main insertion and speaker-frame insertion, UI/SFX
bundles, overlay-movement bundles, editorial-template insertion and bundle drag
drop to the canonical transaction. Batch selection matches the previous final
clip selection intent. Retired 17 generic/legacy call-site baseline entries by
deletion only, so these paths cannot be silently reintroduced. Migration contract:
**bridged creation**. The legacy insertion class remains solely for the existing
media-paste, compound text/SFX and canvas-story commands until those operations
have verified canonical replacements; these remaining paths are not marked migrated.

Evidence:
- Three native insertion cases pass across all seven clip types, whole-batch
  failure/ID rollback, scope/revision/cancellation, dry run/retry/history, live
  graphic discovery and first-media settings. Fresh WASM builds pass; final build
  1m52s, 39 legacy/35 canonical exports verified. One formatting invocation used
  a repository-relative path from classic/ and failed; the correct root formatting
  and subsequent final build/test passed.
- Real-WASM parity matches the production legacy command in 12 modes, including
  all clip types, explicit/automatic placement, first video/image, main anchoring,
  new-track insertion indices and malformed old order. The comparison accounts
  for fresh identities and timestamps, and independently recomputes the derived
  duration cache. Report: `.local/classic-web-tests/1791249995890/summary.json`.
- UI/direct TimelineManager, batch UI and discovered agent produce matching
  projects; invalid tail rollback, selection, single Undo/Redo and reopened
  history pass. The final combined matrix passes 71 tests in five isolated suites,
  including all 53 command-manager cases plus insertion parity, OAuth return,
  account and OAuth regressions, zero failures/skips (273.2s):
  `.local/classic-web-tests/1791250236816/summary.json`.
- Production TypeScript and insertion-file ESLint pass. The broader lint request
  including existing account/auth files reports their pre-existing positional
  API/control-regex/type-assertion diagnostics; no whole-tree lint pass is claimed.
  Test-inclusive TypeScript's previously recorded 96 diagnostics remain open.
- Seventeen scanner cases and compiled-registry gate pass: 1,010 production
  sources, 19 legacy classes, 121 remaining generic/legacy call sites, 383 manager
  methods, 33 actions, 1,217 JSX event sites. These remain static candidates,
  not verified full editor coverage.

The full original goal remains active. Remaining creation/compound paths,
movement, splitting, generic updates, paste, transitions, Ripple and media
operations still need migration/acceptance; live new-provider inference,
durable conversations/artifacts, full UI control, the 150 verified HyperFrames
packages, packaged Electron and hosted two-account acceptance remain required.

## 2026-10-06 Shared Rust caption cue policy for the remaining editing migration

The next movement/split migration requires generated transcript synchronization
and caption reconstruction, not merely changing clip coordinates. Moved the
existing cue row/timing and overlap-layer allocation policies, and legacy layout
settings normalization, into `classic/rust/crates/timeline/src/caption_layout.rs`.
The production TS functions now adapt JSON/indices to the shared Rust exports;
returned cues retain the original word objects and extension fields. Non-finite
UI preferences are transported as invalid-value markers so Rust applies the
same legacy clamps instead of JSON null defaults. The old policies are frozen
in an excluded comparison fixture; no production JS policy fallback was added.
This removes 297 lines from the production layout helper. Segment expansion,
placement geometry, platform font measurement and caption text rebuilding are
still separate remaining work; full movement/splitting is not claimed complete.

Added `caption.classic.cues.read` to the live registry, with explicit project,
scene, source track and revision, read access, cancellation and bounded paging.
It excludes manually owned words and retains original source indices/metadata.
The same Rust cue planner serves UI and registry; no extra model/MCP tool table
was added. Migration contract: **shared Rust cue/layout policy and canonical
caption read projection**, a prerequisite for complete editing contracts.

Evidence so far:
- Two timeline policy cases and two native editor-api cue cases pass. The native
  editor-api regression matrix passes 17 cases across cue read, insertion and
  keyframes. The 20 editor-api library cases also passed during this increment.
- Final legacy/canonical WASM builds pass (1m49s/2m11s). Manifests verify 42 legacy
  and 35 canonical exports. A first nested-vector return was not supported by the
  raw wasm-bindgen ABI; returning a typed layer-plan wrapper fixed the binding.
- Four isolated web suites pass 44 tests, zero failures/skips, including frozen
  parity for eight settings modes and eight layer counts, actual-WASM UI/registry
  equality, caption source synchronization and insertion. Report:
  `.local/classic-web-tests/1791252541324/summary.json`.
- Production TypeScript and the compiled-registry architecture gate pass.
  The JSON host adapter has one justified assertion at the verified Rust result
  boundary; it does not duplicate field validation in a second policy store.
- The first complete web matrix ran all 259 suites: 1007 passing cases, seven
  failed suite initializations, 27 skips (319.8s), report
  `.local/classic-web-tests/1791252675449/summary.json`. Six initializations needed
  real-WASM loading or complete mocks after the newly shared policy dependency;
  the seventh exposed an older storage mock missing deserializeProject. Repaired
  fixtures use real Rust exports/deserialization, not new JS business replicas.
  All seven repaired suites then passed 124 tests, zero failures/skips:
  `.local/classic-web-tests/1791252895269/summary.json`. The fresh complete web
  matrix finished successfully: 259 suites, 1131 passing tests, zero failed
  suites/tests, 27 skips (288.7s), report
  `.local/classic-web-tests/1791253139530/summary.json`. This verifies the local
  web regression matrix; it does not establish full product acceptance.

The original development objective remains active. Provider sign-in still needs
the user's fresh completion on the actual browser host; no live inference,
complex agent edit/inspect/export, packaged Electron, SaaS account separation or
150-package HyperFrames acceptance has been inferred from these local checks.

## 2026-10-06 Shared generated-caption transcript synchronization

Moved generated-caption word matching, semantic-change detection, timed and
presentation-only edits, deletion/reordering and cue fallback into the shared
Rust `caption_sync.rs`. The production host now calls `planCaptionTranscriptSync`
and applies the returned original word indices and text/timing fields. It keeps
unknown metadata and unchanged object references; repeated words keep their
correct original indices even when user metadata collides with an internal key.
The canonical caption-removal helper reuses the same punctuation normalization.
ECMAScript whitespace, including BOM and excluding NEL, is explicitly matched.
The old generated-transcript policy is frozen under excluded test fixtures.
This removes 417 lines and adds 35 adapter lines in production source sync.

Migration contract: **shared Rust generated-transcript policy**. Scene/source
orchestration, full caption rebuilding and platform font measurements remain;
MoveElementCommand and split operations have not yet been replaced. This is
required work toward full migration, not evidence of completed movement/split.

Evidence:
- The timeline library passed 149 native cases, then the final four caption-sync
  cases passed after adding duplicate-index/metadata-collision coverage. The
  runs overlap. Nine native editor-api cases across removal, insertion,
  duplication and cue reads passed with the shared normalization.
- Both final WASM builds passed (3m13s legacy, 4m51s canonical including local
  build contention). Manifests verified 43 legacy and 35 canonical exports.
- Four actual-WASM web suites passed 34 tests, no failures/skips, including
  source sync, cue parity and removal parity:
  `.local/classic-web-tests/1791254645524/summary.json`.
  The final enriched parity fixture also passed, comparing 164 modes including
  unknown speaker/confidence fields and punctuation-hiding exclusions:
  `.local/classic-web-tests/1791254819659/summary.json`.
- Production TypeScript passed. Targeted ESLint reported zero errors and one
  existing reconciler boundary assertion warning. The static architecture gate
  passed with 1,010 sources, 19 legacy classes and 121 remaining mutation sites.
  The final gate against the compiled registry also passed with those counts.
- The new full web matrix encountered default Bun five-second setup/test
  timeouts while native/WASM builds were also running; it remains unverified.
  The client-agent suite passed unchanged on isolated retry (14 tests). Five
  affected suites passed 82 cases with a 30-second per-test deadline and one
  worker: `.local/classic-web-tests/1791254707142/summary.json`.
  HyperFrames preview-host passed three cases with the same settings:
  `.local/classic-web-tests/1791254777720/summary.json`.
  These separate retries are not a complete passing regression matrix.
  The isolated suite runner now accepts `--test-timeout` without changing its
  five-second default, and records concurrency, suite deadline and Bun deadline
  in each report. Assertions, cancellation checks and test bodies were retained.
  The first broad run finished with 261 suites, eight failed suites, 989 passed
  tests, eight timed-out tests and 28 skips (545.9s):
  `.local/classic-web-tests/1791254460916/summary.json`. The command-manager
  suite reached its 480-second outer deadline after 45 passing cases, before
  completing its remaining cases. A fresh complete run is now in progress
  after compilation finished, using two workers, a 900-second suite deadline
  and a 30-second Bun test deadline. A passing complete matrix is still pending.
  That fresh run subsequently finished successfully: 262 suites, 1,134 passing
  tests, zero failures and 28 skips (576.3s), report
  `.local/classic-web-tests/1791255030512/summary.json`. It is the broad regression
  baseline for that increment, not proof of later caption-presentation changes
  or full product acceptance.

The original development goal remains active, including complete canonical
editing, real-provider correction/export acceptance, durable conversation and
artifacts, full UI control, HyperFrames library and hosted/package acceptance.

## 2026-10-06 Shared Rust caption presentation and stable reconstruction identity

Moved reconstruction source selection, inherited cue styles, element/word
presentation merging and stable element/track identity assignment to shared
Rust `caption_presentation.rs`. Selection retains the old largest-overlap,
nearest-midpoint, source-order tie policy and the two-millisecond identity
tolerance. Measured generated content, responsive layout and positions remain
authoritative while source animations, effects, transitions, reveal settings,
word styling and preferred track ownership are retained. Production
`caption-tracks.ts` removes 350 policy lines and adds 66 adapter lines; the old
reconstruction policy is frozen in an excluded comparison fixture.

An initial serialized-value parity check passed, but the existing cache-identity
regression correctly failed because JSON cloned animation/effect objects. Rust
now emits an additional reference plan. A generic host adapter reattaches the
selected original objects using owned JSON pointers; selection/merging policy
remains in Rust. The reference plan also preserves unchanged generated metadata
and escapes extension keys containing slash/tilde. Native consistency checks
prove that reattaching these references does not alter the canonical JSON values.
The existing reference-identity test was retained, not weakened to value equality.

Migration contract: **shared Rust caption presentation/identity policy**.
Full generated-caption reconstruction still requires remaining source grouping,
word-run building, placement/wrapping policy and platform font measurement.
Canonical move/split capabilities and their complete UI migration remain open.

Evidence:
- Three native presentation cases pass, including preferred ownership, style
  selection, inherited metadata and escaped reference-plan consistency.
- Actual-WASM tests pass 32 cases in three isolated suites, including 96 complete
  reconstruction modes with measured/unmeasured font adapters, wide/narrow
  canvases, overlapping/repeated multilingual words, timing/content/deletion
  edits, edited-layer preservation and preferred identities:
  `.local/classic-web-tests/1791256059009/summary.json`.
- Both final WASM builds and manifests pass: 44 legacy/35 canonical exports
  (1m10s legacy, 4m06s canonical). An earlier TS check saw the newly added
  `invokeReadWithHost` caller before its generated binding was rebuilt; the
  production TS check passed once the current binding was generated. The
  presentation files also pass targeted ESLint with zero diagnostics.
- The final compiled-registry architecture check passes: 1,014 production
  sources, 19 legacy classes, 121 generic/legacy mutation sites, 386 manager
  methods, 33 actions and 1,228 JSX event candidates. Counts are candidates, not
  editor parity proof. The command-manager/HyperFrames-reference regression
  run completed with 54 passing cases and one timeout, no assertion failure,
  in two suites (882.5s):
  `.local/classic-web-tests/1791256392479/summary.json`. The command manager
  passed 52 of 53 cases; source-preflight cancellation/scope/revision/render
  rejection exceeded its explicit 60-second test limit. Its isolated retry
  retains that limit. A complete passing regression for this increment is
  therefore still pending; earlier broad success is not substituted for it.
  The isolated source-preflight case passed in 6.734s (20 assertions), retaining
  its original 60-second limit, using
  `bun test --preload ./test-support/real-wasm.ts --timeout=30000 --test-name-pattern='source preflight rejects cancellation' src/core/managers/__tests__/canonical-command-manager.test.ts`
  from `classic/apps/web`. The first direct retry omitted the suite's required
  real-WASM preload and failed initialization; the corrected retry above passed.
  This supplies the missing case evidence without claiming the failed full
  suite became a separate passing full run.

Live-product investigation now finds an encrypted new-agent connection file
in the existing account. This is existence evidence, not inference proof. The
user's Chrome project is guarded as open in another editor. Created a separate
acceptance project through the normal Projects UI at
`http://127.0.0.1:3100/editor/a399339b-b4ad-47b1-8bd6-d1fc4a190280` and retained its
Chrome tab (1698526438) for continued testing. Subsequent page observations hit
CDP timeouts; browser metadata confirms the created project URL. A direct
connection-status navigation was blocked by Chrome (ERR_BLOCKED_BY_CLIENT);
no security protection was disabled or bypassed. Asked whether the new editor
loads in the user's browser while independent development continues. Successful
provider inference and the full edit/inspect/correct/export loop remain unproven.

The full original goal remains active. No full commit, staging or deployment
was performed during this increment.

## 2026-10-06 HyperFrames reference catalog capture and first real-render pilot

The user explicitly assigned the end-to-end HyperFrames flow and verified
example library as the current focus. The complete original goal remains
active; this increment does not claim those deliverables complete.

Captured the official registry at upstream commit
`4c4b8574406cc566d28778a13f22c072d727a871` without changing the reference
checkout. `scripts/hyperframes/snapshot.mjs` rejects non-regular Git entries,
checks paths/identities, saves original registry source and license files under
`resources/hyperframes/upstream/<commit>`, and generates `catalog.json`.
The catalog contains all 394 IDs: 164 blocks, 222 components, eight examples.
`.gitattributes` preserves the original source bytes across Windows checkouts.
The integrity audit verifies 1,433 item files totaling 52,760,420 bytes.
Twenty-eight manifests reference absent declared assets (including the carousel
image sets and selected video/texture/font resources). These are recorded as
incomplete; no placeholder assets or successful verification flags were invented.
Root/item license files are retained; full asset-license review is still pending.

Added canonical read capabilities `hyperframes.examples.search` and
`hyperframes.examples.read`, using the pinned immutable catalog. Search returns
bounded summaries, kind filtering, paging, verification counts and explicit
`lexicalWithHebrewAliases` mode. English metadata and selected Hebrew lexical
aliases are supported; semantic embeddings and popularity ranking are not yet
implemented. Detail reads require the exact catalog generation and return file
hashes, provenance, dependencies, parameter metadata and review gaps, not source
bodies. No duplicated model/MCP tool list was added. All entries remain captured,
with zero fully verified packages and unreviewed prompts. On-demand source reads,
the Examples + Prompts page and canonical remix/import actions remain next work.

The new opt-in real-browser pilot uses the actual production render host,
canonical import, Undo/Redo and archive restore. Five entries pass:
`data-chart`, `lt-clean-bar`, `logo-outro`, `grain-overlay`, `vignette`.
Components receive an explicitly test-owned transparent demonstration wrapper;
original sources remain intact. Two actual frames per item were saved, including
alpha observations, with report at
`.local/hyperframes-examples-pilot/4c4b8574406cc566d28778a13f22c072d727a871/report.json`.
Three block frames were visually inspected. This is not full-sequence, frozen
external-dependency, audio, mixed-video export or final prompt/visual acceptance.
The renderer once timed out during browser closure and its existing forced
shutdown path completed; the pilot passed 47 assertions in 53.6 seconds.

Verification:
- Two native catalog cases pass (bounds, Hebrew aliases, immutable readback,
  stale/invalid IDs, cancellation, exact provenance and truthful zero verified).
- Sixteen existing HyperFrames import/package/library native cases pass.
- Canonical WASM builds successfully (5m26s). Required export verification now
  reports 43 legacy/35 canonical exports; the shared checkout also contains
  concurrent timeline work, so the legacy-export increase is not attributed to
  this catalog change.
- The new real-WASM browser catalog test passes:
  `.local/classic-web-tests/1791254565792/summary.json`.
- Source integrity audit and JS syntax checks pass. Browser-pilot ESLint passes.
- Compiled-registry architecture gate passes (1,010 production sources,
  19 legacy classes, 121 reviewed legacy/generic mutation sites).

Read-only Chrome inspection found that the current hyperframes.dev landing page
opens Studio and its Community view exposes user projects with view/remix counts.
No Popular sort or mapping from those community projects to the pinned registry
was verified. Popularity remains unknown rather than treating ordering or
unrelated community view counts as an official registry ranking. The first
browser creation timed out; inventory inspection and a fresh tab on the observed
Chrome instance recovered access. No account/login/Remix submission was performed.

Next: add bounded source delivery shared by agent and library UI; freeze and
resolve dependencies for a diverse 150-item candidate set (at least 50 blocks
and 50 components); author/review demonstration wrappers and missing prompts;
validate seek/transparency/import/reopen for each package; connect remix and
compositor inspection to agent workflows; finish overlay/standalone audio/export
acceptance and packaged/hosted delivery. None of the original completion gates
are reduced by the five-item pilot or 394-item source capture.

## 2026-10-06 Shared Rust caption text authoring and font-width adapter

Moved caption clip construction into shared Rust caption_text.rs: style
resolution, greedy wrapping, text/background bounds, grid/manual/margin
placement, punctuation, responsive source fields, readable word timing and line
assignment. It consumes the product's published defaults. The old 477-line
production policy is frozen in an excluded fixture; the UI adds 32 adapter
lines and only creates a canvas, supplies glyph widths and decodes the clip.
The separately typed WASM callback adapter owns no editing policy or state.

The native builder can replay a measured trace without host policy. Failed or
non-finite measurements reject without producing a clip; unavailable canvas
matches the old fallback. Full source/scene reconstruction and scoped preflight
still need connection before canonical move/split can be completed.

Evidence:
- Two native builder cases pass: measured trace replay, immutable input,
  manual/unmeasured fallback and bad-width rejection.
- Three actual-WASM suites pass 32 tests, zero failures/skips, including 432
  complete clip-parity modes, presentation and source-sync regressions:
  .local/classic-web-tests/1791258839836/summary.json.
- Final WASM builds pass (1m23s legacy, 4m52s canonical); manifests verify 45
  legacy/35 canonical exports. Production TS and targeted ESLint pass.
- Compiled-registry architecture gate passes: 1016 sources, 19 legacy classes,
  121 reviewed mutation sites, 386 manager methods, 33 actions and 1231 JSX
  candidates. These remain static candidates, not editor parity proof.
- A new complete regression run is active with two workers, 900-second suite
  and 30-second Bun deadlines. Its complete passing result remains pending.

The full goal stays active: complete canonical editing, real provider/UI
edit-inspect-export acceptance, durable conversation/media recovery, all
HyperFrames packages, and SaaS/packaged delivery. Shared checkout changes were
preserved; no full commit, staging or deployment was performed.

Browser follow-up: after resetting only the CUA binding, fresh inventory showed
that the Sales Chrome profile had moved from browser id 4 to id 3 (the retained
acceptance tab id remains 1698526438). Binding the same tab through the current
profile restored observations. The page still showed Opening your workspace,
with no captured console errors; real inference remains unverified. No browser,
project, server or protection was restarted/disabled for this recovery. The
existing dev-server handle 96930 remains live and loopback port 3100 is listening.
Its recent page/API responses include substantial latency, so further startup
investigation is still required. The optional user visibility question is pending.

The complete regression for caption text authoring finished successfully:
269 suites, 1141 passing tests, zero failed suites/tests, 30 skips (738.0s).
Report: .local/classic-web-tests/1791259351326/summary.json.
This is local regression evidence, not proof of live provider/export or hosted
product acceptance. The user has now suggested restarting the sluggish app;
the intended OpenCut/Codex target is being clarified before stopping a process.

2026-10-06: User clarified restart target as OpenCut. Stopped the existing
owned dev-server session 96930 with Ctrl-C; it terminated, and port 3100 was
verified free. Started the same webpack/loopback dev command from classic/apps/web
in PTY session 77879. Next reported Ready in 9.8s; listener is 127.0.0.1:3100
(process 58708). Reloaded the retained Chrome QA project; observations advanced
from Opening your workspace to Loading project with cold compilation visible.
No project/media deletion, cache deletion, credential change or browser restart
was performed. Full loaded-editor/provider acceptance is still pending.

Caption-scene work in progress: new shared Rust source grouping and full scene
rebuild module has two passing native cases. Corrected sourceId allocation to
be lazy when an existing ID is retained. It remains unexported/unconnected to UI
pending integration and parity tests; no completed move/split claim is made.

Restart verification: the account-service probe returned HTTP 200 in 106ms.
The retained QA project subsequently loaded its full editor UI: media/timeline,
preview, export control and the new editing-agent chat are visible. The chat
shows a connected account, Disconnect control and a populated model selector.
This verifies UI recovery and visible connection state, not a successful model
inference or export. The dev server remains live in session 77879. The standalone
MCP badge is unavailable; the development MCP runner has not been restarted.

## 2026-10-06 HyperFrames library and composed-export completion

Scope: the HyperFrames/reference-library work in the existing migration branch.
The complete editor-agent goal is not marked finished by this increment.

Implemented and verified:
- Canonical `hyperframes.examples.source.read` with project/revision/cancellation
  fences, full-file SHA-256 validation, bounded UTF-8 reads, Unicode pagination
  and exact prepared-file identities. Its authenticated Next host accepts only
  pinned bundle paths inside the owned project/account context.
- Editor asset-panel library with search, local preview frames, raw/prepared
  source viewing, truthful per-entry review state, reconstructed-prompt labels,
  remix-to-chat drafts and prepared import through the existing canonical import
  journal. Import freezes account/project/scene and cancels on a scope change.
- 150 ready reference packages: 50 blocks and 100 components, including their
  upstream demo wrappers. All have local dependency/license captures, offline
  renders, deterministic repeat seeks, canonical import/undo/redo/reopen evidence,
  source review, three sampled visual frames and a separately authored prompt.
  The four upstream original prompts remain unchanged in the wider 394-item
  captured catalog. Popularity is unknown, not invented. Nineteen prepared
  packages have transparency in sampled frames; the others include backgrounds.
- Three demos were excluded after visual review: matrix-decode never resolves
  its zeros; rgb-glitch-text has unreadable default contrast/scale; separator's
  showcase is too faint for the curated library. Raw source remains discoverable.
- `resources/hyperframes/certification.json` pins the reviewed generation and
  evidence. Acceptance checks require 150 entries, at least 50 of either kind,
  matching source/prompt/technical/frame hashes and shared compositor evidence.
  Regenerating technical candidates clears old verification labels. This is
  source-and-three-sampled-frame review by Codex, not full frame-by-frame human
  review or a guarantee that a reconstructed prompt reproduces identical pixels.
- Actual SceneExporter/WASM compositor/VP9 output combines a HyperFrames lower
  third above native video and during a standalone interval. A source remix adds
  audio at 0.4s through 1.3s, trimmed and played at 2x. Decoded output has silence
  before/after and measured audible signal during the intended window.
- Production packaging includes pinned sources and content-addressed local
  previews; source integrity is audited before packaging. The packaged HTTP
  check uses two isolated test accounts and never an existing user's account.

Evidence:
- Resumed 150-package technical batch passed, no skips:
  `.local/classic-web-tests/1791260735933/summary.json`;
  `.local/hyperframes-examples-batch/4c4b8574406cc566d28778a13f22c072d727a871/report.json`.
- Actual mixed video/audio export passed:
  `.local/classic-web-tests/1791259681430/summary.json` and committed reference
  evidence under `resources/hyperframes/evidence/composed-export/`.
- All three audio-plan browser/FFmpeg tests passed with the pinned GSAP fixture,
  no skips: `.local/classic-web-tests/1791261174117/summary.json`.
- Five native reference catalog/source tests passed. Four actual-WASM source,
  catalog and import tests passed in `1791261335358`; the UI test in that run
  exposed a test-input selection issue (triple-click retained a search fragment).
  Explicit select-all and waiting for the excluded entry fixed the fixture;
  the real-browser UI test passed in `1791261430917`, including all local images.
- `node --test scripts/hyperframes/audit.test.mjs` passed, proving rejection of
  changed prepared source, changed prompt and mismatched certification counts.
  Its first cold-copy run hit a 120-second filesystem deadline; the isolated
  fixture passed with a 300-second deadline (134.8 seconds).
- Canonical WASM rebuilt successfully; manifests checked 47 legacy and 35
  canonical required exports. Production tsconfig.build.json passed. Unscoped
  tsc includes existing Bun test fixtures and is not a valid production check.
- Targeted ESLint and diff whitespace checks passed. Compiled-runtime architecture
  gate passed: 1016 production files, 19 legacy classes, 121 mutation sites,
  386 manager methods, 33 actions, 1231 JSX candidates; not a parity claim.

Remaining release/product gates outside this library certification:
- The dedicated embedding/semantic index is not implemented. Retrieval explicitly
  reports its local lexical fallback, searches reviewed prompt text as well as
  metadata and supports Hebrew aliases. The agent's capability guidance asks it
  to interpret the request and search concise English visual concepts.
- Full Electron-shell and deployed HTTPS SaaS acceptance, live-model autonomous
  remix acceptance and the broader editor-agent goals remain separate gates.
- The current final Next production build/150-preview packaged-account check is
  in progress; append its actual result below before claiming packaged delivery.

No broad staging, commit, cleanup, deployment or rollback of shared changes.
Refresh/reproduction steps are in `resources/hyperframes/README.md`.

Final packaged-library follow-up:
- Next production build completed successfully, including production TypeScript
  and all 38 prerendered pages. Log: `.local/hyperframes-final-build.log`.
- A concurrent legacy WASM build removed its package manifest during Next tracing.
  The generated manifest was restored in the isolated standalone artifact before
  testing. The existing Windows path-casing/async-WASM warnings remain; they were
  not treated as functional success evidence.
- The actual standalone HTTP check passed against the final 150-item bundle:
  `.local/hyperframes-packaged/8efeedd8-fbc1-4b68-8879-0a0b8d7d9361/report.json`.
  All prepared resources passed the full integrity/certification audit; all 150
  midpoint preview URLs returned the exact pinned PNG bytes. Authenticated source
  pagination matched its digest; anonymous, foreign-project, stale-account and
  stale-file-hash requests were rejected. Its temporary server was stopped.
- This closes the packaged library/server delivery check. It does not close the
  Electron-shell, deployed HTTPS SaaS or live-model remix gates listed above.

## 2026-10-06 Shared Rust caption scene rebuilding and live ownership regression

Caption source grouping, edited-layer detection, generated-track creation,
sourceId allocation, cue/style/text construction and stable reconstruction now
run in shared caption_scene.rs. The browser only supplies product defaults,
glyph widths, UUIDs and generic reference reattachment. Canonical caption
removal reuses the same source grouping. Native no-source/error paths preserve
input; allocation of an existing sourceId was corrected to be lazy.

The existing full reconstruction parity fixture now exercises 192 modes,
including stable source IDs and legacy span-grouped sources, against the frozen
old implementation. Initial 96-mode regression and 29 source-sync cases passed;
the expanded fixture passed after the final legacy WASM build. Six native
removal/duplication/cue cases passed with the shared grouping. Final builds
verified 47 legacy/35 canonical exports (1m31s legacy, 4m16s canonical).
Production TS passed; caption adapter ESLint passed. Full canonical move/split
contracts and scoped asynchronous metric preflight remain unfinished.

Live Chrome takeover exposed No active scene in a preview selector during
clear/restore. EditorProvider now displays a loading view and blocks keybindings
through the replacement; scene-dependent external-store selectors retain their
last memoized view during loading and resume on project notification. A targeted
regression drives the actual hook's synchronous store notifications through the
empty-scene gap, and browser takeover subsequently completed without crashing.

A second race was found: takeover bypassed loadProject's single-flight guard.
Takeover and route loading now use that same guarded path, and the lifecycle
fixture requests both concurrently and expects exactly one acquisition. Its
first run hit a separately changed HyperFrames capability's stale WASM output
schema during runtime construction; the source already contains the object-root
fix, so the canonical binary is being regenerated before rerunning the fixture.

The real connected model was sent a four-second Hebrew/English title and fade
request through normal chat controls in the dedicated QA project. The persisted
checkpoint confirms five provider response IDs and five empty output groups,
then the intended empty-round pause; no editing receipts were recorded and the
project remains empty. This proves requests reached the provider response path,
not successful tool use, visual review or export. Added development-only SSE
shape counts (item/delta counts only, no prompt/output/token/reasoning logging)
to determine whether terminal output is sparse or the model returns no actions.
Resume investigation is still pending; do not label this live acceptance passed.

Scoped checks: ownership selector + lifecycle + caption rebuild comparison
passed three tests in .local/classic-web-tests/1791262117064/summary.json;
source sync + ownership selector + expanded scene comparison passed 31 tests in
.local/classic-web-tests/1791262308682/summary.json; stream and ownership-selector
checks passed four cases in .local/classic-web-tests/1791262807197/summary.json.
These scopes overlap. No whole product completion claim or full commit is made.


## 2026-10-06 Shared Rust scene transcript synchronization

The generated-caption source synchronization adapter now delegates source-track
selection, ordered update matching, previous-element lookup and word edits to
shared `sync_caption_scene_transcript` in timeline/caption_sync.rs. The browser
reapplies the source-index plan to preserve extension fields and unchanged word
references, then uses the existing shared scene reconstruction and platform
measurement callback. Unrelated caption sources and tracks remain untouched.
This is preparation for full canonical move/split contracts; their legacy
commands, manual-word transition orchestration and scoped async font preflight
are still unfinished. No whole-family migration claim is made.

Evidence for this increment:
- Five native caption_sync tests passed, including source isolation, ordered
  multi-track edits, metadata/index-marker collision preservation and no-source
  behavior.
- Both WASM packages rebuilt successfully. Export verification now checks 48
  legacy and 35 canonical required exports.
- Three real-WASM Web suites passed 34 cases without skips:
  `.local/classic-web-tests/1791264716885/summary.json`. Parity fixtures cover
  164 single-element modes, 16 ordered multi-track modes, 192 reconstruction
  modes and 12 integrated sync/reconstruction modes with platform-width/no-
  measurement paths. These modes are inside cases, not additional test totals.
  The frozen sync fixture uses the separately verified shared reconstruction;
  it is not a completely independent editor implementation.
- Production TypeScript passed after the rebuild. Targeted lint completed with
  no errors; one existing native reconciliation assertion warning remains after
  removing an unused import. The static architecture gate passed (1017 sources,
  19 legacy classes, 121 mutation sites). Compiled-registry follow-up is pending.
- The takeover single-flight regression from the prior increment finished:
  lifecycle + ownership selector + stream suites passed five cases in
  `.local/classic-web-tests/1791263800817/summary.json`; its production TS and
  targeted lint invocation also exited successfully.

The user-requested OpenCut restart stopped owned server session 77879, verified
port 3100 free and started the same loopback webpack command in session 76628.
Next reported Ready in 3.0s; the anonymous account-service availability check
returned HTTP 200 in 5.50s. This is server recovery evidence only.
Chrome inventory retains QA project a399339b-b4ad-47b1-8bd6-d1fc4a190280 in tab
1698526466, but repeated documented CDP focus requests time out. An optional
user refresh/visibility question is pending. No credential inspection, browser
protection bypass, ownership takeover of the user's original project or new
inference was performed in this increment. Live model editing/inspection/export
acceptance remains unproven, and the full development goal remains active.

Follow-up: compiled-registry architecture gate passed with the same reviewed
boundaries. Final adapter lint has zero errors and one existing unsafe native
reconciliation assertion warning; production TypeScript and all targeted tests
are terminal and passing. No full regression or live acceptance claim is made.

## 2026-10-06 HyperFrames autonomous live acceptance — in progress

Implemented canonical registry capabilities `hyperframes.examples.import`,
`hyperframes.composition.remix`, `editor.preview.render`, and
`editor.export.render`, with host renderer IO, pinned-reference verification,
revision/cancellation checks, bounded ArtifactStore results and chat downloads.
Source edits use existing canonical prepare/set operations and undo; UI host
code does not independently mutate project content. Native authoring integration
and web host tests passed. Full live acceptance is still in progress.

A real signed-in GPT-6-Astra run in isolated project
`11e2f14a-ace0-42fe-9f70-a2c4a90c8d7a` initially paused after five empty rounds.
The actual transport sends completed items separately from a sparse terminal
response. stream.ts now retains only output_item.done items, deduplicates the
terminal output, and still rejects disconnected/failed/incomplete streams.
After this correction, the live model planned the task, discovered/read
contracts and the lt-clean-bar source, and changed the project to 10 fps.
It then exposed an autosave revision race before review. Atomic save no longer
reassigns project metadata as a new edit; the lifecycle regression confirms
that saving preserves the canonical archive and pending review revision.

Evidence so far: web stream + render host 9 cases passed in
`.local/classic-web-tests/1791265121754/summary.json`; real-WASM project lifecycle
regression passed in `.local/classic-web-tests/1791265314768/summary.json`.
Native lifetime test exposed older strong registry captures in discovery,
observation and job handlers; those now upgrade weak references during
invocation, with revalidation/build pending. No live export proof yet.


## 2026-10-06 User-requested current-state brief before further development

This audit supersedes older pending labels where newer evidence exists. No
product-code changes or WASM rebuild were made during the audit.

- Classic movement/splitting ALREADY exist in TimelineManager and the legacy
  MoveElementCommand/SplitElementsCommand; the experimental AI edit-plan path
  invokes them too. CommandManager bridges their state and history into the
  canonical session. The missing work is migration of their business policy and
  dedicated Classic registry contracts for the new agent, not recreating these
  editor features. The compiled registry's timeline.item.move/split are explicitly
  rewrite-only. HyperFrames layer movement is a separate implemented Classic
  capability and must not be counted as generic clip movement.
- Compiled WASM registry read directly: 142 descriptors, 41 Classic-only,
  47 shared and 54 rewrite-only. Descriptor counts are not feature/button parity.
  Classic insertion, duplication, removal, scenes, bookmarks, settings, track
  layout/control, source audio, effects, masks and keyframes have dedicated
  contracts; legacy compound paths still exist.
- Interrupted removal import/export and reopen/history fixes are present. Only
  the test uses legacy-remove-track-fixture; ordinary removal routes through
  timeline.classic.remove. Do not restart that completed repair.
- HyperFrames library acceptance was re-audited from current pinned bytes with
  node scripts/hyperframes/audit.mjs --acceptance: PASSED. 150 verified packages
  (50 blocks/100 components), 1433 checked source files, 32 vendor files, four
  original prompts in the wider 394-item capture. Twenty-eight incompletely
  declared raw captures are not part of the certified 150. Certification is
  source plus three sampled visual frames, not every animation frame. Existing
  composed-export evidence verifies native-video underlay, standalone interval
  and timed audio in WebM; standalone packaged HTTP report checks 150 previews
  and account authorization. Neither report launches the full Electron shell or
  establishes a live-agent/HTTPS SaaS acceptance loop. Semantic embeddings remain
  unimplemented; lexical/prompt search and Hebrew aliases already exist.
- Current overlay keeps conversation entries in React state. Atomic session
  persistence stores canonical archive and run checkpoint; it does not restore
  the entire visible conversation, attachments and binary artifacts.
- Current streaming source includes output_item.done reconciliation and six
  targeted stream tests passed during this audit (report 1791265310130). This is
  local transport evidence, not a newly verified live-provider edit/export.
  Earlier real QA recorded five responses and no editing receipts; live acceptance
  is still unresolved. Other work is changing the shared checkout, so do not
  infer current status solely from this chat's earlier narration.
- Account/filesystem storage, owner leases and media/font write fences exist.
  deleteProject still directly removes the project directory without the service
  editor lease guard. Local project duplication already exists with media/font
  copying; independent closure of all source/artifact dependencies needs evidence.
  Full PostgreSQL/private-S3/authenticated-WSS/HTTPS deployment and two-user
  acceptance have not been demonstrated.

IMPORTANT CURRENT BUILD GAP: immediately before the user requested this audit,
manual caption ownership replacement was moved into shared Rust and passed six
native caption_sync tests. Its new planCaptionManualWordReplacement import and
32-mode Web fixture have NOT been built/tested against WASM yet. Read-only audit
confirmed export verification FAILS for this missing export and production tsc
FAILS with TS2305 in caption-source-sync.ts. The previous green 34-case report
1791264716885 and 269-suite/1141-case report 1791259351326 predate this latest
change and cannot certify the present worktree. No new build/repair was performed
because the user asked for a brief before more development.

Remaining product work: close this open build increment first; finish dedicated
Classic editing contracts and coverage/enforcement (including move/split/general
updates/paste/merge/transitions/Ripple/background-removal/Parallax/import); prove
real-provider edit/readback/render/correction/export; durable conversation,
attachments, explicit image provider and full artifact/lifecycle recovery;
complete semantic-control coverage, long Hebrew/English runs and HyperFrames
live-agent remix; hosted storage/account isolation and full packaged Electron/
browser/SaaS acceptance. Keep the complete original goal intact. Do not use
existing local capability infrastructure or this brief as completion evidence.

The registry lifetime correction is now verified: all 21 editor-api unit tests
and all three hyperframes_authoring integration tests pass. Both WASM packages
were rebuilt; export verification passed with 49 legacy/35 canonical exports.
The additional legacy export was added by concurrent caption work, not by this
HyperFrames increment. Targeted stream/render/client/overlay and project-save
lint passed; no live export claim is made before the next acceptance run.

The live import reached the real HyperFrames renderer but its post-commit save
was rejected by checkpoint fingerprint validation. A new real-WASM test
reproduced the cause without network/model IO: generic composition properties
serialize integral Rust doubles as 30.0, while the browser JSON archive carries
30. Checkpoint hashing now normalizes exactly representable integral doubles;
legacy hashes remain accepted when otherwise matching. Changed fractions,
strings and distinct large integers remain distinct. Native fingerprint,
checkpoint recovery (2) and atomic session-store (5) tests passed. The new web
HyperFrames archive round-trip also passed after the rebuild. Full live
acceptance is still pending resumed testing, not marked complete.

Autonomous-run follow-up: the model repeatedly re-reviewed unchanged visuals
while navigating large state. Review cache now follows document revision plus
committed edit/evidence receipts instead of the tool epoch; successful and
rejected reads do not trigger another identical review. In-flight stale review
responses still fail the epoch/revision fence. The targeted runtime regression
passed. Oversized app.state.read replies now include a bounded structural map
with exact escaped JSON pointers, never source contents. Remix's contract also
names its canonical composition/source location.

Export now demuxes the actual produced buffer with Mediabunny and reports video
duration, dimensions, average packet/frame rate, packet count, codec and track
counts. Rust requires valid scope-bound inspection, rejects audio in a silent
export, and stores a linked inspection artifact for host review. This is
container evidence, not exhaustive perceptual QA. Review separates that evidence
from sampled visual assessment and does not block applied work on unperformed
future plan steps. Real-WebM inspection + host tests: five cases passed in
`.local/classic-web-tests/1791267183320/summary.json`. Native authoring tests
passed again with required export-inspection output. Fresh live acceptance is
still pending; the earlier debug project remains paused with its source import.


## 2026-10-06 Accepted build closure and unified feature coverage

Scope now follows the user's four-item continuation: finish the open WASM build,
maintain one UI/agent/test/gap map, complete missing editing contracts, prove a
real complex edit/read/render/correct/export loop, and complete conversation,
attachments, explicit image provider and recovery. No whole-goal completion.

Build closure:
- Both WASM packages rebuilt; 49 legacy/35 canonical exports verified, including
  planCaptionManualWordReplacement. Production tsconfig.build.json passed.
- Four Web suites passed 41 cases with no skips in
  `.local/classic-web-tests/1791265945381/summary.json`: generated/manual caption
  synchronization, measured scene reconstruction and provider SSE transport.
  The newly added manual ownership comparison covers 32 modes inside one case.
- Actual CommandManager integration passed 53 cases in
  `.local/classic-web-tests/1791267278281/summary.json` (155.5 seconds). The first
  concurrent-production-build attempt reached its 180-second suite deadline;
  it was terminal, with no reported assertion failure. The isolated rerun passed.
  Four legacy track-order/split cases passed in the earlier 1791266928115 report;
  that earlier report has a failed suite and must not be called wholly green.
- Next production build completed in isolated .next-agent-verify, including all
  38 generated pages. Log: `.local/editor-agent-web-build.log`. Existing casing
  and async-WASM warnings remain. Tracing missed the canonical WASM package
  manifest; restored its exact current bytes ONLY inside the standalone artifact.
- Started that actual standalone server on loopback 3111 with an isolated empty
  account directory. Anonymous accounts returned 200; agent connection returned
  401. Report: `.local/editor-agent-standalone-smoke.json`. Stopped the owned
  temporary server and verified the port no longer listens. This smoke test does
  not certify an authenticated editor, rendering, real provider or export.

Unified map:
- `EDITOR-FEATURE-COVERAGE.md` is generated from the reviewed
  classic/scripts/editor-architecture/feature-coverage.json, AST inventory and
  actual compiled capability registry. Detailed report:
  `.local/editor-architecture/feature-coverage.json`.
- It maps 31 families and all 33 declared actions; retains all 387 manager methods,
  1231 JSX candidates, 19 legacy classes and 121 mutation sites, each with mapped
  evidence or an explicit unreviewed gap. Source/test hashes and compiled WASM
  identity are recorded. File references and AST edges are not parity proof;
  testsStatus=definedOnly intentionally distinguishes test existence from a run.
- `bun run architecture:coverage` regenerates the map. The existing compiled
  architecture gate (--with-runtime) now validates/regenerates it without a
  second AST scan. Missing references, rewrite-only Classic mappings and new
  unmapped declared actions fail the gate. New unreviewed UI candidates remain
  visible; they are not silently marked covered.
- Twenty architecture/mapping tests passed, including three mapping cases.
  Targeted script lint and tracked-file whitespace checks passed. Actual combined
  compiled-registry gate passed with zero broken map references.
- No dedicated Classic move/split contract has been invented or claimed complete
  by this mapping. Existing UI/experimental-agent functionality is retained.

Real-provider acceptance is still pending. The selected Chrome has the user's
original project open; did not take over or edit it. Opening the separate retained
QA project timed out in the documented browser control API. This is not evidence
of a completed inference or of the browser process terminating. No credentials
were inspected, protections disabled or development server restarted for this.
Next required product work remains dedicated missing editing contracts and the
complete live scenario plus durable conversation/attachments/images/recovery.

2026-10-06 live HyperFrames acceptance (supersedes the pending-live-run notes above):
Two fresh empty projects completed through the actual signed-in GPT-6-Astra chat,
33 provider rounds each, with no follow-up steering or manual editing:
- 672a9e73-d3d2-4974-b396-19922b69cae9 (port 3127).
- 3a8c4eac-785b-4538-96d9-6fb6c1c20687 (port 3128, includes exported-video player).
Both saved checkpoints are completed with all plan steps complete and ordered
committed import -> preview -> remix -> preview -> export receipts. The final
export revision equals the final document revision. Exact source comparison
verified only the two requested text substitutions and #ff5a36 -> #7c3aed; the
original animation and other source files are unchanged. Host demuxing of each
actual output reports WebM/VP9, 1920x1080, 4.8 seconds, 10fps, 48 packets,
one video track and zero audio tracks. The second video (63,904 bytes, SHA-256
c02ce1180485e46b56a6fff15ddd5734701bac8eedb362f3fc3d91d1f640f9cd) was also
played in the exported-video chat player; the updated lower third was visible.
The model found no further mismatch after Remix, so these runs do not demonstrate
an additional self-detected visual defect and second corrective Remix.

Evidence is intentionally split by verification scope:
`.local/hyperframes-live-evidence/first-live-run/host-report.json`,
`.local/hyperframes-live-evidence/final-live-run/host-report.json`,
`final-live-run/browser-observation.json` and `final-live-run/chat-export.jpg`.
`scripts/hyperframes/check-live-run.mjs` verifies either saved host evidence
(--host-only, explicitly incomplete external verification) or a downloaded file
with SHA agreement, ffprobe and full ffmpeg decode. Both host-only checks passed.
Browser tooling timed out obtaining Blob downloads, so the downloaded-byte/
external-decode mode has NOT passed. Do not describe this as ffmpeg-certified.
The player and real Download video card are live in the retained port-3128 tab;
artifact recovery after reload and packaged Electron/HTTPS SaaS are not certified.

The player production build passed (log `.local/hyperframes-live-preview-build.log`).
Overlay lint passed for the player. A subsequent small Markdown presentation fix
renders sanitized/empty URLs as text instead of links back to the current editor;
the actual host-owned Download video card remains the download affordance.
No model, renderer or canonical-state changes were made after the two successful
live runs. Broader editor-agent and migration goals remain separate work.


## 2026-10-06 Dedicated Classic clip controls

Added timeline.classic.elements.controls with typed schemas, Classic support,
Write access, Immediate execution, revisions, cancellation, dry run, exact
registry retries, atomic history and automatic MCP projection. Rust owns group
set/toggle policy, supported types, target validation and reference deduplication.
Visibility targets video/image/text/sticker/graphic; mute targets video/audio and
writes params.muted. Other types are reported skipped. Timing, gain, source-audio
bindings, captions and extension fields are preserved. Invalid scalar legacy
params are rejected before a JSON indexing panic can poison the state lock.

Selected mute/visibility gestures now invoke this same capability through
CommandManager/CanonicalClassicSession; frontend group-decision loops were
removed. Existing Ripple/reactors remain in the surrounding transaction. General
inspector patches, full update/move/split contracts and independent Ripple remain
separate gaps; this increment does not complete the whole clip-update family.

Evidence:
- Four native integration cases pass: mixed set/toggle, deduplication, preview,
  retry, undo/redo, stale/foreign/missing targets, cancellation, audio visibility
  skipping, gain/timing retention and invalid scalar params without state loss.
- Final canonical WASM rebuild passed; 49 legacy/35 canonical required exports
  verified. Production TypeScript and targeted source/test lint passed.
- Focused real-WASM integration passes (.local/clip-controls-wasm-test.log): one
  case, 53 other cases filtered out, 28 assertions. Both gestures match agent
  discovery/description/invocation and state readback, preserve selection, restore
  persisted reopened undo and roll back compound failures. No real provider is
  used by this case.
- Whole manager run 1791269383995 passed 53 existing cases and failed the new
  fixture because its agent lacked the mandatory editing plan. Added that plan
  and reran the focused case. Do not call the earlier whole report green or
  present the focused rerun as a fresh full 54-case run.
- Compiled architecture/mapping gate passes: 32 families, 33 actions, 1018 source
  files, 388 manager methods, 19 legacy classes, 121 reviewed mutation sites and
  1231 JSX candidates; no broken references. These are not UI parity percentages.

A documentation append failed when C: reached zero free bytes. Automatic approval
review rejected removing the owned verification-build cache (blocked by policy);
non-destructive NTFS compression also freed no space. Later a read-only probe
confirmed ~3GB free. No removal was executed; the cleanup approval is no longer
needed. Code and test evidence were retained and this append now succeeded.

Concurrent evidence now proves two actual GPT-6-Astra HyperFrames import/preview/
remix/preview/export runs; preserve their separately documented scope above.
Those baseline runs do not demonstrate a self-detected visual defect followed by
another correction, external downloaded-byte decode or durable artifacts after
reload. Do not repeat obsolete claims that no live provider run exists.

The full four-item goal remains active: finish missing editing contracts, prove
the complete complex correction/export scenario, and implement conversation,
attachments, explicitly chosen image provider and full recovery. No user project,
credentials, deployment or broad commit was modified by this controls increment.


## 2026-10-06 Native public conversation persistence

ConversationArchive/ConversationEvent in editor-agent owns public message,
summary, activity and status ordering, identities, quota checks and interrupted
round recovery. This is agent presentation data, not a second editable project.
The existing CanonicalEditorRuntime owns this companion state; React now projects
its entries and only caches transient Blob URLs for rendering. Provider hidden
reasoning event types are absent from the protocol. Archive metadata retains
artifact IDs/filenames, never Blob URLs or arbitrary paths.

SessionBundle now atomically includes an optional scoped conversation alongside
canonical archive and run checkpoint. Old bundles without it remain valid. Rust
validates account/project before accepting a save. Canonical restore and saved-
project rename retain the archive. Reopened unfinished rounds are interrupted,
not replayed as editor actions; completed runs close their display round. Changes
do not enter editor undo history or alter the project revision. Client event
ordering records activities/review/final status before the relevant atomic save.

Evidence:
- Two native conversation unit cases pass for public roundtrip, interrupted
  recovery, foreign scope, rejected hidden-event kinds and quota rollback.
- Native checkpoint (2) and session-store (6) integration cases pass, including
  paired conversation restoration and atomic rejection of a foreign account.
- Final WASM build and exports pass (49 legacy/38 canonical), production TS
  passes, targeted source lint and compiled architecture gate pass.
- Nine host/checkpoint/render cases pass in 1791272329071/summary.json.
- Four focused real-WASM manager cases pass (47 assertions): new public message/
  summary save/reopen without editor-state/history changes, streamed provider
  loop, rapid steering and uncertain host reconciliation. The new fixture first
  lacked the mandatory persistence adapter on restore; it was fixed and rerun.
  These are focused cases, not a fresh entire manager-suite result.

Still incomplete: binary artifact persistence/rehydration, attachments, explicit
image-provider selection/generation, full browser lifecycle acceptance and the
remaining editing contracts. Export references currently restore as unavailable
for download after reopening when no transient Blob exists; do not claim full
conversation/media recovery. The complete four-item goal remains active.

### 2026-10-06 — Live correction acceptance hardening (in progress)

The 896f3ab1-e561-4147-a5bf-9d81f72e6755 stress run performed two actual Remix
passes, observed the oversized title clipping, corrected it and exported a
1920x1080, 4.8-second, 10fps silent VP9 WebM. However it did NOT complete:
the separate reviewer could not see source evidence omitted from compact state,
so repeated completion was correctly refused. This run was manually stopped;
do not count it as a completed autonomous acceptance.

Fixed reviewer evidence delivery in crates/editor-agent: bounded complete paired
successful HyperFrames calls/source reads are now supplied alongside rendered
frames, including recorded historical revisions. Provider prose/reasoning and
failed results are excluded. Identical source reads are deduplicated; distinct
source evidence changes the review cache key, while ordinary reads still do not
trigger repeated paid reviews. Missing source evidence is not silently waived.
The bounded-evidence unit case and existing stale/current-render runtime case
pass. Canonical WASM rebuild and production build pass; manifests verified
49 legacy and 38 current canonical exports (the latter includes concurrent work).
Build logs: .local/hyperframes-source-evidence-wasm.log and
.local/hyperframes-source-evidence-build.log.

Also added bounded automatic provider transport recovery (at most two retries),
never executing a partial streamed tool call. Auth/protocol/provider failures,
abort and changed account/project do not retry. Fifteen targeted web tests pass:
.local/classic-web-tests/1791271465601/summary.json. The export card now has a
native video player and real host-owned Download video link. Sanitized empty
Markdown links render as text instead of navigating to the current editor.

Environment recovery: C: became full. Deletion of owned inactive build/cache
was rejected by automatic approval review, so no deletion workaround was used.
The inactive build was preserved by reversible move to
E:/OpenCut-build-backups/hyperframes-live-20261006. Package links were subsequently
repaired with bun install --frozen-lockfile; the production rebuild and focused
tests passed afterwards. No user project was removed. The latest observed C:
free space is about 20GB.

A fresh single-prompt GPT-6-Astra correction acceptance now runs in project
f44f2332-2c80-4c38-a9be-dfe8e9e03458 on the rebuilt local 3128 server. Its outcome
must be recorded below before claiming completion. The prior two baseline
completed runs remain valid but do not establish this second-correction case.
Browser Blob download collection still times out; independent downloaded-byte
SHA/ffmpeg decode has NOT passed. Do not label host inspection as external decode.

### 2026-10-06 — Live request / Remix / correction / export acceptance completed

Fresh project f44f2332-2c80-4c38-a9be-dfe8e9e03458 completed with GPT-6-Astra
selected in the live app: 33 provider rounds, one prompt, zero steering, zero
manual resumes. All plan steps are complete. The actual run imported lt-clean-bar,
applied the deliberately oversized 180px draft, rendered and identified clipping,
applied a second Remix to 52px, rendered the corrected revision and exported.
The host acceptance verifier passes the ordered committed receipts, historical
180px source, corrected source, preserved original animation scripts, an initial
review with clipping issues, a later clean review and final export revision.

Actual export: VP9 WebM, 132749 bytes, 1920x1080, 4.8 seconds, 10fps, 48 video
packets, no audio track. SHA-256 recorded by host:
58727761803328488580c963d0cb0345c97525e80552adff64314280691bb751.
Browser media loaded with readyState 4 and matching dimensions/duration, sought to
2.4 seconds and advanced to the end when played. Native player, Export ready,
Download video and the completed chat message were observed. No additional edit
was supplied during this run. The result tab is retained at
http://127.0.0.1:3128/editor/f44f2332-2c80-4c38-a9be-dfe8e9e03458.

Evidence: .local/hyperframes-live-evidence/correction-live-run/host-report.json,
browser-observation.json and chat-export.png. The screenshot records the editor
and export card; it does not prove exported pixels. The verifier is reproducible
with scripts/hyperframes/check-live-run.mjs and the correction profile. Its status
explicitly remains liveRunCompleted_externalFileVerificationPending: browser
Blob download collection timed out, so external downloaded-byte SHA/ffmpeg decode
is not claimed. Direct Blob navigation was blocked by browser URL policy; no
workaround was attempted. Packaged Electron, deployed SaaS, durable artifact
recovery after reload and general editing parity are not certified by this run.

Final validation: all 34 opencut-editor-agent tests pass in
.local/hyperframes-source-evidence-agent-tests.log; the 15 targeted browser-host,
stream, transport and video-inspection tests remain green. Canonical WASM and the
final production build pass. This closes the scoped live autonomous
request-to-Remix-to-visual-correction-to-export scenario, while preserving the
explicit external-file verification and broader product limitations above.


## 2026-10-06 Scoped binary artifact recovery

ArtifactStore can archive/restore selected IDs with exact metadata, Base64 bytes,
size/digest validation, duplicate/conflict checks and all-before-mutation import.
Pinned referenced outputs survive cache expiry/eviction; exceeding the bounded
store remains an explicit error. Restored IDs stay stable and new allocation
avoids collisions. No arbitrary temporary path is used to retrieve output.

SessionBundle now carries an optional account/project-bound artifact archive.
Rust restores/validates it before validating the run checkpoint. Frame/render/
screenshot host outputs are pinned; conversation and receipt references are
captured alongside canonical archive and public conversation in one save. Old
bundles remain valid. Older already-lost artifact IDs are reported unavailable,
not invented or silently recovered. The existing 120MB total session quota still
applies to serialized records; oversized saves reject without replacing a prior
record. This increment does not implement separate large-file/cloud storage.

The chat reconstructs Blob URLs from restored native bytes for raster previews
and WebM/MP4 export cards, with MIME allowlists and cleanup on detach. URLs are
never persisted. UI rehydration is connected, but actual post-reopen browser
playback has not yet been accepted.

Evidence:
- Three ArtifactStore unit cases pass, including pinned expiry/eviction behavior,
  stable identity, digest corruption and duplicate archive rejection.
- Seven native session-store cases pass, including binary restore and atomic
  rejection of foreign account/digest corruption.
- Final WASM build and exports pass: 49 legacy /42 canonical required exports.
- Four focused real-WASM manager cases pass (47 assertions, 52 filtered out):
  public conversation restore, byte-for-byte recovery of the actual checked-in
  composed-export WebM, streamed mock-provider loop and uncertain host resume.
  Restored video bytes and MIME equal the original; no live LLM or perceptual
  playback claim is made by these focused cases.
- Nine host/checkpoint/render tests pass in 1791274588509/summary.json.
- Final production TypeScript, targeted source lint and whitespace checks pass.

Remaining: actual browser post-reopen playback/lifecycle acceptance, attachments,
explicit image-provider selection/generation, the missing editing contracts and
full complex live correction/export acceptance. Keep the full user goal active.


## 2026-10-06 Scoped attached model inputs

Added native InputAttachment references, conversation ownership and checkpoint
references. The Rust provider builds image input_image data URLs, PDF input_file
file_data and bounded UTF-8 input_text from the actual ArtifactStore bytes.
Attachments are untrusted task data, not authority. No arbitrary local path or
Files upload endpoint is exposed. The app supports PNG/JPEG/WebP, PDF and UTF-8
plain/Markdown text; the documented ChatGPT plan route does not support audio/
video inputs or image generation, which remain separate product paths.
Official sources read: developers.openai.com/api/docs/guides/file-inputs and
/siwc/token-sharing-open-source/preview-limitations.

The composer supports choosing/removing draft files and shows sent filenames.
Native checks bound each/combined input to 2MB, at most eight files, text to 64KB,
identity/filename sizes, UTF-8 and raster/PDF signatures. Pinning and atomic
artifact archive capture retain sent bytes. Scope changes during file IO reject
publication. Provider requests share the 2MB binary vision budget with evidence
frames; Base64 is resolved only for requests, not duplicated into checkpoints.
New attachment context is set on the scoped current agent after start/resume.

Evidence:
- Five existing native unit tests plus one new attachment integration case pass;
  the case checks owned image/text/PDF provider shapes, foreign-scope rejection,
  forged image MIME, and absence of data URLs in the checkpoint. Its minimal PDF
  fixture establishes transport shaping/signature only, not successful parsing.
- Native checkpoint (2) and session-store (7) tests pass again.
- Four focused real-WASM manager cases pass (47 assertions, 53 filtered out):
  attachment context and paired bytes/reference recovery, public conversation
  restore, mocked streamed-provider loop and uncertain host reconciliation.
- Final WASM build verified 49 legacy/44 canonical exports. Production TypeScript,
  targeted lint and compiled architecture/map gate passed.
- This is local attachment integration evidence. No actual PDF/image upload to a
  real provider or full browser attachment UX acceptance was executed here.

The explicit image-generation provider, complete complex live correction/export,
missing editing contracts and complete browser recovery acceptance remain required.
Do not mark the full goal complete from this increment.
