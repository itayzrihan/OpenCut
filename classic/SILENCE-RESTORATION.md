# Restore removed silence

Status: **classic-only**, projected through the existing authenticated classic
MCP bridge. The rewrite's EditorDocument is not a second copy of this feature.
The classic EditorCore source transaction remains the authoritative project
mutation during migration; the bridge exposes the same registered operation.

Select at least two consecutive, touching video clips on one unlocked track,
then choose **ביטול מחיקת רגעים שקטים** in the context menu. Clips must refer to
one source file at the same constant forward playback rate. No clip-count limit.

Rust reconstructs missing source intervals from trim positions, extends each
left clip to the next source interval, and inserts that time across the scene.
It preserves clip IDs, individual framing and the outer source trims. Later
layers move; spanning layers extend. Caption words, word runs, animation keys
and bookmarks follow the same insertion map. The whole change is one persisted
undo/redo transaction. Applying again finds no remaining gap.

This also works on old projects without silence-removal history. Consequently,
any omitted source interval between the selected clips is restored, including
an interval cut manually. It does not recover missing transcription text.

`timeline.restore_silence` is registered with edit/layers access and is
projected automatically as `opencut.classic.timeline.restore_silence`. Inputs:
`trackId`, `elementIds`, optional `dryRun`. The bridge adds project/session
addressing, optimistic revision checks and idempotency. The agent tool stages
an `apply_timeline_source_v2` operation using existing scope validation and
review/application machinery. A dry run neither stages nor applies changes.
Read back classic state through `classic.session.read`; rewrite
`app.state.read` is not a mirror of classic projects.

Validation: Rust timeline suite (119 tests, including five restoration cases),
WASM export check, tool staging/dry-run tests. Live browser test restored a
0.46-second gap and shifted all eight tracks. MCP snapshots confirmed one Undo
restored the full original timeline exactly.

Repository-wide TypeScript checking still reports existing type errors (including
unified-angle selection and older timeline-tool fixtures). The full tool test
file has one unrelated premium-workflow prompt expectation failure; all five
focused source/registry/restoration tests pass.
