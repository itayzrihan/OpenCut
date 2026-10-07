# Smart takes — experimental branch

Status: **bridged**. Classic exposes the UI; `OpenCutRuntime` in `crates/editor-api`
owns validation, slicing, source archives, transcript rebuilding, history and
alternative selection. The rewrite has no second implementation. Existing
Reorder takes remains available and unchanged.

## Workflow

1. Transcribe the scene. Select the main-track video clips to analyze, including
   every clip between the first and last selection. Recording gaps are allowed.
2. Click **Smart takes** next to Reorder takes. The connected ChatGPT account runs
   three passes: identify filming notes and takes; infer narrative beats and
   alternatives; critique continuity and word coverage. Cancel stops the request.
3. The final validated plan is applied as one undoable edit. Production notes and
   unusable false starts are cut from playback; usable alternate performances are
   archived rather than played back consecutively. Original media is retained.
4. A layers badge identifies clips with alternatives. Right-click →
   **בחר את הטייק הטוב ביותר**. Options show actual transcript, duration, cut count,
   rationale and the original AI recommendation. A composite is one alternative
   even when it consists of several timeline clips; choosing on any component
   replaces the group's complete sequence. Other groups retain their choice.
5. Unequal lengths ripple subsequent material; generated captions and the scene
   transcript are rebuilt from the selected source words. Undo/redo, save/reopen
   and canonical session archives retain all alternatives.

## Contracts and data

- `timeline.classic.takes.prepare`: Read, project/scene/revision scoped, no IO.
  Returns stable word IDs for that revision, original clip identity, transcript
  source index and integer tick boundaries (120000 ticks/second).
  Zero-duration and sub-tick transcript words retain their text and receive up
  to 1 ms within their owning clip. Assembly and caption rebuilding use the same
  bounded timings; the archived source transcript remains unchanged. Reversed
  or invalid timestamps are still rejected.
- `timeline.classic.takes.edit`: Write, assemble/select tagged union. Supports
  optimistic revisions, registry idempotency keys, dry run, cancellation,
  transactions and history. These are automatically projected through MCP.
- Plans contain narrative-ordered `groups`; each alternative has ordered inclusive
  `firstWord`/`lastWord` ranges, each within one source clip. Distinct parts can be
  taken from distant points. Wording need not match between alternatives.
- Every source word belongs to a group or an explicitly reasoned discard.
  Sharing between alternatives of the same group is allowed. Repeating footage
  within an alternative, cross-group reuse, unknown IDs, overlapping discards,
  missing coverage, empty groups and invalid selected indexes are rejected.
- `scene.takeAssembly` stores versioned source tracks/bookmarks, evidence,
  alternatives, selected indexes and recommendations. Active clips have
  `takeGroup` references. `app.state.read` exposes all data; document validation
  also covers restoration and admin patching. Source media cannot be removed
  while an archive depends on it.
- Stale inference, account switches and cancellation produce no timeline edits.
  Snapshot fingerprints normalize integral floats for JS/WASM serialization.

## Current boundaries

This is a transcript-based recommendation system. It does not score acting,
intonation, camera focus, expression or audio quality. **90% selection accuracy
has not been measured or established.** Confidence is a model's semantic
assessment, not a calibrated success probability.

The initial version accepts 1–1000 nonoverlapping main-track videos with a single
caption source, at most 15000 selected words and 20 alternatives per story group.
There is one assembly per scene. It operates on the currently retained footage;
material already removed by earlier edits cannot be inferred from its transcript.

Choose alternatives before further manual timeline/bookmark edits. If the scene
has changed since assembly, selection fails with an actionable message instead
of overwriting those edits. Undo the later edits first. Arbitrary subsequent
trimming/rearrangement with automatic rebasing is not supported in this version.

Cuts occur at transcript word boundaries; generated caption reflow uses the
shared Rust builder's fallback font measurements. Manually owned transcript
words in the edited region, and cuts through manually authored timed text, are
rejected. Unaffected manual caption layers are preserved and retimed. This is a
logical alternative stack, not a new nested timeline/compound clip type.

## Validation and release gate

Automated tests cover registry apply/readback, continuous vs composite choices,
source retime, ripple, transcript/caption timing, explicit note removal, dry run,
idempotency, revision/account/cancellation failures, malformed plans, media
retention, undo/redo, real WASM UI bridge and archive/reopen. The inference tests
use a mocked streaming provider; they do not measure live model quality.

Before merging, use real Hebrew and English recordings with editor-labeled
preferred takes and production asides. Include late-recorded introductions,
paraphrased duplicates, three sentences recorded together vs separately,
mid-sentence filming notes, and ambiguous dialogue resembling a filming note.
Measure preferred-selection agreement (target ≥90%), false removal of useful
speech, note-removal precision/recall, narrative coherence, and editor correction
time. Verify playback, cuts and caption layout in the desktop UI. Keep this
branch isolated until those acceptance results justify merging.
