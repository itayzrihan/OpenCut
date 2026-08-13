# AI-edited talking-head reference: complete 51.84 seconds

Use this reference to design a credible creator-led edit that demonstrates AI
editing without burying the speaker under constant effects. It is a useful
counterweight to the denser LMSME reference: the middle stays deliberately
human, while proof overlays and full-screen typography appear only when their
message earns them.

## Evidence

- Source: `video.mp4`, SHA-256 recorded in the generated manifest.
- Format: 720x1280, 24fps, H.264, 51.84 seconds, stereo AAC.
- Visual review: all 155 samples at 3fps and all 154 consecutive sample
  transitions.
- Native-frame scene scan: 2.375, 7.750, 8.042, 14.708, 29.417, a rapid
  41.792-41.958 burst, and 42.625 seconds.
- Transcript: local `small.en` Whisper, 26 segments, 188 timed words, mean word
  probability 0.942, checked against the burned captions.
- Audio: integrated RMS -14.2 dBFS; decoded peak +2.2 dBFS; five master-mix
  silence intervals totaling 1.45 seconds at <= -42 dBFS for >= 0.1 seconds.

The decoded peak above 0 dBFS is a warning that the master is too hot. Match the
energy, not the overshoot.

## Corrected transcript

> This entire video was edited by AI. Yep, that's true. I even picked this
> classic banger of a song. Everything from the captions, zooming, effects,
> anything that you see in this video is entirely edited by the AI. Let me show
> you how it works. So I just woke up, he did some research, figured out what to
> post, what I should talk about, and then I talk about it. And then I attach
> the SD card right here into my computer and he fetches the content, edits it,
> color grades it, does everything, and that's it. And then it's done, he even
> posts them for me. So instead of spending 30 minutes every single day, 40
> minutes, an hour, two hours, whatever it might be on editing, do like me, wake
> up, record, be as raw and authentic as possible, send the videos to your AI
> assistant and focus on what matters, and that's building your business. So if
> you wanna... All right, I'll take it from here. Want this for your business,
> your brand, whatever you're building, just comment Karl and he'll send it
> over to you.

## Complete editorial map

| Time | Visual treatment | Editorial job |
| --- | --- | --- |
| 0.000-2.260 | Standing close-up with handheld microphone; bold white lower-third phrase captions. | Open on performance and state the impossible claim immediately. |
| 2.375-4.080 | Hard cut to white. Small centered serif text builds “Yep, that's true.” | Use tonal contrast and negative space as a credibility reset. |
| 4.360-6.240 | Serif sentence builds word by word: “I even picked this classic banger of a song.” | Tie the visual build to the music joke instead of adding unrelated motion. |
| 6.240-7.750 | The sentence blurs back; a rounded fire message and rising fire emoji stack take focus. | Convert “banger” into one literal, playful proof event, then hold it. |
| 7.750-8.160 | White-to-footage handoff through a short transition cluster. | Return to the speaker before the explanatory middle. |
| 8.160-11.820 | Seated speaker. A rounded three-row checklist builds boxes, checks, then labels: effects, zooming, captions. | Turn a spoken list into an ordered UI proof without covering the face. |
| 11.820-14.620 | Checklist exits; ordinary phrase captions carry “edited by AI” and “let me show you how it works.” | Lower visual intensity before the workflow explanation. |
| 14.708-16.320 | Jump/reframe to a wider seated performance; simple captions. | Signal a chapter change using camera grammar, not a new card. |
| 16.400-19.000 | Search field appears above the speaker with the query “what should I post?”; suggestions populate below. | Make research and ideation concrete through familiar UI. |
| 19.000-20.040 | Search UI clears while speech returns to ordinary captions. | Hand control back to the speaker before physical proof. |
| 20.120-23.180 | The speaker holds the real SD card toward camera; captions remain simple. | Let the prop be the hero. Do not compete with it using another graphic. |
| 23.180-29.320 | Longest clean talking-head run; phrase captions follow fetch, edit, grade, and post actions. | Maintain trust and pace through delivery, gestures, and restrained jump cuts. |
| 29.417-33.260 | Similar-angle jump cut. A top rounded counter counts editing time from roughly 30 minutes toward one minute while a cyan progress ring collapses. | Visualize time savings as one evolving proof object; suppress redundant captions. |
| 33.260-41.640 | Counter exits. Lower-third phrases carry the recommendation to wake up, record, stay raw, send to the assistant, and focus on business. | Keep the advice personal and human after the quantitative proof. |
| 41.792-42.625 | Rapid reframes bring the speaker toward camera as “if you wanna...” trails off. | Create a visible takeover boundary for the CTA voice. |
| 42.625-43.980 | Fade through the speaker into white; thin black type builds “All right, I'll take it from here.” | Turn the AI itself into the CTA speaker without needing a character. |
| 44.620-46.280 | “Want this for your business, your brand” builds through scale and gray-to-black emphasis. | Start broad, then stabilize the offer. |
| 46.900-49.260 | “Whatever you're building” becomes the large center phrase; a social comment mockup enters below as “comment Karl” appears. | Pair the requested action with an immediately recognizable interface. |
| 49.760-51.333 | “And he'll send it over to you” completes above the held comment proof, then the composition fades. | Resolve the CTA in a readable resting pose before exit. |

## Timing and pacing model

- The speaker occupies roughly 37 seconds, about 72% of the video.
- Full-screen white typography occupies roughly 14.5 seconds, about 28%.
- The main 34.5-second seated section uses three proof overlays totaling about
  nine seconds: checklist, search suggestions, and time counter.
- Ordinary transcript pages usually carry one short phrase for 0.7-1.6
  seconds. The median ASR segment is 1.6 seconds.
- The transcript contains 17 pauses of at least 0.1 seconds, but the mastered
  music bed lets threshold-based silence detection find only five, all before
  4.35 seconds.
- Strong cut clusters are scarce. The edit relies more on performance,
  caption-page changes, proof builds, and a few chapter cuts than constant
  angle switching.

## Visual system

### Speaker footage

- Preserve the teal wall, warm doorway, dark sweater, and warm skin contrast.
- Use reframes at chapter boundaries and on gestures; avoid continuous
  mechanical zoom pulsing.
- Keep the physical microphone and SD card legible. They are trust-bearing
  props.

### Caption rail

- Use bold white geometric sans type with restrained shadow/outline.
- Place it on the lower torso or lower third, never over eyes or mouth.
- Reveal phrase pages rather than animating every ordinary word.
- Allow the speaker's delivery to provide motion during the long middle.

### Proof overlays

- Build controls in semantic order: container, rows, state, then labels.
- Anchor overlays in negative space: checklist near the lower side, search
  above the shoulder, time counter above the head.
- Keep one proof object alive long enough to decode. Update its internal state
  instead of replacing it with several cards.
- When a real prop enters, remove competing synthetic proof.

### Full-screen typography

- Use a serif for the playful early aside and a thin modern sans for the CTA.
  The typeface change marks a narrative role change.
- Accumulate words into a stable sentence. Fade old words toward gray while the
  active phrase resolves in black.
- Reserve large scale for “business,” “whatever you're building,” “Karl,” and
  the delivery promise.
- End on a complete, still-readable composition before fading.

## Audio and silence lesson

Do not run silence removal against the mastered reference and conclude that
speech is continuous. The music bed masks later speech gaps. For a new edit:

1. Detect gaps on the original dialogue clip or a separated dialogue stem.
2. Use VAD/word timings to protect breaths, plosives, and sentence intent.
3. Treat 0.1-0.2 second gaps as rhythm decisions, not automatic deletions.
4. Rebuild the music bed after ripple cuts.
5. Keep the final master below clipping while preserving the reference's
   energetic dialogue-forward balance.

## Transfer rules

1. Start with the human and the claim; do not open on a generic title card.
2. Use one playful full-screen reset early, then return to proof and
   performance.
3. Let each UI overlay prove the exact clause being spoken.
4. Rotate proof modes: list, search, physical prop, metric, then social action.
5. Keep roughly two-thirds or more of a trust-driven creator edit anchored on
   the person unless the user's reference demands denser motion design.
6. Make the CTA feel like a handoff, with a clear visual and vocal boundary.
7. Hold the final action and its proof together; never make the viewer remember
   a CTA after the relevant UI has disappeared.

## Limits of the reference

- The 20-29 second passage is intentionally sparse and can feel repetitive in
  a denser premium brief. Add only semantically earned variation.
- The time counter communicates benefit but is not literal proof unless its
  numbers come from real product data.
- The final white CTA is long. Shorten it when retention evidence or platform
  constraints favor a faster close.
- Do not copy “comment Karl,” the fonts, colors, or exact UI. Reuse the
  narrative functions and timing relationships.
