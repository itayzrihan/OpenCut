# Editor session lifecycle

Migration status: **bridged**. Classic uses the canonical runtime and the Rust
session store in `crates/editor-agent`. The browser owns transport scheduling
and document identity only; it does not maintain another project document.

- Reattaching the same account/project reuses its loaded canonical session.
  A takeover, project switch or completed automation reload still opens the
  latest saved archive. History drains before ownership is released.
- Browser identity is scoped to account/project in sessionStorage, with a Web
  Lock held for the document lifetime. Reload can reclaim that identity;
  duplicated tabs must claim a different identity. Without Web Locks, identity
  stays ephemeral. Every acquisition still advances the Rust generation.
- Lease expiry permits another editor to acquire the project. An explicit
  renewal may resume an expired lease only while its session ID and generation
  remain unchanged. Release or acquisition permanently fences the old owner.
  Commits and asset writes still require a live lease under the host lock.
- Focus, visibility and connectivity events renew ownership. Saves renew near
  expiry before publishing. Transient IO failures preserve pending commit
  identity and schedule retry without disabling editing. Definitive ownership
  failures still block writes.
- Pending saves coalesce before capture; edits during a write get a subsequent
  save. The complete canonical undo archive remains intact.
- Classic persistence requests archive v2: lossless JSON deltas against the
  current snapshot, with full snapshots when smaller. Version 1 remains readable
  and the default registry export. Restore validates every expanded boundary,
  limits expansion, and rejects unsupported patch operations atomically.
- A format upgrade at the same editor revision is accepted only when the
  complete canonical history matches. Content changes still require a new
  revision. An open editor with the older runtime can finish saving as v1.
- Large synchronous runtime results and storage requests cross the WASM boundary
  as JSON in one transfer, avoiding per-property JS/WASM calls.
- A stale automation preview blocks edits until reload, but is not an active
  worker lock and cannot prevent acquisition after the worker finishes.
- An interrupted caption/finishing run offers explicit resume from its last
  completed checkpoint, just like a failed run. The host creates a new run with
  the same recipe and leaves the expired worker token fenced.

Regression coverage: `project-session-lifecycle.test.ts`,
`session-identity.test.ts`, `session-client-transport.test.ts`,
`session-store-host.test.ts`, and `crates/editor-agent/tests/session_store.rs`.
Compact history coverage: `crates/editor-api/tests/classic_archive.rs`.

On a backup of the affected project, all 33 undo boundaries survived an exact
full-archive comparison after compact export and restore: 72,835,100 bytes became
12,181,908 bytes. No project edits or history entries were removed.


## Full Auto Edit on existing Smart Takes

Migration status: **bridged**. Caption row boundaries and generated finishing
layers remain owned by the Rust timeline crate. The Classic browser schedules
transport and presents the existing canonical capabilities.

- Resume checkpoints are scoped to the active scene. Legacy unscoped checkpoints
  are ignored once a project has scene-scoped jobs, preventing a completed stage
  in one Smart Takes sequence from skipping stages in another.
- Rust normalizes AI-proposed caption rows to the hard word limit while retaining
  the original words and timing, instead of rejecting an otherwise usable plan.
- Generated feathering, music and word-animation sound IDs include the scene ID;
  editing another sequence cannot introduce duplicate project-wide IDs.
- Progress and heartbeat transport coalesces only unsent status updates. Lifecycle
  events remain ordered, and completion drains the queue. Audio URL lookups share
  in-flight work and are cached per account.
- A recovery CLI restores missing legacy shared assets and fonts only for the
  original owning account, only into empty destinations, via verified staging.
- Disposing an idle agent panel does not save. Retiring a canonical session also
  retires its save queue, so a rejected old-session write cannot poison a freshly
  loaded session after background editing; the old caller still receives its error.

Regression coverage adds caption layout and cross-scene generated-ID tests in
Rust; scene checkpoint, queue ordering, account migration, audio URL caching and
session handoff tests in the web host. Smart Takes A and B both completed all ten
stages on the affected local project, with captions, zooms, transitions, word
animation and a full-length music track at -31 dB. The original Main scene was
preserved. 

Final local verification on 2026-10-08: run
`b4b0c859-65a2-4c2e-9876-e90f7ee833ec` completed all 10 stages continuously on
“Smart takes v2 — quality check”, with all four optional finishing features
selected. No resume or manual refresh was used during this run. The editor
reopened automatically; playback advanced from 5 seconds past 36 seconds, and
Undo followed by Redo restored the complete result. Persisted validation found
862 unique track/element IDs, preserved selected source ranges/order, unchanged
Main/A/B scenes, 418 caption words, 20 zooms, 43 text transitions, 3 word accents,
and exactly one full-length music layer at -31 dB. Large-project history saves
still take tens of seconds in the local development server; this verification
establishes successful completion and recovery, not a bound on save latency.


## Global audio library

Migration status: **Classic-only host asset catalog**, used by the bridged editor
through its existing canonical `libraryAssetId` references. No second editor
state or duplicate timeline capability was introduced.

The installation now has one authenticated, read-only global audio catalog at
`<accounts root>/global/shared-library/manifest.json`. Account manifests remain
private; visible catalogs overlay published IDs first. Both legacy account asset
URLs and pre-account `/shared-library/audio/...` URLs resolve published audio
without changing saved project or companion-effect IDs. Only manifest-listed,
contained audio files are served; unpublished account files remain isolated.
Ordinary account uploads cannot overwrite a published ID.

`classic/scripts/import-global-audio.py` validates bytes and license evidence,
then publishes atomically with `--apply`. Without that flag it reports only.
Existing source files are retained; conflicting IDs/bytes abort publication.
Repeated publication preserves subsequent human license reviews. The global
catalog stores SHA-256, source page, license URL, author and verification date;
source-page copies and included license files are retained in `license-evidence`.

The 2026-10-08 import contains 507 files: 381 SFX and 126 music tracks. All 137
legacy audio records retain their IDs and are marked `needs-review`. This includes
one original music file recovered from the legacy local-drive library. Added 341
SFX and 29 music tracks under explicitly published CC0 terms; two duplicate files
were skipped. All 507 byte hashes were verified. All 10 distinct companion sound
IDs found in text-transition, typing, overlay movement and automatic-edit presets,
and all 7 shared audio IDs referenced by the saved project, resolve globally.

Sounds UI exposes commercial-license filtering, original-asset review labels,
source links and global badges. Lists render visible rows only, and simultaneous
manifest reads coalesce per account. Global file reads bypass private byte caches.
Tests cover two accounts, unchanged IDs/bytes, old URLs, range/HEAD responses,
anonymous rejection, private-file isolation, path/symlink escape rejection,
published-ID overwrite rejection, import repeatability and checksum conflicts.

Final UI verification: SFX review filter shows 40 originals; music review filter
shows 97 originals; verified music filter shows 29 new tracks. A new global OGG
track played successfully through the authenticated range endpoint. All 507
files also passed ffprobe. Six focused web tests and two importer tests passed;
TypeScript and the architecture boundary check passed. The existing edited
project passed its unchanged-scene/source-range validation after publication.

Full Auto smart silence default (classic-only host orchestration): the silence
stage now invokes the existing Rust-backed Smart audio cut through
`timeline.removeAllSilence({ mode: "smart" })` for imported video and Smart Takes.
The 0.3-second value remains the minimum candidate pause; the smart analyzer
protects speech boundaries and retains uncertain audio. A `NoClearSilence`
safety hold is recorded as a note and later stages continue without a legacy
fallback. Cancellation, changed scene and analysis failures still stop the run.
The existing canonical silence transaction and stage/checkpoint order are reused;
no new state store, algorithm or rewrite implementation was introduced.
Validation: 22 focused web tests, 14 Rust smart-silence tests, TypeScript,
focused ESLint and the editor architecture boundary check passed.

Selected silence restoration (classic-only, 2026-10-09): the current Rust/WASM
compiler already restores only source gaps between consecutive selected clips.
The reported outer-handle expansion was not reproduced in the current binary.
The host now captures the prepared restoration before awaiting canonical session
initialization, so a changed selection cannot expand the requested range and a
changed project, scene or source revision is rejected before publication. The
menu explicitly names restoration between selected clips. New tests exercise
real WASM plus source serialization for two/three middle clips, unchanged outer
source handles and neighboring clip durations, expected downstream ripple,
selection expansion, project/scene/revision changes and invalid selections.
Validation: 16 web tests, 16 Rust restoration/caption tests, TypeScript and focused
ESLint passed. No independent state store or duplicate timing logic was added.
