# Premium edit quality gates

An edit is not complete when operations exist on a timeline. It is complete
when rendered frames, timing, and audio pass the following checks.

## Preflight

- Project, scene, resolution, fps, and range are correct.
- Spoken transcript has been corrected without losing word timing.
- Every designed phrase maps to actual spoken words or a clearly labeled proof
  artifact.
- Face, eyes, mouth, hands, microphone, and key props have been mapped.
- Existing captions and burned text have been identified.
- The beat sheet declares rail, emphasis, hero, proof, connector, and drop
  roles.
- Effect, transition, media, font, and graphic ids came from live catalogs.

## Timeline structure

- Mutations target the explicit project and expected revision.
- Related edits were staged atomically.
- No accidental audio exists on duplicate video layers.
- Caption pages do not overlap in the same region unless intentional.
- The main video has no unintentional gaps or overlaps.
- Full-screen layers start and end on meaningful boundaries.
- Undo restores the complete logical edit in one step when appropriate.

## Three-frames-per-second visual review

For each consecutive sample, ask:

1. Did a word appear before it was spoken?
2. Did the active word disappear before it could be read?
3. Did more than two ordinary lines appear?
4. Did the same entrance repeat mechanically?
5. Did any opaque element cover the face, eyes, mouth, or real captions?
6. Did a strike, underline, or shape cover unrelated content?
7. Did a word preload on a full-screen card?
8. Did a layer pop because its first or final state was undefined?
9. Did a duplicate cutout drift or halo?
10. Did the composition stay essentially unchanged too long?

Classify failures by timecode and repair the smallest responsible element.

## Required key-frame checks

Capture and inspect:

- exact frame zero;
- first meaningful word;
- every hero's pre-entry, proof pose, hold, exit, and handoff;
- every full-screen entry and return;
- every subject-depth composite at start/middle/end;
- each fast hand gesture or foreground crossing;
- final-minus-hold;
- exact final frame.

## Typography

- Ordinary captions use one or two lines.
- Every line break follows phrase meaning.
- Active and inactive words remain distinguishable at mobile size.
- Text contrast survives the brightest and darkest sampled backgrounds.
- Annotations leave the underlying word readable before modifying it.
- No word is hidden behind a face unless that occlusion is a deliberate,
  readable depth effect.
- The last or isolated word gets enough visible resting time, using safe
  pre-roll before extending the semantic beat.

## Rhythm

- No 3-8 second passage consists only of identical caption swaps.
- Strong changes are separated by quieter holds.
- Effects are attached to meaning, gesture, proof, or audio.
- A 15-20 second information-dense passage uses at least three visual modes.
- Consecutive hero devices do not compete.
- The opening does not hide the performance at frame zero.

## Audio

- Dialogue remains the loudest semantic source.
- Duplicate video audio is disabled.
- Music and SFX do not mask consonants.
- SFX land on the intended frame and do not accompany every motion.
- Cuts do not create clicks, truncated syllables, or unnatural breaths.
- Listen once at normal speed and once with music/SFX muted.

## Preview/export parity

- Preview capture and export use the same composition time and state.
- Unsupported effects fail explicitly rather than silently changing the look.
- Fonts, media, masks, and alpha assets resolve in both paths.
- Compare exported frames against approved preview frames at every inspected
  timecode.

## Pass condition

All blocking defects must be fixed:

- hidden face or captions;
- incorrect transcript;
- preloaded or missing spoken words;
- more than two ordinary lines;
- matte drift/halo;
- unsupported or mismatched export effect;
- accidental duplicate audio;
- frame-zero cover;
- mechanically dead 3-8 second region.

Minor aesthetic observations may remain only when they are documented and do
not violate the user's direction.

