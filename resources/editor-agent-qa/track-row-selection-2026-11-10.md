# Timeline row selection

The sidebar now exposes a keyboard-accessible “Select all clips in {track}” button on each track. Empty and locked tracks, and the active range-selection lock, disable the button. A normal click replaces the selection; Shift/Ctrl/Command adds the row to the existing selection. The pressed state means the exact row scope is active, not merely that its clips happen to be selected.

Selection is the existing `EditorDocument.selection` model. Classic IDs are validated against the Classic document. `timeline.classic.selection.read` and `timeline.classic.selection.set` are registered capabilities available in the browser and Electron runtime, and automatically projected through MCP. `app.state.read` exposes the same selection. Presentation changes have their own `workspace.classicSelectionRevision`; they do not create Undo entries, change content revision/dirty state, or rewrite the project archive. Both content and selection revisions can fence writes. Dry run, exact retry keys, cancellation and explicit project/scene scope are supported.

The host's existing SelectionManager is a projection cache when a canonical session is active. It returns stable array references across repeated unchanged runtime reads. Ordinary selection writes use the same capability. Host commands may stage selection while a content transaction creates/removes clip IDs, then reconcile through the capability after commit. The previous pre-session behavior remains available while no canonical runtime is attached. Keyframe/word/mask sub-selection retains its existing host representation; selecting a row clears those more-specific selections.

A deliberate row selection records its track ID in `selection.trackIds`. Ordinary clip selection clears that scope, even when the clip IDs themselves are unchanged. Adding clips from another row also clears exact-row scope. Within this scope, movement, split, trim and retiming do not automatically expand to reciprocal audio/video peers. Drag and resize previews follow the same rule, and row resizing suppresses cross-track ripple propagation. No global unlinking takes place. Ordinary linked selection retains the existing linked-edit behavior. After a split, the canonical row selection includes the newly split clips; host result selection reconciliation preserves that scope. Structural deletion removes stale references, and scene navigation clears selection.

## Verification

- `cargo test -p opencut-editor-api --test classic_selection --test classic_move --test classic_split --test classic_source_audio --test classic_scenes`
- `node classic/scripts/test-web.mjs src/core/__tests__/canonical-selection.test.ts src/core/managers/__tests__/canonical-command-manager.test.ts`
- `node classic/scripts/test-web.mjs src/timeline/group-resize/__tests__/resize-controller.test.ts src/core/managers/__tests__/command-manager-state-revision.test.ts`

The selection registry tests cover readback, dry run, retry keys, unchanged content/archive, exact vs ordinary selection, additive selection, stale/unknown/empty/locked/cancelled rejection, scope after two sequential edits, and linked-peer preservation for move/split/trim/delete with Undo/Redo. A subsequent ordinary selection still moves its linked peer correctly. The browser-WASM test covers projection reference stability, staged writes, scene changes, account cache invalidation and unloading. The ResizeController gesture regression checks both preview and commit, including that ordinary selection still includes linked audio.

On 2026-11-10, the final real-WASM selection and complete canonical command-manager run passed all 83 tests (`/private/tmp/pocut-track-selection-wasm-final/summary.json`). The resize and command-manager revision regressions passed all 8 tests (`/private/tmp/pocut-track-selection-ts-qa/summary.json`). Rust checks passed the 4 selection and 10 scene tests, plus the existing 2 move, 6 split and 7 source-audio tests. Browser UI verification and release deployment are tracked separately by the release owner.

## Owned files

- Rust: `model.rs`, `operations.rs` registration/selection reconciliation, `operations/classic_selection.rs`, selection hooks in `classic_scenes.rs`, `classic_move.rs`, `classic_split.rs`, `classic_update.rs`, and `tests/classic_selection.rs`.
- Host bridge: `core/canonical-classic-session.ts`, `core/managers/commands.ts`, `core/managers/selection-manager.ts`, row retime handling in `core/managers/timeline-manager.ts`.
- UI: `timeline/components/track-select-button.tsx` and its mount in `timeline/components/index.tsx`; linked-preview handling in both interaction/resize controllers and their hooks.
- Web tests: `core/__tests__/canonical-selection.test.ts`, `timeline/group-resize/__tests__/resize-controller.test.ts`.

Archive exchange registration in `operations.rs` was coordinated with its owning agent. Archive format and exchange behavior are separate work; this change does not add selection to project archives.
