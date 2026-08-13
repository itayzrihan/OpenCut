# Kallaway day-one reference: full 10 fps analysis

Use this reference when a talking-head edit needs a clean editorial proof stage,
small synchronized UI metaphors, or a speaker whose head breaks beyond a framed
video boundary. Transfer the grammar to the current message; do not imitate a
creator's surface style blindly.

## Contents

1. Evidence and limits
2. Macro rhythm
3. Second-by-second motion review
4. Time-coded construction
5. Frame-breakout technique
6. Nested motion and transition blueprints
7. Caption, feather, and color grammar
8. Reusable UI assets
9. Sound, planning, and delivery gates

## Evidence and limits

The analyzed source is 65.482125 seconds, 720 × 1280, 23.976 fps, with stereo
44.1 kHz audio. The analyzer extracted 655 labeled samples at 10 fps and
measured all 654 consecutive sampled transitions. Native-frame scene scanning
found 14 cuts. The word-timed transcript contains 256 words in 31 segments.

The inspection covered every 10 fps sample through 34 contact sheets, plus the
native-cut report, transition metrics, waveform, spectrogram, speech gaps, and
word alignment. Ten samples per second reveal entrances, exits, morphs, and
short overshoots, but they are not a substitute for native-frame verification
at final delivery.

Audio evidence:

- integrated RMS: approximately -14.04 dBFS;
- measured peak: approximately +2.46 dBFS in the decoded float signal;
- continuous music/low-frequency energy means the mastered mix contains no
  valid silence windows below -42 dBFS for 100 ms;
- word timing still exposes 43 speech gaps totaling about 9.88 seconds;
- many hard visual changes coincide with broadband transient peaks.

Use the dialogue source or VAD-derived speech stem for silence decisions. Never
conclude that speech has no gaps because the mastered music bed is continuous.

## Macro rhythm

The film alternates between two stable modes:

1. full-screen speaker with a concise word or phrase rail;
2. a white-grid proof stage with the speaker framed at the bottom and designed
   evidence occupying the negative space above.

The proof-stage intervals are approximately:

- 09.7–18.8;
- 22.9–27.6;
- 32.5–36.2;
- 41.3–56.3;
- 61.8–65.48.

This gives the audience a reliable visual home while allowing each proof object
to evolve. Major mode changes happen roughly every 4–9 seconds. Micro changes
inside a mode happen much more frequently through active words, checks, type,
icon changes, or diagram motion.

## Second-by-second motion review

This table is the explicit review of all ten 100 ms samples in each second.
Times describe visible motion, not only transcript timing. “Rail” means the
ordinary spoken caption; “proof” means the designed object above the speaker.

| Second | What the ten samples show | Motion, text, and transfer rule |
| ---: | --- | --- |
| 00–01 | The first `This` begins defocused, resolves by about 00.2, then yields to `entire`; the older word lifts and ghosts above the active word. | Start on the human. Use a 200 ms blur-to-sharp settle and vertical word relay; never preload the whole hook. |
| 01–02 | `video`, `was`, `edited`, and `by` occupy the center one at a time or in a tiny stack. The newest word is lowest and sharpest. | Ordinary copy is usually one word. Preserve earlier copy only as low-opacity motion memory, with strict reading order. |
| 02–03 | Around 02.1 the final rail hands off into a bright vertical color gate. White/green panels open and orange `CLAUDE`, then `CODE`, reveal through a horizontal mask. | A hero begins before the last ordinary word has become visually stale, but does not overlap unrelated words. Use mask width, blur, and grade as one coordinated entrance. |
| 03–04 | The orange `CLAUDE CODE` hero reaches its resting pose over full-screen footage while the speaker continues. | The entrance is short; the hold carries the read. A hero does not need continuous pulsing. |
| 04–05 | The orange hero remains stable while the performance and hand movement supply motion. | Let live action animate the frame. Do not add a new device merely to satisfy a timer. |
| 05–06 | The orange words begin separating laterally. At about 05.9 a green successor enters between them, briefly sharing the same motion field. | Treat the title change as a semantic handoff: outgoing halves become the reveal mask for the next title. |
| 06–07 | `DAY ONE` settles with a small overshoot; a small subtitle starts assembling below it. | Animate hierarchy in order: hero first, explanation second. The subtitle must not compete during the hero’s arrival. |
| 07–08 | The subtitle completes as `RECREATING OTHER EDITORS' STYLE`; title and subtitle hold in a stable two-level lockup. | Build internal text progressively, then stop. Readability is the final animation state. |
| 08–09 | The hero softens and ordinary white rail words return: `showing`, `how`, `easy`, then the short functional phrase leading into Claude Code. | Crossfade designed type back to the rail. White type gains a broad, faint lower shadow on footage. |
| 09–10 | Full footage transforms into the proof stage over roughly 300 ms: white grid opens, source scales into a low rounded frame, and the isolated head rises beyond its top edge. A `Today` pill sharpens above. | This is one synchronized wipe/scale/mask/cutout transition. Never cut to an already completed breakout composition. |
| 10–11 | The white stage holds. The pill changes from `Today` toward the creator name while black rail words sit in the gap above the head. | Switch to near-black copy on a light stage. Keep one small context object and one caption; do not fill all negative space. |
| 11–12 | The context pill resolves to `Kallaway`; a proof card enters from above with scale/blur and settles over the speaker. | Container entrance precedes internal proof. Keep the speaker visible as the trust anchor. |
| 12–13 | The proof card rotates through new labeled states, passing through visible diagonal angles before returning upright. | Rotate one persistent object to signal state change. Use about one semantic state per spoken clause, with overshoot and recovery. |
| 13–14 | Another short rotation/tilt sequence resolves into the next proof label; the same card remains spatially anchored. | Motion continuity comes from object identity. Reuse the container instead of spawning unrelated cards. |
| 14–15 | The card morphs into a curved workflow path. The curve draws first; a dot/arrow then travels along it. | For process proof, reveal topology before traversal. The viewer must understand the path before the marker moves. |
| 15–16 | Labels appear sequentially along the route while the moving marker advances with the explanation. | Nest animation: route reveal → marker travel → label arrival → readable hold. |
| 16–17 | The path resolves into a smaller `Niche`/topic relationship diagram while the frame-breakout speaker stays perfectly synchronized below. | Morph the evidence while preserving the stage and speaker. One stable context can host several proof states. |
| 17–18 | The topic diagram holds while short black phrases explain face, screen, and lower-frame placement. | Use one-to-three-word rail groups when grammar requires them; keep all copy clear of the eyes. |
| 18–19 | The proof completes on “bottom,” then the composition returns to full-screen speaker around 18.9. White captions and the dark edge feather return. | End dense proof on a readable state, then provide a human reset. |
| 19–20 | Full-screen rail advances through `how`, `Kallaway`, `likes`, and `it`; the framing remains clean. | A single active word is enough when delivery and gesture are strong. |
| 20–21 | `apparently` resolves, followed by a performance jump cut and the start of the next thought. | Hide same-angle cuts inside phrase boundaries; preserve the global edge treatment to soften discontinuity. |
| 21–22 | Short phrases carry “as you can tell / this editing / style” on the full speaker. | Combine two or three words only when they form one fast semantic unit. |
| 22–23 | `very simple` begins as rail copy, then the proof stage wipes in. A tiny blurred capsule expands into a black rounded pill reading `very simple`. | Promote the exact thesis by moving it into a container, not by duplicating it in two equal layers. |
| 23–24 | The pill finishes scale, width, and rotation settle while black rail words continue beneath it. | A compact thesis object may remain pinned while the spoken qualification changes below. |
| 24–25 | The black pill holds. Rail words progress through “same time / if you / are,” mostly one short group at a time. | Let the persistent object supply continuity; keep the rail sparse. |
| 25–26 | The rail reaches “no editor / if you don’t know / motion”; the pill remains readable and unchanged. | Do not animate the proof object on every noun. Save its event for the decisive word. |
| 26–27 | On “motion graphic / it’s hard,” the wide pill rotates and shrinks into a small lock icon, then expands slightly into a stable lock capsule. | Use a semantic morph: `simple` becomes `locked/hard`. Shape, rotation, and icon state move together in about 300 ms. |
| 27–28 | The lock holds briefly, then blurs/fades while the stage dissolves back to the full speaker. | Exit proof before changing mode. Do not leave a ghost UI object over the returning footage. |
| 28–29 | Full-screen rail words carry “but / this / content / series”; the subject remains the only major visual object. | Use a quiet performance beat after an icon morph. |
| 29–30 | `showing / exactly / how` progresses as centered white copy with subtle lower feather. | Caption timing follows speech; no sentence-sized card is needed. |
| 30–31 | `you do this / type of` uses short phrase groups while the speaker gestures. | Prefer semantic chunks over arbitrary fixed word counts. |
| 31–32 | `style / and / I’m / going to` continues on footage, preparing the next demonstration. | Keep visual intensity low during setup language. |
| 32–33 | Around 32.5 the white proof stage opens again; a tiny gray ellipsis capsule appears above the breakout speaker and sharpens to dark. | Use a working-state seed to motivate the stage transition. Container entrance, icon state, and speaker reframe share one ease. |
| 33–34 | The ellipsis capsule holds while black rail copy says `showcase / how`. | A quiet working indicator can coexist with the rail if it is small and stable. |
| 34–35 | Rail expands briefly to `you can create`, `anything`, and `that you`; the capsule remains unchanged. | Allow two or three words when they form a promise, but retain one visual line. |
| 35–36 | The capsule widens and its dots morph into the result `anything.`; it then blurs and lightens toward exit. | Resolve waiting state inside the same container. Result text replaces dots; it does not appear as a second floating label. |
| 36–37 | The stage and capsule finish fading by about 36.3; full-screen footage returns with `want / to create / content`. | Let the outgoing blur bridge into the darker photographic grade. |
| 37–38 | White one-word rail moves through `for / personal / branding / your`. | Strong cadence can use isolated words without becoming unreadably fast when each arrives slightly before its acoustic peak. |
| 38–39 | `your / business / if you / sell` follows the hands and sentence rhythm. | Keep high-information nouns crisp; group only low-stress connector words. |
| 39–40 | `sell / info / products / whatever` continues while the subject turns. | The performer supplies directional motion; captions stay screen-locked. |
| 40–41 | `you do / revolves / around / content` completes the full-screen thought. | Finish the clause before the next proof-stage transition begins. |
| 41–42 | At about 41.3 the white stage opens and a dark `Testing editors` task chip enters with a checkbox and cursor/hand cue. | Introduce the readable task first. Interaction state must not arrive before its label can be decoded. |
| 42–43 | A red reject/strike state sweeps across the task while the spoken rail says wasting money/testing. The chip itself stays anchored. | Animate the verdict inside the object: cursor/check → red line/reject → hold. |
| 43–44 | The rejected task remains visible through `editors / and / testing`, then starts losing opacity and sharpness. | Keep rejection visible long enough to connect it to the cost claim. |
| 44–45 | The task chip blurs out; the stage remains. Rail words carry `and / failing / whatever it might`. | Clear the proof but preserve the spatial mode so the emotional title can inherit the canvas. |
| 45–46 | The ordinary rail resolves `be`; tiny `Be the` begins high in the proof area and `CREATIVE` rises/sharpens underneath. | Enter the semantic headline at the identity turn. Small setup type precedes the large identity noun. |
| 46–47 | `DIRECTOR` joins below `CREATIVE`, then `yourself.` appears as the small closing line. Rows arrive separately with blur-rise and a very small settle. | Build hierarchy as four nested arrivals: qualifier → CREATIVE → DIRECTOR → personal resolution. |
| 47–48 | The complete headline holds while ordinary black rail continues below with “plug into Claude Code.” | The designed headline may support the spoken thesis without replacing the word-timed rail. Give the hero a full readable second. |
| 48–49 | The headline progressively blurs and fades from about 48.5 while the speaker rail moves through “automate the editing / and then we’re done.” | Exit all headline rows as one grouped object after their independent entrances. |
| 49–50 | The upper stage clears. A tiny dark sparkle square appears and gains contrast while the rail says `so / yeah`. | Seed the next proof from one semantic icon. Do not pop in a finished large checklist. |
| 50–51 | The sparkle square grows horizontally and vertically into a dark rounded card; the title `Everything you see.` appears after the container has shape. | Container expansion → title reveal. Motion belongs to one nested component tree. |
| 51–52 | The first row `Motion graphics` appears with an empty circle, then confirms while the rail names motion graphics. | Add and confirm a row on the matching spoken concept. Keep previous rows stable. |
| 52–53 | `Colour grading` is added beneath the first row and receives its own state. | Reuse spacing, icon size, and stagger. Internal consistency makes the UI believable. |
| 53–54 | `SFX` joins as the third row; the card reaches a complete three-line resting state. | The final row completes the proof, after which the card should stop animating. |
| 54–55 | The full checklist holds while the rail says it was custom-created for the video. | Hold proof through the claim it substantiates. Do not remove it immediately after the last check. |
| 55–56 | The card remains stable through “specific video,” then begins a broad blur/fade near 56.0. | Use one grouped exit; do not peel off rows in reverse unless the narrative calls for subtraction. |
| 56–57 | The card and white stage dissolve; the source scales back to full frame around 56.4. White rail resumes on `by Claude Code`. | Match the reverse transition to the entrance, but allow the proof to blur away before the speaker fills frame. |
| 57–58 | Full-screen captions carry `now / I’m / creating / this`. | Begin CTA setup with the human, not with another widget. |
| 58–59 | `this / releasing / so / if you want` progresses in one- and two-word pages. | Let connective phrases group; keep important action words isolated. |
| 59–60 | `to be in / the loop / you might never` moves across the full speaker. | Two- or three-word groupings are allowed when needed to keep fast speech readable. |
| 60–61 | `you might never / see me again / hit` progresses; the performer points toward the viewer. | Preserve the physical CTA gesture. Graphics should enter only after the gesture establishes direction. |
| 61–62 | `the / follow / button` leads into another white-stage wipe near 61.8. A social comment bar enters from a small blurred state. | The app-like CTA appears exactly when the requested action is spoken. |
| 62–63 | The comment bar is fully dark; profile, field, and typed `Kallaway`/reply state populate inside while the speaker remains in the bottom tile. | Build social proof in semantic order: account → field → keyword → reply/confirmation. |
| 63–64 | A heart/confirmation state appears. The completed card holds, then blurs and fades by about 63.9 while `send you the whole` continues. | Confirm the action once, hold briefly, and clear the upper field before the final countdown. |
| 64–65 | White stage and breakout speaker remain without competing proof. Rail copy advances through `breakdown / in / three`; the hand moves toward lens. | Let the physical closing gesture become the final motion graphic. |
| 65–65.48 | `two / one` completes as the hand reaches camera; the image cuts to black shortly after 65.3. | End on the real gesture and exact spoken count. Do not append a redundant logo card. |

## Time-coded construction

|       Time | What changes                                                               | Transferable construction                                                                             |
| ---------: | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
|  00.0–00.3 | Defocused opening resolves into the first word                             | Begin with a 200–300 ms blur/focus or scale settle; do not preload the complete sentence              |
|  00.3–02.3 | White transcript words stack; older words ghost upward                     | Keep only the current word fully crisp; preserve exact word order and timing                          |
|  02.3–03.1 | Vertical split/wipe reveals orange `CLAUDE CODE`                           | Promote one semantic noun into a hero and let the previous word build hand off into it                |
|  03.1–05.5 | Full-screen speaker; orange hero rests                                     | Entrance is short; the resting pose carries the read                                                  |
|  05.6–06.3 | Orange words separate laterally while green `DAY ONE` replaces them        | Morph one semantic object into the next instead of clearing and rebuilding the frame                  |
|  06.4–09.6 | Green hero plus progressively built subtitle                               | Use clear hierarchy: one hero, one restrained explanation                                             |
|  09.7–10.1 | Full-screen footage becomes a white-grid stage and speaker tile            | Treat the mode change as a 200–400 ms spatial transformation, not an arbitrary cut                    |
|  10.1–11.2 | Faux browser/history pill reads `Today`, then `Kallaway`                   | A tiny UI object can establish context while captions remain centered above the speaker               |
|  11.3–14.0 | Proof card enters and rotates through labeled states                       | Keep one proof object and update its state; use mild rotation and overshoot                           |
|  14.0–18.8 | Curved process path and then a topic diagram evolve                        | Prefer an evolving diagram over unrelated card spam; animate a point/arrow along the spoken process   |
|  18.9–22.8 | Return to full-screen speaker                                              | Give the face a clean reset after a dense proof section                                               |
|  22.9–26.3 | Grid stage with black `very simple` pill                                   | Use the upper negative space for one compact thesis                                                   |
|  26.3–27.6 | Pill rotates/shrinks into a lock                                           | Make the same object change semantic state on the word `hard`                                         |
|  27.7–32.4 | Full-screen speaker with phrase captions                                   | Lower the visual intensity before the next proof                                                      |
|  32.5–35.1 | Grid stage with a typing/ellipsis capsule                                  | Show the tool's working state while the claim builds                                                  |
|  35.1–36.2 | Capsule resolves to `anything.` and exits through blur                     | The result replaces the waiting state in the same visual container                                    |
|  36.3–41.2 | Full-screen speaker                                                        | Another clean performance interval                                                                    |
|  41.3–43.8 | `Testing editors` task appears; cursor checks it; red reject state follows | Keep the label readable before check/strike; time the negative state to the spoken rejection          |
|  45.7–48.7 | `Be the / CREATIVE / DIRECTOR / yourself.` builds line by line             | Use a single kinetic headline at the emotional peak; each row rises, sharpens, then rests             |
|  49.8–50.7 | Sparkle square expands into a dark card                                    | Grow a small semantic seed into the next proof container                                              |
|  50.7–56.0 | Feature checklist adds Motion graphics, Colour grading, SFX                | Reveal rows on speech and confirm them sequentially; do not show all checks early                     |
|  56.4–61.7 | Full-screen CTA setup                                                      | Return to the human before asking for action                                                          |
|  61.8–63.7 | Social comment card enters; `Kallaway` types; heart confirms               | Let the CTA keyword type on its spoken letters and give the completed action one visible confirmation |
| 63.7–65.48 | Card blurs away; final count and hand-to-lens close                        | Use the physical gesture as loop closure instead of adding another graphic                            |

Native scene cuts occur near 03.128, 09.718, 09.760, 11.345, 13.972,
18.852, 20.812, 22.940, 27.694, 32.491, 36.286, 41.291, 56.390, and
61.770 seconds. The adjacent 09.718/09.760 detections are evidence of a
multi-frame transformation, not two narrative cuts.

## The frame-breakout technique

The head-out-of-frame result is a synchronized composite, not a special crop.
Build it from this top-to-bottom display order:

1. **Foreground cutout** — a background-removed duplicate of the speaker;
2. **Framed base** — a second duplicate inside a rounded mask, with its top
   cropped down into the upper torso;
3. **Stage background** — an opaque, very subtle white grid;
4. **Original source** — hidden visually by the stage but retained as the only
   dialogue source.

Captions and proof objects sit above the speaker in the upper negative space.
They may be higher than the foreground cutout when intentionally covering it,
but ordinary copy should not cross the eyes or mouth.

### Exact synchronization contract

Both visual duplicates must preserve:

- the same media asset id;
- start time and duration;
- trim in and trim out;
- rate, retime curve, and maintain-pitch state;
- position, scale, rotation, crop, and camera-depth values;
- any time-remapping or source-local animation needed to keep the body aligned.

Disable audio on both duplicates. A one-frame timing mismatch, different scale,
or different crop origin will expose a seam at the mask boundary.

For a normalized mask whose full height is `1`, cropping the top by `cropTop`
uses:

```text
height  = 1 - cropTop
centerY = cropTop / 2
```

Start around:

- `cropTop`: 0.18–0.28;
- `scaleX/scaleY`: 0.62–0.76 for a vertical canvas;
- speaker center Y: low enough that shoulders cross the frame boundary;
- corner radius: 0.06–0.12;
- border: none or 1–2 px when the background needs separation;
- grid intensity: 8–16%;
- upper proof occupancy: approximately 55–65% of frame height.

OpenCut exposes this as `create_speaker_frame_breakout`. The default operation
inserts one smart timeline layer. Its renderer derives the cropped base,
transparent foreground, `paper-grid` stage, and exact display order from the
nearest video below while sharing one source texture. Place and resize it
first, then press Apply to prepare the person mattes; Reapply after source,
timing, or matte changes.

### Alpha and crop gates

Inspect hair, hands, microphones, cables, glasses, and motion-blurred edges.
Check at least:

- the first frame after the stage transition;
- the largest head movement;
- any hand crossing the top edge;
- one frame before and after every jump cut in the source;
- the last visible frame of the stage.

If background removal chatters, reduce the breakout height, feather only the
foreground edge, choose a cleaner frame interval, or fall back to a fully
framed tile. Do not ship a halo merely because the concept is attractive.

## Nested motion and transition blueprints

The strongest transitions are not a single property animation. They are
coordinated systems whose children begin at different instants but share a
motion intention.

### Color gate into `CLAUDE CODE`

From roughly 02.1–03.0:

1. the ordinary word rail clears upward;
2. a bright vertical division opens at the center;
3. the photographic grade lifts toward pale green/white around that division;
4. `CLAUDE` reveals orange through a horizontal mask;
5. `CODE` joins only after `CLAUDE` is legible;
6. the bright gate recedes while the two-word title settles over footage.

Build it as one parent transition with child mask, grade, line, blur, and title
channels. A white flash followed by an unrelated title is not equivalent.

### Orange title into green chapter

From roughly 05.6–06.3, `CLAUDE` and `CODE` travel outward while `DAY ONE`
enters the space they vacate. For one or two samples both states coexist. That
brief overlap communicates replacement. Use a shared center and matched
velocity; do not fade the old title completely before moving the new one.

### Full speaker into frame breakout

The mode change at 09.7, 22.9, 32.5, 41.3, and 61.8 combines:

- white-grid reveal;
- source scale-down and low-frame placement;
- rounded base crop;
- background-removed foreground rise;
- caption color change from white to near-black;
- proof seed entrance shortly after the stage has enough shape.

Drive those operations from one 200–400 ms transition interval. The head must
cross the new frame boundary continuously; it must not pop into transparency
on the last frame.

### Nested UI object contract

Every reusable proof object follows this order:

1. **seed** — icon, pill, dot, or compact shape establishes meaning;
2. **container entrance** — scale/blur/mask creates the object’s footprint;
3. **internal reveal** — title, rows, path, or field becomes readable;
4. **semantic event** — check, reject, type, morph, or traversal matches speech;
5. **rest** — completed state holds without decorative motion;
6. **grouped exit** — parent blur/fade/fold clears the complete object.

Children may animate inside a stable parent. On exit, group them unless the
story explicitly describes dismantling. This “animation inside animation”
distinction is what makes the proof feel designed instead of like layered
stickers.

### Why `Be the CREATIVE DIRECTOR yourself.` becomes the hero

The phrase is the film’s identity transformation: it converts the preceding
pain (`testing editors`, wasting money, failing) into agency. It is short,
imperative, emotionally positive, and visually distinct from the surrounding
workflow details. Those traits earn the only large multi-row semantic headline.

The spoken/ASR wording around 45.3 seconds is imperfect (`creator, director`),
while the designed headline resolves the intended role as `CREATIVE DIRECTOR`.
That is a valid semantic correction because the ordinary word-timed rail still
carries the speech and the hero does not invent a different claim. Use the same
selection test on new scripts:

- Is this the thesis or identity change?
- Can it be expressed in four or fewer short rows?
- Does the surrounding section provide at least one second of readable hold?
- Is it stronger than every other candidate in the thought block?

If any answer is no, keep the phrase in the ordinary rail.

## Motion grammar

The reference uses a small vocabulary consistently:

- **entrances:** 200–400 ms blur-rise, scale settle, lateral reveal, or container
  expansion;
- **rest:** long enough to read the object after it becomes sharp;
- **event:** a check, strike, type completion, icon morph, or route movement
  synchronized to one spoken verb or noun;
- **exit:** 200–500 ms blur, shrink, fold, or handoff into the next object;
- **overshoot:** mild and usually limited to the first 80–150 ms after arrival;
- **mode transition:** full speaker ↔ proof stage, used as a structural edit;
- **micro transition:** active word, row, check, or diagram state, used inside a
  stable mode.

Do not make every element slide from the same side. The repeated identity comes
from stable geometry, typography, restrained color, and semantic morphs.

## Caption grammar

- Ordinary speech uses one word most of the time, centered in the safe gap
  above the speaker.
- Use two or three words only when they form one fast grammatical unit such as
  `you can create`, `see me again`, or `the follow button`.
- Two visual lines are occasional and deliberate. More than two lines belongs
  only to a scarce semantic hero such as `Be the / CREATIVE / DIRECTOR /
  yourself.`, never to the ordinary rail.
- The active word is the strongest state; previous words may soften or drift,
  but reading order must remain clear.
- Hero type is reserved for `CLAUDE CODE`, `DAY ONE`, and `CREATIVE DIRECTOR`
  scale ideas.
- Sentence-sized cards are avoided.
- A UI proof object never replaces the spoken caption when the object does not
  contain the current words.
- The final word receives enough entrance pre-roll without overlapping the
  prior word and then rests visibly before exit.

### Preferred edge and type treatment

The photographic sections use a soft black inner feather at the top and
bottom. It is not a radial vignette: each horizontal edge influences roughly
20% of frame height, remains strongest at the edge, and dissolves smoothly
toward the center. Its job is to unify the grade and protect white captions
without looking like a visible gradient layer.

OpenCut exposes it manually and to the agent as:

- catalog preset: `editorial-edge-feather`;
- native effect type: `editorial-edge-feather`;
- defaults: `intensity: 38`, `height: 20`, `softness: 78`,
  `color: #000000`.

Apply it above photographic talking-head layers by default for this house
style. Reduce intensity when hair or hands touch an edge. On a clean white
proof stage, reduce or omit it when it muddies the intended white field.

The active caption uses no obvious outline. White copy on footage receives a
large, low-opacity black shadow displaced slightly downward; black copy on a
white stage receives an even fainter lower shadow. This produces the requested
minor “feather under the letters” without making the text glow.

Manual text assets:

- `editorial-feather-white`: white, bold, shadow `#00000052`, blur `18`,
  offset Y `5`;
- `editorial-feather-black`: near-black, bold, shadow `#00000024`, blur `14`,
  offset Y `4`.

Choose black or white from the actual preview under the word, not from a fixed
scene label. Reserve colored text for rare semantic heroes, chapter identity,
or one meaning-bearing keyword. If color does not communicate a role, keep the
copy black or white.

## Reusable UI assets

Three native presets capture the transferable object grammar and are saved in
the UI Elements catalog with their own entrance, event, hold, exit, colors, and
duration:

- `editorial-feature-checklist` — sequential features and checks;
- `editorial-reject-task` — readable task followed by a red reject event;
- `editorial-comment-reply` — typed comment keyword CTA.

Search saved UI Elements before creating variants. If a new object is needed,
start from the nearest preset, adjust editable copy/style/timing, and save the
complete result through `saveAsUiElement`. Never save only a static appearance
without its motion settings.

## Sound grammar

- Keep one continuous music bed for propulsion, but use dialogue/VAD evidence
  for pause editing.
- Add a transient only to meaningful visual events: major stage change, icon
  morph, check/strike, checklist completion, or CTA confirmation.
- Smaller typography changes can use subtle ticks, whooshes, or no sound.
- Avoid one sound per word.
- Leave mastering headroom; the analyzed reference's decoded peak exceeds
  0 dBFS, which is evidence to improve rather than imitate.

## Planning recipe

Before staging edits, map each transcript beat to:

| Beat     | Mode                  | Proof object               | Speaker state      | Caption state     | Event           | Sound           |
| -------- | --------------------- | -------------------------- | ------------------ | ----------------- | --------------- | --------------- |
| Hook     | full speaker          | none                       | large/clean        | active-word build | hero handoff    | optional impact |
| Context  | proof stage           | browser/pill/diagram       | frame breakout     | short bridge      | state morph     | light UI tick   |
| Claim    | full speaker          | none                       | full frame         | phrase rail       | punch-in        | none            |
| Evidence | proof stage           | evolving checklist/diagram | frame breakout     | short bridge      | check/path/type | one earned cue  |
| CTA      | full then proof stage | comment reply              | full then breakout | exact CTA words   | typed keyword   | confirmation    |

Select `native`, `saved asset`, `HyperFrame`, or `capability gap` for every
object. Prefer the native frame-breakout operation and saved UI presets.
Develop a missing reusable feature before pretending it exists.

## Delivery gates

- One and only one audible speaker source.
- Foreground and base remain frame-exact through every source cut.
- The base crop intersects the body naturally; it must not amputate the chin.
- The cutout visibly crosses the rounded frame boundary.
- The paper grid remains subtle and does not alias or dominate compression.
- Proof objects live in the negative space and do not fight captions.
- Every UI object has a readable resting pose and a complete exit.
- Checks, strikes, typing, and icon states happen after the relevant copy can
  be read.
- No unexplained duplicate word, card, or speaker layer is visible.
- Preview and export match at the same inspected frames.
