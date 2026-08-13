---
name: paper-grid-editorial
description: "Paper Grid Editorial template skill for reference-driven, transcript-native OpenCut edits. Use when applying or recreating this template's Hebrew talking-head grammar: portrait speaker cuts, one-word captions, paper-grid Speaker Frame Breakout, RTL checklist proof UI, semantic red rejection, synchronized SFX, matte-safe compositing, and frame-by-frame quality control."
---

# Paper Grid Editorial

Build the edit from speech, performance, and reference evidence. Treat text as timed visual material, not a subtitle layer placed on top after the edit.

## Non-negotiable contract

- Preserve meaning. Use the corrected verbatim transcript as the timing and copy source. A designed paraphrase may support it, but must not replace or contradict spoken words.
- Preserve the opening performance. Do not cover the subject from frame zero. Keep the first 0.3–0.8 seconds visually continuous unless the reference and narrative explicitly require a cold-open card.
- Keep ordinary captions to one or two lines. Use three or more only for a deliberate, separately designed hero composition that passes a reading-time check.
- Give every displayed word its own timing. Never time two transcript words as one token.
- Keep the face readable. In every rolling 300ms window, leave at least 30% of the face unobstructed. Do not place a card over the eyes or mouth merely because a geometric safe zone is empty.
- Make full-screen cards transcript-native. If a card hides the footage, it must reveal the currently spoken words in sync, not show unrelated copy while suppressing the real caption.
- Earn every effect from a word, clause, gesture, proof point, emotional turn, or musical beat. Decoration without a semantic job is a defect.
- Avoid dead zones. In premium short-form, create a perceptible editorial change roughly every 0.4–1.5 seconds, while varying intensity. A change may be an active-word state, crop, cut, diagram build, annotation, B-roll, SFX, or depth reveal—not necessarily a new full-screen card.
- Treat the Kallaway-derived look as this user's default house style when the
  brief does not conflict: a one-active-word rail, black/white copy selected
  from the actual background, a nearly invisible soft lower text shadow, and
  the native `editorial-edge-feather` across the top and bottom 20% of
  photographic footage. Colored copy is a scarce semantic event.
- Keep hero devices scarce. Use at most one promoted hero treatment per thought block and never let consecutive heroes flatten each other.
- Duplicate visible text only when the transcript repeats it or a comparison explicitly needs multiple copies. Give every copy a distinct semantic role, interval, position, or state; overlapping identical layers without that distinction are a defect.
- Detect speech gaps on the dialogue source or a VAD-derived speech stem. A mastered mix with continuous music is not valid evidence that speech has no removable gaps.
- Verify painted pixels and audible output. Timeline structure alone is not proof.
- Search saved `ui_elements` before authoring product-style proof objects. A
  novel native UI asset must include complete motion/settings and be saved for
  reuse; an orphaned one-off is a defect.

## Workflow

### 0. Plan the edit against real capabilities

Planning is the first deliverable, not an optional preface.

1. Read the live capability registry, catalogs, project state, selected range,
   canvas, fps, transcript, and relevant preview frames.
2. Write a capability-aware edit plan before staging mutations. Include:
   narrative beats, transcript intervals, visual mode, subject protection,
   canvas/world coordinates, camera route, depth planes, transitions, sound,
   asset source, and the exact OpenCut operation that will create each result.
3. Mark every planned beat as `native`, `saved asset`, `HyperFrame`, or
   `capability gap`. Do not pretend an unknown effect or operation exists.
4. When a capability gap blocks the intended edit, develop the smallest
   reusable OpenCut feature through the canonical runtime, add tests and
   catalog/agent exposure, reload live capabilities, and only then resume the
   edit. Never create a second editor state store or a one-off transport tool.
5. Present the plan for review when the user asked to collaborate on the edit;
   otherwise retain it as the internal execution contract and verify the final
   timeline against it.

The plan may evolve after preview evidence, but the agent must always know
which product capability owns each visible result.

### 1. Inspect before designing

1. Read project, media, canvas, fps, timeline, transcript sources, selections, and current playhead through the live OpenCut capabilities.
2. Capture representative preview frames. Identify the face, hands, props, microphone, negative space, existing burned text, crop risk, and background brightness.
3. Transcribe when needed. For a local reference file, run `scripts/transcribe_reference_video.py`, then correct ASR text while preserving word start/end timing.
4. If the user provides a reference, run `scripts/analyze_reference_video.py`. Read its labeled contact sheets, `frames.csv`, `transitions.json`, and `analysis.md`.
5. Read:
   - `references/editorial-grammar.md` for beat and caption decisions.
   - `references/compositing-depth.md` when foreground isolation, text-behind-subject, or duplicate-video depth is useful.
   - `references/hyperframes-remotion-synthesis.md` before authoring complex motion.
   - `references/quality-gates.md` before applying or exporting.
   - `references/lmsme-preview-first-minute.md` when learning from the analyzed LMSME reference.
   - `references/minimal-product-ui-assets.md` when creating compact UI proof
     objects, metrics, messages, alerts, search, progress, files, or reusable
     product-style motion assets.
   - `references/virtual-camera-canvas.md` before any pan handoff, parallax
     scroll, dolly-through, oversized-world tour, or speaker-on-canvas scene.
   - `references/video-mp4-full-analysis.md` when learning the credible AI-edited talking-head, proof-overlay, and CTA-handoff grammar.
   - `references/i-recorded-three-times-full-analysis.md` when learning numbered-argument, intentional-repetition, nested-proof, semantic-color, or loop-ending grammar.
   - `references/kallaway-day1-full-analysis.md` when learning a white-grid
     proof stage, synchronized frame-breakout speaker, semantic UI morphs,
     evolving checklists, typed-comment CTA, or full-speaker/proof-stage rhythm.
   - `references/hebrew-reference-project-profile.md` when the current project
     is the user's Hebrew `השראה` reference or when transferring its exact
     portrait breakout, RTL checklist, caption-contrast, and cue timing grammar.

Do not author effects until the narrative map, visual occupancy map,
capability map, and—when camera emulation is used—world-coordinate map exist.

### 2. Build a transcript role map

Assign every word or phrase one role:

- `rail`: ordinary verbatim caption; carries most speech.
- `emphasis`: a meaningful word highlighted inside the rail.
- `hero`: a scarce peak promoted into large kinetic type or depth composition.
- `proof`: a claim that needs a screenshot, number, quote, diagram, logo, or B-roll.
- `connector`: language that visually bridges two beats.
- `drop`: filler intentionally omitted from display while audio remains unchanged.

For each thought block, record:

- exact word interval;
- emotional function;
- chosen visual mode;
- subject visibility requirement;
- entrance verb and exit/handoff;
- SFX or music cue, if earned;
- proof asset, if required.

Use the transcript timing as the single clock.

### 3. Choose an editorial rhythm

Declare a rhythm string before editing, for example:

`speaker+rail → word build → proof card → speaker punch → diagram → quiet hold`

Use at least three visual modes during any information-dense 15–20 second span:

- clean speaker with rail;
- reframed speaker or punch-in;
- kinetic transcript typography;
- proof/B-roll;
- diagram or icon build;
- subject-depth composite;
- restrained full-screen card.

Do not repeat one entrance on every caption. Keep a dominant grammar for coherence, then introduce controlled variation:

- 60–75%: primary rail behavior;
- 15–30%: semantic emphasis variants;
- 5–15%: hero or depth events.

When the script promises numbered reasons, steps, or takes, preview the route
and keep one stable chapter/progress grammar. Let each number own a different
evolving proof metaphor. Do not reset into unrelated generic captions at every
number.

### 4. Author captions as timed choreography

- For this user's house style, start from one active word per page. Use two or
  three words only for a fast semantic unit; use two visual lines
  occasionally, and more than two only for a separately designed semantic
  hero. For other requested styles, 2–6-word phrase pages remain valid.
- Keep line breaks semantic: noun phrases, verb phrases, contrast pairs, or deliberate escalation.
- Reveal the active word from its exact word timing. Preserve whitespace and reading order.
- Use per-word, per-row, or per-line animation based on meaning:
  - certainty: snap/lock;
  - contrast or negation: cut, erase, cross-off after the word remains readable;
  - growth: assemble, count, expand;
  - doubt: drift, soften, fragment;
  - inspiration: lift, open, reveal;
  - list: ordered stagger into stable positions.
- Never draw a strike-through before the word can be read.
- Never let an annotation cover unrelated text, the face, or the complete frame.
- For a final or isolated short word, use available pre-roll without overlapping the prior word: start its entrance at `max(previousWord.end, word.start - preRoll)`. Do not solve readability by extending the layer beyond the spoken beat when an earlier entrance is possible.
- Hold a readable resting state after the entrance. The last frame is part of the animation.

Prefer native OpenCut caption/text elements for editable rail copy. Use HyperFrames for treatments native text cannot express.

### 5. Build semantic visuals

Choose visuals from the spoken concept:

- people or identity → subject, portrait, silhouette, relationship lines;
- comparison → split state, scale, mirrored columns, directional transfer;
- money or metrics → tabular numbers, count-up, chart, proof capture;
- process → diagram, path, stack, pipeline;
- criticism or negation → readable terms entering separately, then selective reject/erase;
- transformation → foreground/background depth, wipe, morph, reframe;
- place → map, location word, coordinate treatment;
- trust → proof artifact before decorative claims.

Integrate graphics with the photographed scene. Use walls, desk planes, negative space, depth, and subject occlusion. Avoid floating centered cards when the background provides a better anchor.

For a product-UI proof object, search `ui_elements` first and load the exact
preset. If the semantic object is genuinely new, use the native `ui-element`
graphic with explicit entrance, event, hold, exit, duration, and editable
content/style parameters. Include `saveAsUiElement` metadata in the reviewed
`insert_graphic_element` operation so the approved preset is persisted in UI
Elements and becomes available to future catalog searches. Read
`references/minimal-product-ui-assets.md` for the full contract.

### 6. Use depth when it improves the message

For text behind the subject:

1. Duplicate the same source clip with identical timing, trim, rate, and crop.
2. Keep the opaque base below.
3. Place semantic text/graphics in the middle.
4. Enable background removal on the upper duplicate and keep only its foreground subject.
5. Disable duplicate audio on the upper copy.
6. Sample alpha and sync at multiple frames; reject halos, one-frame drift, or missing held objects.

Read `references/compositing-depth.md` for fallback and safety rules.

For a speaker whose head or upper body must cross a small video's top edge, use
`create_speaker_frame_breakout`. It inserts one smart timeline layer above the
source video. At render time that layer derives the transparent foreground,
cropped rounded base, opaque `paper-grid` stage, and exact internal layer order
without exposing duplicate clips in the timeline. Do not reconstruct this
effect from loosely timed duplicates. Read
`references/kallaway-day1-full-analysis.md` for geometry, synchronization,
alpha, and verification gates.

Set `startTime` and `duration` when the breakout belongs to one designed beat
rather than the complete source clip. The smart layer resolves the nearest
visible video below it at every frame and leaves that source untouched as the
only dialogue track. Background removal is manual: place and resize the layer
first, then select it and run Apply. After timing, source, or matte changes,
run Reapply before preview approval or export.

The selected Backgrounds preset is rendered as a full-canvas stage, so Paper
Grid and generated backgrounds stay opaque in portrait and landscape projects.
Changing the background, layout, or fade reuses the prepared raw mattes;
changing the source range, retime, quality, threshold, contrast, or temporal
stability requires Reapply.

For camera-emulation scenes, use the native virtual-camera canvas contract:
stage elements beyond the visible frame, assign `camera.depth`, lock
screen-space captions with `camera.locked`, and place one camera movement
effect above the world layers it controls. Use `create_speaker_tile` when the
speaker should live inside the designed world as a rounded frame, shape, or
background-removed cutout. Read `references/virtual-camera-canvas.md`; do not
fake a shared camera move with slightly different unrelated tweens.

### 7. Apply through OpenCut

- Load live capability and catalog metadata; never invent effect or media IDs.
- Stage logically related edits atomically.
- Preserve revision safety and explicit project targeting.
- Keep captions above the main video and below only the overlays that intentionally cover them.
- Make full-screen cards begin after an earned setup and make them word-synchronous.
- Use sound design selectively: one cue per meaningful impact, not per animation.
- Keep dialogue dominant. Music and SFX must not mask speech.
- Search the overlay catalog for `editorial-edge-feather` and Text assets for
  `editorial-feather-white` or `editorial-feather-black` before recreating the
  preferred feather treatment manually. Sample preview contrast before
  choosing the text variant.

### 8. Verify at frame cadence

Before export:

1. Capture three frames per second for every heavily designed section, and at least one frame per second elsewhere.
2. Compare every consecutive sample for unintended jumps, preloaded words, missing captions, face coverage, clipped text, repeated motion, and dead time.
3. Check the exact first frame, every hero entrance, every handoff, final-minus-hold, and exact final frame.
4. Review with audio at normal speed and muted. The edit must work visually without sound and remain intelligible with sound.
5. Run the gates in `references/quality-gates.md`.
6. Fix failures, then repeat the smallest failing inspection.

Only export after the sampled frames and audio pass.

## Reference analyzer

Create a local word-timed transcript when speech is present:

```powershell
python scripts/transcribe_reference_video.py "reference.mp4" `
  --output ".opencut-data/reference-analysis/reference-name/transcript.json" `
  --model small.en --language en
```

The optional transcriber requires `openai-whisper`. Prefer a language-specific
model when the language is known. Treat low-confidence words as review targets,
not truth.

Analyze the complete video by omitting `--duration`:

```powershell
python scripts/analyze_reference_video.py "reference.mp4" `
  --output ".opencut-data/reference-analysis/reference-name" `
  --sample-fps 3 --transcript-json "transcript.json"
```

For a bounded integer-duration range, the command must produce exactly
`duration × sample-fps` frames and one fewer consecutive transition records.
For a full video with a fractional duration, it produces
`floor(duration × sample-fps + 0.5)` frames, matching FFmpeg's nearest-frame
sampling behavior. Inspect every labeled contact sheet,
`scene-cuts.json`, `speech-gaps.json`, `audio-waveform.png`,
`audio-analysis.json`, and transcript alignment. `scene-cuts.json` scans native
frames instead of only sampled frames. `speech-gaps.json` derives candidates
from word timing, so it can expose pauses hidden by music in the mastered mix.
Treat automatic cut, speech-gap, and silence classifications as review
evidence, not semantic truth.

## Completion standard

Do not call an edit premium because it contains many effects. Call it premium only when:

- transcript, typography, visuals, depth, pacing, and sound share one intention;
- ordinary words remain readable and heroes are earned;
- the subject is protected;
- no 3–8 second span feels mechanically repeated;
- every reference-derived technique has been adapted to the new content;
- preview and export match at the inspected frames.
