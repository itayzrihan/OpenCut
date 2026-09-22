# AutoCut AutoZoom research — 2026-09-22

Primary sources:
- https://knowledge.autocut.com/en/article/what-are-the-autozooms-settings-11racdj/
- https://knowledge.autocut.com/en/article/what-are-the-different-zoom-styles-in-autozoom-nulhaj/
- https://knowledge.autocut.com/en/article/what-are-the-adjustment-layers-created-by-autozoom-rw6kv5/
- https://www.autocut.com/en/blogs/how-to-add-automatic-zooms-in-premiere-pro-with-autocut/

Documented: rhythm from Very Calm through Hyperactive (Moderate default); mandatory cut trigger plus optional speech, emotion and meaning triggers. User controls maximum scale and anchor. Jump Cut is immediate; Smooth animates in/out; Snap-in animates entry then holds. Styles can mix. Separate adjustment layers leave original clips intact and affect lower layers, while upper captions stay static. Sounds can differ by style/direction and can be imported. Optional handheld movement exists.

Not public: exact AI algorithm, semantic scoring, numerical durations, amplitudes, easing curves or randomization. We do not claim those were recovered.

Our implementation choices: semantic planning from full Timeline Source, timed transcript and sampled preview frames; four styles including an explicit pull-out; smoothstep easing; 1.04–1.30 scale; 0.6–4.5s duration; 0.35s separation; 65% maximum coverage and one event per three seconds on average. Silence microcuts are not all zoom triggers, to avoid visual chatter. No handheld motion or Overlay Movements. Swish assignment is deterministic for strong snap/jump events, uses an existing authored excerpt, and is independent of AI. These are OpenCut editorial defaults to evaluate with the user, not AutoCut's proprietary constants.

User-approved refinement (2026-09-22): both Snap In and Jump Cut end with a gradual eased return, including legacy zero-release events. Smooth remains unchanged. Automatic sharp accents use soundreality-whoosh-end-384629 at -35dB, assigned by the host. These are intentional OpenCut choices, not claims about AutoCut internals.
