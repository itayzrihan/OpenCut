# Subject-aware depth compositing

Use this pattern when text, particles, diagrams, or lighting should live behind
the speaker while the original background remains visible.

## Three-layer architecture

From bottom to top:

1. **Opaque base video** - the original clip, including background and its only
   audible dialogue.
2. **Middle design layer** - text, HyperFrame, effect, shape, diagram, or B-roll
   that should appear behind the person.
3. **Foreground duplicate** - the same source clip with background removal
   enabled and audio disabled.

The base and foreground clips must share:

- source media id;
- timeline start;
- duration;
- source in/out points;
- playback rate and retime curve;
- crop, scale, rotation, and perspective;
- any frame-dependent stabilization or reframing.

Do not rely on visual similarity. Compare their canonical timing and transform
fields before rendering.

## Speaker frame breakout

When the speaker must remain inside a small rounded video while the head crosses
its top edge, use one smart timeline layer that renders four internal roles
rather than the ordinary manual three-layer text-behind-subject stack:

1. background-removed foreground render;
2. cropped rounded base render;
3. opaque stage background;
4. original source retained only as the dialogue source.

Use `create_speaker_frame_breakout` to insert the smart layer atomically above
the source. The renderer resolves the nearest visible video below it and shares
one decoded source texture between the framed base and foreground. The default
`paper-grid` background hides the original picture while preserving its audio.
The base mask crops from the top using `height = 1 - cropTop`, allowing the
isolated head to cross a real edge.

For a bounded proof section, pass exact media-tick `startTime` and `duration`.
OpenCut follows the underlying source element's trim and retime mapping while
leaving the audible source unchanged. Place and resize the smart layer first,
then select it and press Apply. Reapply after source, range, retime, or matte
tuning changes.

Treat stage coverage as a hard alpha/compositing gate. Smart-layer backgrounds
render full-canvas in both portrait and landscape projects. Any visible source
strip or duplicate head outside the framed speaker is a failed composite.

Do not use a cutout alone: it lacks the visible framed-body continuity that
makes the boundary break convincing. Inspect alpha and alignment at source jump
cuts, large gestures, hair/microphone edges, and the exact first and last
visible frames. Read `kallaway-day1-full-analysis.md` for the observed geometry
and proof-stage rhythm.

## OpenCut transaction recipe

1. Read the target clip and its media metadata.
2. Duplicate it onto an overlay track without changing source timing.
3. Disable the duplicate's audio before previewing.
4. Enable background removal on the upper duplicate.
5. Add the middle design element between the two video tracks.
6. Stage the related operations atomically.
7. Capture frames near the start, middle, end, and any fast gesture.

The foreground duplicate should never become an accidental second dialogue
track.

## Matte quality gates

Reject or simplify the effect when any sampled frame shows:

- a light or dark halo wider than a few pixels;
- hair or fingers disappearing for a frame;
- a held product, microphone, or chair popping in and out;
- timing drift between opaque and cutout layers;
- a one-frame scale or crop mismatch;
- color treatment applied to only one copy when the copies should match;
- foreground edges becoming visibly softer than the base.

If the matte is unstable, use one of these fallbacks:

- place graphics in a real negative-space region beside the subject;
- use a restrained mask or tracked occluder around a stable torso;
- reveal behind a desk, microphone arm, or other reliable foreground object;
- use a shallow side card rather than a full subject cutout;
- shorten the depth event to the stable portion of the shot.

## Text-behind-subject layout

- Keep the main word large enough to read when partially occluded.
- Never hide the only identifying letters of a short word.
- Position text so subject occlusion adds depth but does not destroy meaning.
- Use lower contrast on text portions near edge hair to reduce matte artifacts.
- Avoid thin strokes and small type directly behind hair or fingers.
- Let the text reach a stable pose before the speaker crosses it.

## Duplicate-video variants

The same architecture can support:

- background darkening while the cutout remains natural;
- color separation between subject and room;
- particles or light rays behind the person;
- a diagram passing behind the torso and in front of the background;
- type attached to the wall plane;
- selective blur of the room without blurring the subject.

Do not use a gold glow, halo, or generic aura without a semantic reason. Color
and light must match the scene and the spoken beat.

## Sync verification

At each sampled timestamp:

1. Toggle the foreground duplicate off and on.
2. Confirm the subject boundary does not move.
3. Confirm lips and hands remain exactly aligned.
4. Confirm the design layer disappears only where the alpha foreground covers
   it.
5. Confirm dialogue loudness is unchanged.

For a long section, sample at least every second. For fast gestures, sample at
three frames per second or at the project frame rate around the gesture.
