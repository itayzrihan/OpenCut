---
name: visual-teaser-editing
description: Design and implement reference-led visual editing for teasers and speech-led shorts, using semantic B-roll, motion graphics, typography, comparisons and changes of state aligned to dialogue. Use for visual pacing and word-to-visual choreography, including Hebrew/RTL. Does not replace source selection or authorize new paid generations.
---

# עריכה ויזואלית

Make meaning visible through actions and changes of state. Build visuals around the selected speech and the user's identity; do not cover a weak narrative with unrelated fast-moving stock footage.

Read [the detailed reference analysis](references/visual-editing-analysis.he.md) before a substantive visual pass. It includes the full timeline, actual stills, frame-level glitch timing, approximate reveal/counter timing and a bounded spatial measurement. Observed durations are reference evidence, not mandatory settings for every project. Do not claim knowledge of the reference's software, easing curves, fonts or asset-generation method.

## Inspect the target and preserve its context

Use the existing project and user's chosen framework. In OpenCut/POCUT, inspect native state and capabilities before building external layers. For a new standalone video/composition, follow the installed video workflow entry point and its renderer contract. An analysis-only request produces analysis; it does not silently edit or render a project.

Inspect actual frames across the selected output, including transition moments. Classify existing captions as editable, burned-in, absent or mixed. Stream metadata alone cannot identify burned-in captions. Retain source audio and accepted content selections unless a change is requested. Keep source Main/transcript/captions intact; visual and caption changes belong to the output Sequence.

## Make a semantic visual ledger

For each output beat record: output time, source-word/phrase reference, information being conveyed, main object, before state, action, after state, caption treatment, subject-safe placement and entrance/hold/exit timing. Use output clocks after condensation, with source clocks retained for traceability.

Choose the mechanism before choosing an asset:

- Transfer or autonomy → show who gives an object/control to whom, followed by its consequence.
- Growth or volume → accumulate items or update the same verified metric, then make the decisive value dominant.
- Quantity → reveal/count the actual number of objects; retain their identities across turns.
- Comparison → two states of the same person/object, or matched candidates under the same metric.
- Passage of time → change lighting, environment or clock within a recognizable world.
- Negation or failure → change the relevant state: activity switches off, fill empties, an option disappears.
- Analogy → establish place and action, then show the consequence that explains the analogy.

An icon for every noun is insufficient. Prefer a clear verb and transformation. Label illustrative dashboards/AI imagery where needed; do not fabricate apparent evidence or change the spoken units.

## Choreograph three different clocks

Separate entrance time, readable settled hold and exit/transfer. Fast entrances can be several frames while the meaning stays visible much longer. The reference's 0.100-second glitch changes a person to a robot; most viewing time occurs after the glitch settles. Its 5-second question holds show that purposeful stillness is also pacing.

Align the decisive state to the relevant word or phrase. An entrance may lead slightly when setup is necessary; the reveal should land on the concept, number, contrast or negation. Do not use one fixed lead/lag for every word. Avoid measuring speed from the distance between different objects. When comparing movement, track the same object and report duration, displacement, scale and preferably frame-width/height-normalized velocity. A settling-phase measurement is not the whole-transition speed; average velocity is not peak velocity or a recovered easing curve.

Use a small family of motivated transitions. State-change transitions (human→robot, night→day, lit→dark) differ from focus transfers (workers→window, shop→street). Retain object identity and scene geography when they carry understanding. Simple cuts at speaker changes often read better than repeated glitches. Motion blur belongs in the movement phase, not continuously across text that must be read.

## Compose for the actual frame

Keep faces, hands, microphones and meaningful objects visible. Let one item dominate each moment. Carry context in a smaller secondary phrase only when needed; emphasize numbers, claims and turning words in larger type. Place text from the actual footage rather than imposing an above-head template on every shot.

Use the user's brand palette. From the reference, transfer the function of color: one emphasis color, neutral context and a distinct warning treatment. Do not copy its creator watermark, personalities, episode claims or statistics. Do not assert an exact font/HEX value from compressed pixels.

Set Hebrew-led copy to RTL and isolate English/numbers where needed; inspect rendered punctuation. Keep essential text legible at phone size after it settles. Tiny dashboard fields can be texture but cannot carry necessary facts. Separate complete accessibility captions from editorial emphasis when both are requested, and avoid competing duplicate captions over burned-in text.

## Build in the owning runtime

Reuse native crop/reframe, typography, masks, split-screen, keyframes and asset capabilities where they meet the design. For named effects or external motion layers, follow the installed framework's registry/core/animation contracts. Keep typography and graphics editable where practical; do not flatten text just to simulate motion.

In OpenCut, mutations target explicit output project/scene/revision through canonical capabilities. Never trim Main around a teaser, regenerate its captions as a finishing step or introduce an independent UI state store. For external seekable layers, use deterministic output timing and the host-compatible import route. If the output changes, remap visual timing from the new ledger; do not reuse stale source seconds.

## Verify the actual result

Inspect settled states and entrances/exits, not only posters. Review without sound for readable comparisons/negations, and against the selected dialogue for synchronization. Check object continuity, transitions, face/caption collisions, Hebrew punctuation, number/quantity agreement and reading holds at phone size. Verify final duration including CTA and preserve the source scene/captions and earlier outputs.

Report what was authored, applied, saved and rendered. If a check is unavailable, narrow the affected claim rather than inventing measured motion, audio effects or source provenance. For a 60-second request, reserve closing time within 60; the supplied 65.4-second reference is not a duration template to copy unchanged.
