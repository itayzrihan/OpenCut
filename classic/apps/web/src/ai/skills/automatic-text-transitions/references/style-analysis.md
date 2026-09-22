# Authored transition reference audit

Read-only audit of ten existing local projects on 2026-09-22. No reference project was modified. Counts describe stored transitions, not a claim that every caption has a distinct special accent. The user’s current 30–40% target overrides old example density.

| Project | ID | Texts | IN presets | OUT presets |
|---|---|---:|---|---|
| ניכור הורי | 008a49c6-e4bb-4433-acdb-63e695db9aa3 | 50 | fade: 50 | fade: 50 |
| Shemi 1 | 17e6c641-e4be-442d-9a68-e8d159d6fd3c | 76 | close-focus: 68, push-right: 6, pop: 1, slide-up: 1 | shrink: 76 |
| Shemi2 | 3fcd0688-0f33-494e-8085-25bb0b25ce37 | 79 | fade: 65, push-right: 10, none: 3, dolly-zoom-in: 1 | fade: 75, none: 3, grow: 1 |
| נקמה | 40777b00-3a68-4b2d-bab7-a3578b3db72e | 47 | drift-left: 38, rise-soft: 5, cinematic-glide-up: 4 | fade: 29, slide-down: 18 |
| Galya11 | 8542dcbb-eded-4b11-a214-b694d54782ac | 48 | close-focus: 38, flicker: 10 | shatter: 48 |
| Galya9 | 9b8389ae-ae28-4d71-945a-36fde64ded93 | 40 | prism-snap: 18, subtitle-snap: 12, push-right: 6, hinge-top-pro: 3, pop: 1 | fade: 40 |
| פחד להתגרש | a67dfd6d-6256-4b37-b92e-1e6881fe5ce4 | 34 | fade: 33, slide-down: 1 | fade: 33, push-down: 1 |
| Galya8 | cb03972e-378a-4fc6-b3fd-161f624e8ed8 | 24 | fade: 10, push-right: 9, pop: 2, slide-up: 2, flicker: 1 | fade: 24 |
| Galya12 | e010eb11-a39a-4160-8dab-7e942ba29ae4 | 39 | fade: 30, push-right: 6, pop: 1, none: 1, flicker: 1 | fade: 38, none: 1 |
| Galya10 | e150907f-bd00-4fba-9675-148d639eae5b | 46 | fade: 24, push-right: 16, pop: 6 | fade: 46 |

Semantic examples are embedded in SKILL.md so every button request receives them. The full live transition registry is supplied each time, including labels, keywords and sound-equipped sides. This prevents the reference subset from becoming a closed list.

Existing companion bindings: Push Right / Slide Up → Whoosh End (0.35s anticipation); Pop → metal slice (0.53655s anticipation); Flicker → trimmed click (0.124875s anticipation); Grow OUT → authored swoosh (0.186225s anticipation). Other catalog presets remain eligible without sound. Grow uses the quieter -31.4dB authored Shemi2 level for this automation; other pairings retain their existing preset gains. The separate Automatic Zoom -35dB policy is unchanged.

The motion renderer already reverses native recipes for OUT. This feature reuses that renderer and does not implement another transition engine. No inference of audible emotion is made from silent preview frames; direction is based on wording, timing, and visual context.
