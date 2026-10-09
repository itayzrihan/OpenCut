# Podcast extracts

Status: **classic-only, bridged through OpenCutRuntime**. The Classic AI panel
provides three controls. Rust in `crates/editor-api` owns selection validation,
scene creation, cut protection, transcript rebuilding and undo history. The
rewrite has no parallel implementation. Browser code transports model requests
and decodes audio; it never applies an independent timeline.

## Workflow

- **יצירת טיזר** creates one coherent teaser, allowing source reordering. The
  model is asked to open with the strongest moment and end with an unresolved
  question or withheld payoff, preserving meaning and complete words. The
  default target is 45–60 seconds; the maximum is adjustable from 20 to 90.
- **קטעים חכמים מפודקאסט** creates separate 20–90 second shorts. Each combines
  at most three complete passages from one five-minute source window and may
  reorder them for coherence.
- **קטעים לפי סדר המקור** creates separate 20–90 second shorts in source order.
  Every alternative must preserve the order of its source passages. Gaps and
  weak takes can be omitted. Each short stays within one five-minute window.

Open the original episode sequence, then choose a control in the AI panel.
Missing transcription is generated first. Analysis reads five-minute windows,
curates candidates, then validates the final proposal with one bounded repair
attempt. Audio evidence protects the final cuts. All outputs are created in one
atomic edit as separate named sequences, available from Media or the sequence
selector. The original sequence and source files are retained. No intermediate
video rendering or automatic export is required.

Each output is one logical Smart Takes group. When the model supplies equivalent
versions, right-clicking any component opens the existing alternative picker;
the whole output changes, including composite versions of different lengths.
The archive's `selectionOnly` flag prevents discarded episode footage from
returning before or after an alternative. Full Auto can use the existing Smart
Takes preparation to process the retained cuts and rebuild captions.

Cancel stops pending model/audio work. Project, account, scene or revision
changes reject application. A newly generated transcript remains after cancel;
no output sequences are created until the final transaction succeeds.

## Canonical contracts

- `timeline.classic.podcast.prepare`: read a revision-scoped word inventory and
  five-minute windows, bounded to 60,000 words.
- `timeline.classic.podcast.review`: validate proposed outputs without mutation.
- `timeline.classic.podcast.extract`: atomically create outputs, retain the
  original, and activate the first result. Supports optimistic revisions, dry
  run, cancellation, undo/redo and registry idempotency/transactions.

All three require explicit project/scene/revision and are automatically
projected by the MCP registry. There is no duplicate transport-specific tool.
`scene.podcastExtract` stores mode, options, title and hook descriptions;
`scene.takeAssembly` stores source evidence and alternatives. Both are validated
when the canonical document is restored or patched. Native operations perform
no network/file IO and produce editable timeline state, not binary artifacts.

The validator rejects out-of-range or reused words, invalid duration, tiny
fragments, cross-window shorts and forbidden chronological reordering. Audio
handles must also fit under the requested maximum. Source captions and audio
use the same integer-tick mapping as video cuts.

## Limits and verification

Default maximum output count is 24, adjustable to 32; weak material can produce
fewer. Analysis proposes up to two candidates per five-minute window. Each
output accepts up to five alternative versions. Source archives are currently
retained per output, so many outputs from a long episode consume additional
project memory. Audio is decoded by the existing browser media pipeline, with
coarser evidence frames on long episodes to keep the native evidence bounded.

Hook quality and performance selection are transcript-based model judgments,
not measured guarantees. The model does not assess acting, facial expression or
intonation. Acoustic protection depends on transcript accuracy; boundaries
without confirmed safe silence remain visible as review items. Listen to cuts
before export, particularly teaser cliffhangers.

Regression coverage includes canonical registry creation/readback, exact caption
clocks, source preservation, chronology/window/duration rejection, atomic
failure, revision conflicts, cancellation, dry run, undo/redo, alternate versions
and archive/reopen. Real WASM bridge tests and mocked streaming planner tests
cover all three modes. Live model quality on a full podcast remains an editorial
evaluation step; these tests do not establish hook-selection accuracy.
