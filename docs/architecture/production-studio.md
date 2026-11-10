# Canonical production workspace

The docked Production panel reads `project.extensions.productionStudio` through
`project.production.read`. React retains only unsaved forms, selections and active
request progress. `project.production.edit` is the shared typed UI/agent/MCP entry
point: optimistic project and row/slot versions, transactional changes, dry run,
registry idempotency, Undo and Redo. No duplicate MCP implementation exists.

Script rows use source milliseconds, stable IDs and append-only versions (maximum
32 per row). SRT preserves timestamps and original text. Plain lines receive
explicitly estimated timing. Source language and source text remain separate from
Latin transliteration. Restoring a prior version appends another version. Concurrent
edits reject stale form saves without discarding the unsaved draft.

Reference slots bind existing account/project-owned Generative image IDs. Upload or
generation appends one version to one slot. Selecting or replacing a version clears
creative approval; siblings and older images remain intact. Human image generation
review freezes up to ten exact prompts, selected input images, provider and model.
Operation IDs include account/project/slot revision/prompt/references/provider/model.
OpenRouter creates one immutable batch and requires its existing human PIN approval;
native Codex uses the paired companion and durable operation journal. The board does
not infer entitlement, share provider secrets or automatically grant creative approval.
Cancelling stops local waits and requests cancellation of queued OpenRouter work;
provider-accepted generations may still complete and incur charges.

The internal agent can attach native generated images without transferring binary
through model context: `imagegen.generate` returns the owned artifact ID, then
`project.generative.request` operation `importArtifactReference` resolves that ID
against an active project image's verified artifact/SHA binding. It transfers the
original bounded PNG/JPEG (up to 12 MiB) through the existing authenticated import
host and returns reference metadata. The agent adds `reference.id` to the intended
slot using `addReferenceVersion`; creative approval remains separate. Same-content
artifact IDs returned during generation recovery are accepted only when their
bytes match the existing verified project binding. Unbound/foreign artifacts,
stale scope, mismatched receipts, oversized bytes and filename paths reject before
canonical attachment. Re-encoding and arbitrary filesystem reads are not supported.

`project.production.handoff` atomically snapshots every current script row and chosen
approved reference version into `generative.productionHandoff`. It writes exact source
lines to Director transcript and the complete source/Latin/visual/timing/request snapshot
to direction. It preserves reference files, old versions and existing storyboard copy.
Duration is the last script end; storyboard recommendation is optional. This transaction
does not generate or approve payment. Chapter plans capture source versions and direction
identity; changed material requires renewed review. The handoff animation is decorative
and deduplicated by handoff ID.
The direction also includes the established `creative_intent`, `spoken_script` and
timed `shots` projection, so existing Director/PDF tools can reuse exact planned
descriptions or source dialogue without inventing scene images. Explicit storyboard
copy remains untouched. Agent instructions require parallel Latin transliteration
for non-English dialogue before handoff unless the user opts out; source text is
never replaced or translated by that step, and uncertain pronunciation needs review.

## Source video analysis

The built-in `production-video-analysis` skill and `project.production.read` instructions
require actual timestamped evidence and separate observations from interpretation.
The panel prepares an editable agent request; it never sends inference automatically.

`project.production.video.inspect` executes the `productionVideoFrames` host adapter
in the active browser or Electron editor. It decodes only an owned project video,
accepts one to eight source timestamps, and produces real JPEG frames with a maximum
dimension of 640 pixels and maximum size of 180 KB each. No source upload or inference
is involved. Account/project/revision/source identity and cancellation are checked
around decoding; frames are stored only after all decoding and scope checks succeed.
The runtime resolves ArtifactStore IDs to verified metadata. Source frames do not
prove motion, audio or unreviewed intervals. Speech/humor/delivery claims need actual
audio or timed transcript evidence. Reports store evidence metadata, reviewed ranges,
confidence and limitations, not unsupported assertions of full-video inspection.
The agent includes up to eight current-revision receipt images in its next provider
request. Its existing two-megabyte binary budget is shared with user attachments;
older or missing images are omitted, and checkpoints retain artifact IDs rather than
base64 payloads. Analysis must stay within the evidence actually presented.

Both browser and Electron use the same registry and state. Local native AI connections
require the user's companion; OpenRouter uses the existing authenticated review service.
Classic archive v6 preserves current and historical project extensions; artifact archive
collection recognizes analysis evidence by canonical ID/URI/SHA across document history.

## Verification

- Rust `production`: seven integration tests cover registry state, SRT/source integrity,
  per-row history, reference isolation/approval, report evidence bounds, source host
  receipts and cancellation, complete Director handoff, and full/base/chained archive
  restoration with Undo/Redo and rejection of malformed current/history extensions.
- Chromium `video-inspection.test.ts`: actual generated red/blue WebM decoded into
  distinct bounded JPEGs at requested timestamps, without API requests. Actor/revision
  changes, cancellation and out-of-range samples publish no artifacts (23 assertions).
- `production-wasm.test.ts`: real compiled browser runtime and the actual
  `CanonicalClassicSession.archive/restore` path preserve source/Latin row history,
  reference approval and Director handoff after serialization and Undo/Redo.
  Passed against the final rebuilt WASM (9 assertions, 860 ms); the companion
  chapter collection WASM test also passed (8 assertions, 983 ms).
- No paid provider requests or real project media are used by these tests.
- Agent runtime, attachments and knowledge suites passed 19 tests. The new evidence
  regression verifies eight frames without user attachments, seven frames plus a
  600 KB attachment under the same two-megabyte budget, and no checkpoint image bloat.
- Artifact-reference follow-up: three Rust tests cover the complete generated-image
  import/slot workflow, exact bytes/SHA, recovery aliases, retry identity, preflight
  ownership/size/filename rejection, and stale/cancelled/incorrect receipt isolation.
  The combined artifact/host/production/storyboard regression run passed 17 tests.
  Against the rebuilt browser WASM, both persistence and native-image-to-slot tests
  passed (16 assertions, 1.2 seconds). The import test checks the exact binary/SHA
  inside the trusted host boundary, one generation call and metadata-only public output.
