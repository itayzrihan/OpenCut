# Automatic Zoom — Classic implementation

The AI tab has an Automatic Zoom button. It reads the full active scene's Timeline Source v2, including timed captions, cuts, trims, transforms and layer order, plus media dimensions and up to three 384px preview frames. The existing Codex OAuth route runs the actual [directing skill](classic/apps/web/src/ai/skills/automatic-zoom/SKILL.md). No Overlay Movements are involved.

## Editorial behavior

Jump Cut, Smooth, Snap In and Zoom Out are native effect envelopes. The model picks semantic beats, scale, anchor, entry/exit speed and duration. Rust checks finite values, frame alignment, video coverage, 0.6–4.5s durations, 1.04–1.30 scale, separation, density and total coverage. One invalid event rejects the entire plan; the adapter requests one repair before reporting an error.

The compiler inserts an editable effect track immediately above the main video. Captions and existing effects above it stay static. Each element carries its semantic reason. A native GPU UV transform samples inside the original frame, so it introduces no black padding. The same shader/envelope serves preview and export. Changing an effect's duration updates the envelope using its live timeline duration.

Swish policy is deterministic: jump/snap, scale >=1.12, minimum three seconds between sounds. The `soundreality-whoosh-end-384629` library asset (`19f29ed9-a604-4933-ae8c-e494b6cee47f`) is trimmed to the authored 0–1.38s excerpt at -35dB with a 0.05-second fade-out, bounded by the video end. Library availability is checked before applying. Audio companion elements record the owning zoom ID. They remain separately editable; this version does not introduce a general drag-linked group system.

Snap In and Jump Cut hold their punch-in, then ease back to baseline over at least 0.6 seconds (bounded by the effect span). Legacy zero-release sharp zooms also receive an eased ending. Smooth is unchanged.

The directing skill is included as system instructions on every Automatic Zoom request, including repairs. It provides all four styles, semantic selection rules, scale/speed limits, framing rules and the output contract; no repeated user explanation or research is needed. Styles are mixed when appropriate, not forced into every video.

**Overlay Movement → Classic Zooms** contains Jump Cut, Smooth, Snap In and Zoom Out as independent manual presets. Their defaults live in Rust and their visual curves use the same native sampler. Drag or add inserts an editable `automatic-zoom` effect through the existing timeline command; no custom Overlay Movement engine or AI request is involved. Manual presets are silent and unowned, so an AI rerun preserves them. Deterministic Whoosh attachment belongs to Automatic Zoom runs.

## State and migration contract

Status: **classic-only**, not migrated to the rewrite. Business rules and source compilation live in `classic/rust/crates/timeline/src/automatic_zoom.rs`; GPU rendering lives in `classic/rust/crates/effects`. No second project store, direct project-file writes, or separate hand-coded MCP tool was introduced. The Classic shell uses the existing canonical Timeline Source transaction and CommandManager persisted undo history, exactly as the Timeline Code editor does. The model returns a constrained plan, never arbitrary executable timeline mutations.

The active project ID, scene ID and full source revision are checked again after asynchronous AI/media work. Apply is atomic and undoable once. Cancellation/unmount prevents apply; source changes cause a stale-plan error. Rerunning removes owned generated elements, preserves manual elements and replaces the generated layer without stacking duplicates. Identical source+plan compilation is idempotent. Existing Timeline Source inspection exposes all generated state.

This does not claim new parity with `crates/editor-api`'s rewrite document/capability registry. Migrating the Classic source transaction to OpenCutRuntime must preserve these native effect/audio fields, revision guard and atomic undo contract, and add registry/app.state.read round-trip tests before advertising rewrite support. Do not create a second rewrite implementation of the planner.

## Research and limits

[Research notes and official AutoCut sources](classic/apps/web/src/ai/skills/automatic-zoom/references/research.md) distinguish public behavior from our own numerical defaults. AutoCut's private scoring algorithm and exact constants are not publicly documented. We intentionally avoid zooming on every silence-removal microcut. Static preview samples help framing but are not continuous face tracking. Horizontal face centering before silence removal remains a separate planned feature.

Requires timed captions and visible main-track video. The existing AI route has a 1MB request limit; oversized scenes fail explicitly without partial edits. No automatic export is performed. Automatic Transition Edit, the combined automation buttons and batch import are separate follow-ups.

## Verification — 2026-09-22

- 68 timeline Rust tests passed, including ten zoom tests for preservation, layer order, deterministic SFX, repeat runs, manual mixed tracks, invalid plans, gaps/hidden clips, density/coverage and seekable envelopes.
- Four effect pipeline tests passed, including native zoom uniform packing.
- WASM build passed with all 20 required exports verified, including the native preset catalog.
- Skill structure validator and the new skill's projection check passed. Projection is included in `skills:generate` / `skills:check`; the aggregate check currently stops on the pre-existing stale paper-grid-editorial projection, which was not rewritten for this feature.
- TypeScript still reports existing unrelated repository errors; no errors in the changed Automatic Zoom files. Targeted ESLint has no errors (one existing type-assertion warning in AI chat).
- Live Codex run on Short5 produced eight semantic zooms and four swishes. Full source comparison confirmed every original track remained byte-equivalent as JSON. A 3s frame comparison showed video magnification with unchanged caption size/position. One Undo restored the complete original Timeline Source exactly.
- Cancelling during preview sampling left the entire source identical to the baseline, including after reload.
- The verified example was restored in Short5 for user review: eight zooms, four swishes, with all four sound fade-outs verified as 0.05 seconds in live Timeline Source. No export was started.

The user's review of pacing and sound balance is still needed before this is folded into the general editing automation.

## Completed eight-project run — 2026-09-22

Short1–8: zoom counts **9, 10, 8, 9, 8, 6, 9, 9**; Whoosh counts **4, 5, 4, 5, 4, 2, 4, 5**. Total: **68 zooms / 33 sounds**. Persisted project reads verified every original element unchanged, every sharp release >=0.6s and every generated sound uses the selected asset at -35dB. No export.

Live UI verified the separate four-preset group, added a manual Jump Cut with the native effect and 0.8s return, then undid it. Complete source restored except its expected scene updatedAt timestamp. Targeted ESLint passed and TypeScript reported no errors in the zoom/preset files (repository-wide pre-existing errors remain).
