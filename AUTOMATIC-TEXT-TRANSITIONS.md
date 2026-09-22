# Automatic Transitions

The AI tab contains **Automatic Transitions** directly beneath Automatic Zoom. It reads the full active Timeline Source, timed captions, existing zoom/audio accents and three small preview frames. The directing skill is included in every request, together with the complete live transition registry. The AI selects exact text IDs, IN/OUT sides, presets, transition percentages and semantic reasons. It cannot rewrite words or move clips.

## Style learned from authored projects

Ten references were inspected: Galya8–12, Shemi 1, Shemi2, נקמה, ניכור הורי and פחד להתגרש. [Source audit](classic/apps/web/src/ai/skills/automatic-text-transitions/references/style-analysis.md) records counts and IDs; the [runtime skill](classic/apps/web/src/ai/skills/automatic-text-transitions/SKILL.md) includes actual phrases and editorial interpretation.

Selection is open to the entire native catalog, not a Push Right/Flicker whitelist. Sound-equipped transitions have an advantage when they fit the meaning, but silent transitions and varied exits are equally eligible. A real enumeration can use several matching side pushes; a reassurance/solution can use gentler motion; an exit can close a painful thought before the advice begins. Existing examples teach local motifs and emotional changes, not a requirement to copy their whole-video density.

The soft target is 30–40% of visible caption duration receiving special accents. Overlapping caption intervals count once, as does a text with both IN and OUT. This measures accented text exposure, not the animation's own duration. Quiet stretches remain intact; the model explains density choices. Existing manual accents count toward the density budget. Rust rejects increasing coverage above 65%, while preserving denser manual edits already present.

## Native behavior and state

Business rules and source compilation live in `classic/rust/crates/timeline/src/automatic_text_transitions.rs`. The existing native transition renderer supplies the motion. The browser transports the model plan, checks sound-file availability, verifies project/scene/source revision and applies one canonical Classic Timeline Source transaction through CommandManager. There is no second state store, direct project-file write, or hand-coded MCP tool.

Migration status: **classic-only**, consistent with Automatic Zoom. It does not advertise rewrite parity. A future OpenCutRuntime migration must preserve transition metadata, companion audio, ownership/restoration, revision checks, cancellation and atomic undo, and add registry → app.state.read round-trip coverage before claiming migrated support.

Validation checks exact text IDs, visibility, live preset IDs, IN/OUT sides, finite percentages, video bounds, duplicate sides, transition overlap and coverage. Custom animated text and manually special transitions are preserved. The renderer retains captions, fonts, positions, word timing and existing zooms.

Sound assignments use the existing host-owned transition/SFX catalog. Lead-ins and source trims are preserved; unavailable negative lead-in is trimmed at scene start, tails stop at video end, and coincident short audio accents are suppressed. Grow OUT uses the quieter -31.4dB authored Shemi2 example. Other transition gains use existing preset values. Automatic Zoom's separate Whoosh at -35dB is unchanged. Presets without an attached sound remain valid.

Each modified side records its original and applied transition plus semantic reason. Reruns restore only still-owned sides, preserve later manual edits, remove owned SFX even if moved and regenerate without stacking duplicates. Manually inserted clips in a generated audio track survive. Cancellation or a changed source prevents apply. Invalid plans receive one repair attempt, then fail with the timeline unchanged. Undo restores the entire operation.

## Verification

- 75 native timeline tests passed, including seven feature tests for preservation, IN/OUT placement, sound timing/gain/bounds, rerun restoration/idempotency, manual edits, live-catalog rejection, excessive density and atomic rejection.
- WASM build passed; all 21 required exports verified.
- Skill structure and generated runtime projection validated.
- Live Automatic Transitions run on Short8 succeeded: 10 texts, 6 companion sounds, 33% coverage. Selected Subtitle Snap, Drift Left, Push Down OUT, Push Right and Slide Up. Reasons connected burdensome study imagery, a painful-thought handoff, a real benefit list and the final call to action. Full-source comparison preserved all original words/params/timings/video/audio/zooms. One Undo restored all original tracks and project settings exactly; the test was undone rather than applied to all eight projects.
- Targeted ESLint has no errors; one existing AI chat type-assertion warning remains. TypeScript has no errors in the feature files; unrelated repository errors remain.

This is an editorial starting point for human review. Preview frames and transcript are not full vocal-emotion analysis. No export or batch automation is triggered by this feature.

## Authorized eight-short application

Following user approval, Automatic Transitions ran successfully on all eight SHIRASHEMI shorts. 71 accented text elements, 50 companion sounds; coverage 31.4–38.7%. All 221 text elements now have bottomFadeOut=0.6 and bottomFadeOutEndOpacity=0.25. Persisted project audit verified source clips, word timing, font/position parameters, existing zooms and audio preserved. One double space was normalized in Short1 by the canonical source pipeline. Full results and project links are in SHIRASHEMI-EDIT-REVIEW.md. No export.
