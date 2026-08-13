# HyperFrames and Remotion synthesis for OpenCut

This reference combines the transferable design and timing principles from the
official HyperFrames and Remotion skill repositories. Adapt concepts to
OpenCut's live capability catalog; do not paste third-party project code into a
timeline blindly.

## Shared principle: time is the source of truth

Every rendered pixel must be a deterministic function of:

- project time or local clip time;
- project frame rate/time base;
- serialized element state;
- stable assets and fonts.

Scrubbing backward, seeking directly to a frame, previewing, and exporting must
produce the same visual result.

## HyperFrames model

Current HyperFrames guidance centers on a paused, seekable GSAP timeline. The
runtime owns time and seeks the animation to the requested frame. Important
consequences:

- animations must be finite;
- initial, proof, hold, and final poses must exist at arbitrary seek points;
- no animation may depend on wall-clock playback or a previous frame having
  rendered;
- entrances and exits need explicit resting states;
- the exact final frame must preserve the intended end state;
- motion should be authored as semantic beats rather than one global tween.

When OpenCut's installed HyperFrame adapter exposes only a subset of the
upstream runtime, inspect the live authoring contract and use only its supported
timing mechanism. Do not assume browser scripts execute merely because
upstream HyperFrames can host GSAP.

## Remotion model

Remotion expresses motion from an explicit frame number and composition fps.
Transfer these habits:

- convert word timestamps to frame intervals deterministically;
- drive values with explicit interpolation;
- clamp values outside the intended range;
- prefer ease-out for entrances and ease-in for exits;
- use a deliberate cubic-bezier or spring configuration instead of defaults;
- measure text before committing line breaks;
- render active-word states from token timing, not phrase-level guesses;
- keep transition duration separate from scene duration;
- treat effects, Canvas, WebGL, and DOM overlays as one frame-addressable
  composition.

## Mapping to OpenCut

| Need | Preferred OpenCut representation |
| --- | --- |
| Editable ordinary captions | Native captions/text with token timings |
| Simple opacity/position/scale motion | Native keyframes |
| Per-word/per-row designed type | Native token animation when available; otherwise HyperFrame |
| Diagram, SVG, complex kinetic scene | HyperFrame or registered graphic capability |
| Text behind subject | Base video + design + background-removed duplicate |
| Rough highlight, circle, underline, strike | Progress-driven SVG/Canvas/HyperFrame annotation |
| Proof screenshot or B-roll | Media layer with explicit crop/timing |
| Preview/export parity | Shared compositor and deterministic time |

Prefer the most editable native representation that can express the result.
Use a HyperFrame only when native text/graphics cannot represent the required
motion or composition.

## Caption timing

1. Start with word-level timestamps.
2. Group words into semantic pages, commonly around 2-6 words.
3. Let the page exist long enough to read, typically at least 500ms.
4. Within the page, calculate an active state for each word from its exact
   interval.
5. If a final word is too brief, use unused pre-roll before its spoken start,
   bounded by the previous word end.
6. Never merge two words into one timing token merely to simplify animation.

## Seek-safe motion checklist

- Does the element look correct when seeking directly to the middle?
- Is the 0% pose intentional rather than accidentally visible?
- Is the resting pose held long enough to read?
- Is the final-minus-hold frame correct?
- Is the exact final frame correct?
- Do repeated instances use stable ids and stable ordering?
- Does the motion avoid layout reflow from blur or letter-spacing animation?
- Are font and asset loads deterministic for export?

## Source links

- HyperFrames repository and skill packages:
  https://github.com/heygen-com/hyperframes
- HyperFrames main skill:
  https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/SKILL.md
- HyperFrames design guide:
  https://github.com/heygen-com/hyperframes/blob/main/docs/guides/claude-design-hyperframes.md
- Remotion official skills:
  https://github.com/remotion-dev/skills
- Remotion:
  https://www.remotion.dev/

These links are provenance and further reading. The OpenCut capability registry
remains authoritative for what can be executed in the current app build.

