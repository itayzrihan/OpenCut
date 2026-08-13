# Hebrew reference project profile: `השראה`

This is an observed, user-authored reference edit. It is a style and timing
profile, not a template to copy blindly. Preserve the semantic relationship
between speech, image, and motion when transferring it to another project.

## Master format

- Portrait canvas: `1080 x 1920`, `25 fps`, black project background.
- Final timeline: `36.84 s` (`4,420,800` media ticks; `120,000 ticks/s`).
- One source video, `השראה.mp4`, `1080 x 1920`, source duration `52.906667 s`.
- The edit is a tight talking-head cut: 21 contiguous source-video segments,
  with hard jump cuts and deliberately retained micro-cuts of about `0.14 s`
  to `0.16 s` in the performance.

## Source cut map

Timeline start/duration in seconds:

`0.00/1.17`, `1.17/6.15`, `7.32/1.25`, `8.57/1.48`, `10.05/2.78`,
`12.83/0.14`, `12.97/1.58`, `14.55/1.38`, `15.93/0.16`, `16.09/2.19`,
`18.28/1.78`, `20.06/3.81`, `23.87/2.19`, `26.06/0.85`, `26.91/1.68`,
`28.59/1.05`, `29.64/0.06`, `29.70/4.47`, `34.17/0.77`, `34.94/1.34`,
`36.28/0.56`.

The source clip remains the only audible dialogue source. Overlay/composite
copies are silent. Do not smooth away the short cuts: they are part of the
rhythm and the visual emphasis.

## Caption grammar

- Transcript source has `113` words from `0.00` to `36.824 s`.
- Default caption settings: white accent, punctuation hidden, one row,
  `wordsPerRow: 1`, `spoken-word-keep`, `rise`, `soft-reveal-8`, direction
  `auto`, centered placement.
- Ordinary rail is almost always one word; phrase grouping is reserved for
  fast grammatical units (`שיקשיבו לי`, `מגיע מבחוץ`, `להיות כמוהו`, etc.).
- Ordinary photographic rail: white, bold Arial, `fontSize: 4`, shadow blur
  `50`, black shadow, offset Y `4`, no opaque background or outline.
- The designed white-grid stage switches the rail to near-black, position Y
  `-252`, shadow blur `14`, shadow `#00000024`, offset Y `4`. The switch begins
  exactly at the stage entry word (`זאת`, `15.358 s`) and returns to white at
  `26.848 s`, after the breakout exit handoff.
- Semantic promotion is scarce: `כי` is scaled to `2.4218626`; `מדויק` is
  scaled to `1.4923442` and moved to Y `68.0979`; the final word `האחר` in the
  custom three-line caption uses `fontSize: 6`.
- Custom text moments are deliberate exceptions, not a new default:
  `אני רוצה` at `1.08 s`, Y `58`, with a `zoom-in` exit; and
  `הסתכלתם על ההצלחה / של הבן אדם / האחר` at `29.64 s`, Y `403.349`, with a
  `slide-up` exit.

## Structural visual modes

1. **Full-speaker mode (`0.00–15.358 s`)** — retain the performance, use the
   white rail, and use sparse semantic punches. The opening is a human-first
   reveal with a glowing vertical divider and a 3-second monochrome-to-color
   wipe; do not start with a full opaque card.
2. **Proof stage (`15.28–26.92 s`)** — transition to the subtle paper-grid
   stage, move the speaker into a rounded lower frame, and put the proof UI in
   the upper negative space. The face and microphone remain readable.
3. **Full-speaker handoff (`26.848 s` onward)** — clear the stage, restore
   white captions, and let the performance carry the close with only a final
   restrained camera-flash hit at `36.44 s`.

## Speaker Frame Breakout contract

Observed effect: one `speaker-frame-breakout` layer from `15.28 s` to
`26.92 s`, with the source matte already applied.

- `backgroundPresetId: paper-grid`, preset `grid`;
- stage colors `#F8F8F5`, `#D8DAD5`, `#FFFFFF`;
- grid density `48`, background scale `52`, intensity `12`, seed `7`;
- `cropTop: 0.22`, `cornerRadius: 0.08`;
- `scaleX/scaleY: 0.7`, `positionX: 0`, `positionY: 410`;
- `edgeContrast: 1`, `edgeFeather: 0.5`, `maskThreshold: 0.5`;
- `temporalSmoothing: 0.24`, fade in/out `0.35 s`;
- `matteQuality: precise`, `matteApplied: true`, backend `webgpu`.

The matching stage bridge graphics are short, independent `0.62 s` grid
entrance/exit animations. Entrance starts at `15.358 s`; exit starts at
`26.155 s`. Keep those bridge layers separate from the persistent breakout
effect so the stage does not pop or disappear for a frame.

## Checklist UI event

Observed element: `Cancellation Checklist — RTL`, `20.055–25.68 s`.

- Template `checkbox-list`, RTL direction, right text alignment, Inter;
  label `שלוש דרכים לבטל הצלחה`.
- Rows, in spoken order: `יש לו כסף`, `קנו אותו`, `עשו לו`.
- Base card `#24272A`, text `#FFFFFF`, accent `#D8DBDE`.
- Scale `1.3458452`, position Y `-408.8005`.
- Sequential reveal: item starts `0, 26.19, 36.68`; list rise `36`; item-in
  duration `6`; base opacity `0`.
- Checks are complete before the semantic rejection event. At `79.38%` of the
  element (`24.52 s`), the whole card transitions to `#D92D20` over `6%` of
  the element duration. This is timed to `ביטלתם`, not to a generic beat.
- Exit is `list-blur-zoom-fade`, starts at `91.64%` (`about 25.68 s`), with
  strength `72`; it blurs, fades, and zooms in place—no lateral slide.

## Sound grammar and exact cues

- One continuous music bed, `A Good Man with a Broken Heart`, `-10 dB`,
  `0.00–35.20 s`, no fades.
- SFX are sparse and event-driven: whoosh-end `0.88 s`, sharp-riser `5.48 s`,
  camera shutter `11.08 s` at `-12.3 dB`, and glitch-whoosh `24.80 s`.
- Do not add a sound for every word or every caption transition. Dialogue is
  the master; the cue lands on the meaningful reveal, morph, or rejection.
- Preserve the relative offset between the rejection UI exit and its sound when
  the saved UI element is reused.

## Transfer rules

- Start with the human and exact speech; never preload a sentence-sized card.
- Use the rail for most words, promote only meaning-bearing words, and reserve
  full-screen/proof stages for a semantic change in the argument.
- Use a single synchronized breakout composite, never an unsynchronized cutout
  duplicate. Confirm the matte remains present at source jump cuts and on the
  first/last stage frames.
- In the proof stage, use black captions on the light field and keep the UI in
  the upper negative space. On return, restore the photographic white rail.
- Every reusable UI object must include its entrance, event, hold, exit, RTL
  settings, and relative SFX timing—not just its static appearance.
