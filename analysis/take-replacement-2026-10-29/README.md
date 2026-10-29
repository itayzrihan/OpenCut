# Replacing smart takes after manual editing

## Root cause

`timeline.classic.takes.edit` regenerated the entire archived assembly. Its comparison guard correctly prevented that regeneration from undoing later edits, but also blocked legitimate alternative selection after a trim, split, deletion, reordering or bookmark edit. The same guard blocked silence cleanup on an edited assembly.

## Change

This capability remains classic-only, implemented in the canonical Rust editor runtime and projected through the existing UI/WASM/MCP contract. No additional state store or alternate mutation endpoint was added.

An unchanged assembly still uses the existing renderer. An edited assembly uses a local replacement transaction:

- Locate surviving members of the chosen take group by archive identity and media/source time, independently of their current timeline position or generated clip IDs.
- Align old and alternative dialogue monotonically by word text, with bounded dynamic programming and interpolation for different wording. Retain only the ranges still present after manual cuts; deleted groups cannot be resurrected.
- Replace those retained ranges, preserving authored framing, mix parameters, caption presentation and sliced animation channels. Source offsets come from the new archived performance.
- Ripple subsequent existing material by the actual duration change. Preserve unrelated clip IDs, media ranges, durations, edits and ordering, and retain current bookmarks.
- Splice the affected caption words/cues and synchronized source audio. Keep current layers and independent overlays instead of restoring all archived tracks.
- Apply the same mechanism to silence cleanup, sharing one reference render across groups. Save through the normal canonical transaction, validation, revision checks and Undo/Redo.

Replacing or extending the selected clip beyond its archived source still produces a targeted conflict: the runtime cannot safely infer the intended alternative for unrelated replacement media. Trimming, splitting, deleting or moving normal take clips no longer causes the old global conflict.

The local production builder also receives an explicit Git output buffer limit; the accumulated tracked audit events had exceeded Node's default buffer before compilation could start.

## Verification

Native capability regression coverage includes trimmed takes, deleted groups/bookmarks, unequal-duration alternatives, synchronized audio, speech-preserving silence cleanup, repeated selection after cleanup, presentation, reload and Undo/Redo. The private edited project is replayed through the registry across groups 2, 13, 0 and 17, including its split group 13. The private project and media are not committed.

The real WASM host suite now also replaces a trimmed take after deleting another group, through `CanonicalClassicSession`. Deployment and live verification results are recorded separately in `verification.json` once completed.

## Deployed result

Release `2026-10-29T05-59-52-372Z-46c71db4` passed its startup smoke check and is active on port 3211. The browser was reloaded. A context-menu selection changed the edited, split group 13 to alternative 1; the editor displayed the new checked choice. All 25 current main clips remained, unrelated clip identities/content/trims were preserved, and the source archive was unchanged. Undo restored the exact pre-test tracks, bookmarks and take assembly. The project remains in its original edited state, with the fix available.

Validation: 27 canonical native tests, 175 timeline tests, 19 targeted web tests, TypeScript and focused lint. The first real-WASM host run exceeded its default five-second per-test budget during the production build; both cases passed with a 30-second budget. One browser input acknowledgement timed out during the live synchronous transaction; saved canonical state and the subsequent checked menu confirmed successful completion, so the action was not repeated.
