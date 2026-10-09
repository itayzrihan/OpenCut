# Timeline interactions and explicit ripple deletion

2026-10-09. Classic UI changes; deletion is bridged through OpenCutRuntime.

- Playhead edge scrolling is active only for its own drag session, with a 24px
  edge zone. Other scrubbing cannot reuse an old playhead pointer coordinate.
  Scroll events re-seek beneath a stationary dragged pointer; playback following
  remains disabled during the drag.
- Left-edge ripple trim previews use the uncollapsed clip position and preserve
  its right edge. Other layers remain in place until mouseup. Preview-only
  updates do not anchor the first main-track clip to zero; committed updates
  retain that rule. The existing trim transaction and time mapping are unchanged.
- `ripple-delete-selected` is available in the toolbar and clip context menu as
  “Delete and close timeline space”. Normal Delete retains its existing policy.
  The UI passes `removal.ripple=true` to `timeline.classic.remove`; Rust owns
  selected interval union, signed trim splice mapping across layers, caption
  words, animation clocks, transition bounds and bookmarks. Consumed companions
  disappear. Locked-track changes reject atomically. Duplicate/overlapping
  selected intervals close once; preexisting gaps outside the selection remain.
  Ordinary automatic ripple is skipped after this explicit splice, preventing
  double shifts. One canonical history boundary supports Undo/Redo.
- The existing live registry projects the extended typed schema to MCP. The
  operation remains Write, transactional, revision-checked, dry-run capable,
  idempotent and local; it never deletes media files. No second editor store or
  duplicate MCP endpoint was introduced.

Validation: 17 focused web interaction/trim tests, 77 canonical command-manager
integration tests, 9 Rust removal/ripple/split registry tests, TypeScript and the
architecture check passed. Focused lint has no errors (existing assertion
warnings remain). The editor runtime WASM was rebuilt and exports verified.
Browser verification: playhead moved from 13s to 24s while viewport scrollLeft
stayed 412; the new enabled context-menu action and toolbar control were visible.
The browser automation connection timed out on the attempted deletion, so no
successful browser delete/undo round trip is claimed. Saved project duration
remained 135.15991666666667s with 39 main clips after that attempt.
