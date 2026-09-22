# Classic trim ripple verification

Scope: Classic-only repair of the existing resize gesture and canonical undoable timeline transaction. No rewrite implementation or second project state store was added.

- Main-track left/right trimming now applies signed timeline changes. Left-edge edits keep the selected clip anchored; recovered source is bounded by the available source and minimum duration.
- The shared Rust/WASM timing kernel maps endpoints through removed time, including crossing and fully consumed companion layers. Fully consumed companions are removed in the same command.
- Word runs and canonical caption-source timestamps use the same time mapping. This avoids sequential text reconciliation matching against already shifted neighbors and discarding unrelated transcript words.
- Preview is rebuilt from committed state on each mouse movement, so reversing a drag clears stale companion offsets.
- Undo restores the saved tracks without reapplying caption reconciliation.

Validation: 58 Rust timeline tests, six frontend tests (four edge/direction gestures, companion shifts, caption-source preservation), rebuilt WASM and verified its required exports. UI checks on Short1 shortened a middle clip by 52,000 ticks from each edge: following video remained adjacent, the full-length effect shortened by the same amount, and Undo restored the pre-test tracks. UI test changes were undone. Existing user edits preceding this session were retained.

Repository-wide TypeScript checking reports errors in unrelated existing modules. Changed trim files are checked separately in that output. ESLint reports fixture type-assertion warnings in tests.

Remaining product work, in order: approve automatic subject-aware zoom and AI text in/out transition toggles; add horizontal face centering before silence removal; resolve general transcription dropouts and confirm the exact Assistant font; assemble the approved one-click editing workflow; then add Projects Batch import with a project per file, background processing, read-only live updates for busy projects, and continued access to the rest of the app.
