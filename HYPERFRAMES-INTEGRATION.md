# HyperFrames integration into OpenCut

## Scope and completion requirements

Branch: `מיזוג-עם-העורך-של-Hyper-frames` (spaces normalized for Git).
Keep the full editor in `classic/` and its existing timeline. Projects must accept
HyperFrames compositions alongside ordinary clips, over them as layers, or alone.
Preserve all existing editing, AI, account, storage, preview and export features.
Improve the existing interface and performance based on measured differences.

This document tracks an ongoing integration. The source import contract below
is implemented; the product integration is not complete.

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| Dedicated branch | Git branch at the canonical repository | Created |
| Study UI, timeline, element model and performance | Source audit, visual comparison, measured baselines | Source audit and three-package capture benchmarks recorded; full interface and live playback comparison pending |
| Lossless source import into existing document | Registry tests, original source roundtrip, native clips unchanged | Implemented for native and Classic documents; registry, real WASM and browser folder flow pass |
| Folder/project import in the full editor | Import from user-selected Brag folder; resources persist across reopen | All eight Brag folders imported through the UI and reopened; the seven-folder sequence retains byte-identical source and 265 copied resources. Interrupted imports now appear in the folder dialog and resume missing copies; real Brag recovery, reopen, finalization deduplication and Undo/Redo are verified |
| Mixed, overlaid and standalone compositions | Existing Classic timeline, live preview and export for all three | Synthetic overlay verified in Classic preview and MP4 between two native image layers; actual Brag/native overlay and two side-by-side occurrences verified in preview; standalone and remaining source coverage pending |
| Editable composition children | Expand/collapse in existing lanes; select, trim, move, source/variable editing and undo | Validated inventory, inspector and expandable rows within existing tracks implemented; rows follow compound placement/trim/split/undo and navigate to their timeline times; per-occurrence visual layer opacity/hide/reset now works through the canonical registry, with saved history and live/capture parity; declared text/style variables now edit one occurrence after runtime preflight; child timing and arbitrary source edits remain pending |
| Full-fidelity playback | GSAP, CSS, media, fonts, nested hosts, generated DOM; seek/trim/speed/audio tests | Official runtime tested on eight Brag projects; up to four live compositions interleave with native layers. Native video and asynchronous Canvas now wait for decoded/drawn frames; trim, 1.5× media speed, repeated/reverse seeks and real Brag video frames pass comparison. Broader GPU, dynamic-media and speed coverage remains pending |
| Export parity | Representative frame and audio comparisons to pinned HyperFrames | Synthetic trimmed overlay and a 14-second mixed Brag/native MP4 verified; native and compound narration have zero measured timing offset; remaining Brag/media comparisons pending |
| Clearer existing UI | Browser review of hierarchy, labels, source status, selection and keyboard behavior | Composition library, resource folders, asset search, compact toolbar, layer inspector, preparation/failure feedback and Fit timeline control implemented; full interface audit pending |
| Faster interaction/playback | Same-machine measurements for real projects and large mixed timelines | Short fixtures reach 27–29 completed frames/s. The four-minute, 220-clip mixed timeline reaches its end without render errors. Bounded surface reuse removes repeated multi-second loads at cuts; reducing unchanged bookmark overlay renders raises measured warm throughput from 25.66 to 27.80 parent renders/s (different observation lengths; details below). Sustained 30 fps, first-load delays and required capture throughput remain open |
| Existing features retained | Feature inventory and applicable Classic/Rust suites plus browser workflows | All 1,018 web tests pass across 223 isolated suites, with browser coverage enabled and zero skips; two AI suites needed an unchanged serial rerun after startup deadlines in the parallel run. Recovery also passes 25 targeted Rust tests; the earlier broader Rust audit passed 232 tests. Test-fixture typing and full interactive workflow coverage remain open |

## Faster PNG capture with verified color and alpha (2026-10-04)

The first attempt to export the full seven-folder Brag sequence exposed slow
PNG capture. The 179.9667-second project uses the existing timeline at
1920 × 1080 and 30 fps. Early 60-frame windows spent 701–1,310 ms per frame
rendering and encoding, while video encoding itself took about 0.26–1 ms.
That diagnostic export was canceled normally at 17%; it produced no final MP4.
Isolated engine measurements identified screenshot encoding as the largest
part of capture time.

The pinned HyperFrames engine disables Chrome's fast PNG path because some
Chrome versions lose partial alpha. OpenCut now enables it only after a probe
in the same capture browser confirms identical decoded RGBA pixels. The tiny,
separate page includes all 256 alpha values and gradient/filter paint. Both
captures must have the expected dimensions and preserve transparent, partial
and opaque pixels. A mismatch, exception, cancellation or two-second deadline
uses the standard encoder. The probe closes its page, including a page that
arrives after cancellation.

This is **Classic-only capture integration**, with no new editor state,
capability or transport. The engine patch adds an option that defaults off;
the adapter selects it after the probe. Rendering still uses sandboxed software
Chrome and the original seek/media synchronization. Faster PNG files can be
larger; the existing ArtifactStore size and retention limits still apply.

An isolated portrait fixture with 227 distinct alpha values decoded identically
with both encoders. Standard PNG capture took 249–296 ms over five samples;
fast PNG took 106–116 ms. File size increased from 568,881 to 1,104,053 bytes.
The WebP candidate changed pixels and was not adopted. Evidence:
`.local/hf-png-codec-probe-20261004.json`.

The imported seven-folder project was rechecked against the original Brag
files and resources before capture. The production adapter captured 37 frames
at the original source dimensions, including late animation, native video and
backward/repeated seeks. All decoded RGBA pixels match the standard PNG
references, and all seven repeated frames match their earlier captures.
Average capture times for these small sample sets are:

| Original Brag source | Standard PNG (ms) | Validated fast PNG (ms) |
| --- | ---: | ---: |
| `brag-vertical/composition` | 423.99 | 192.15 |
| `brag-reference-recreation-v2/composition` | 365.68 | 241.10 |
| `brag-reference-recreation/composition` | 260.99 | 165.63 |
| `brag-output/composition` | 342.56 | 142.86 |
| `brag-reconstruction-2026-10-03/advanced-audio-test-v2` | 131.97 | 80.90 |
| `brag-reconstruction-2026-10-03/composition` | 274.42 | 166.11 |
| `brag-reconstruction-2026-10-03/advanced-audio-test` | 144.27 | 81.03 |

These are 34–58% reductions in sampled capture time, not end-to-end export
speed guarantees. Reports: `.local/hf-brag-full-reference-20261004.json`,
`.local/hf-brag-production-fast-png-reference-20261004.json` and
`.local/hf-production-fast-png-compare-20261004.json`. Seven reference audio
mixes were also rendered for the pending full MP4 comparison. A hardware-GPU
experiment did not consistently improve capture speed and introduced small
color/repeat differences, so production remains on software rendering.
GPU evidence: `.local/hf-gpu-compare-20261004.json`.

The new regression covers color changes, flattened alpha, malformed output,
unavailable/aborted/late probes and the real bundled Chrome. Product TypeScript
and changed-file ESLint pass. Across 223 isolated suites, 1,018 tests pass with
browser coverage enabled and zero skips. The initial parallel run hit startup
hook deadlines in two AI suites; the unchanged suites passed all 78 tests in a
serial rerun. Combined evidence, including both original runs:
`.local/hf-fast-png-regression-verified-20261004.json`.

The full editor MP4 export has been restarted with this capture adapter.
Final video/audio parity remains pending until its output is inspected.

## Bookmark overlay updates during playback (2026-10-04)

The preview parent subscribed to every transport tick whenever bookmark notes
were enabled, including empty timelines. That preference is enabled by default.
The resulting parent updates repeatedly rendered the preview toolbar and
interaction overlay. The parent now selects the active notes through the
existing playback subscription and snapshot equality. An unchanged set of note
objects keeps the same snapshot; entering or leaving a note interval, editing a
note, seeking or changing visibility still updates the displayed overlay.
Parallax retains its per-tick camera subscription.

The extracted `PreviewPanelWithOverlays` remains the editor's actual component.
This is **Classic-only UI rendering work**, with no new document state, history,
MCP capability or transport. Small, opt-in React Profiler spans distinguish the
toolbar and interaction work under the existing `renderPerf=1` diagnostic flag.
The `Render` spans measure actual React work; the `Commit` spans include elapsed
time spent waiting for other work and should not be interpreted as component CPU
cost.

Before the change, representative steady 60-frame windows recorded 124–148
toolbar commits with 2.89–3.09 ms mean React render duration. After the change,
saved warm windows record 60–74 toolbar commits at 0.43–0.99 ms mean duration;
the interaction overlay records only 1–3 commits when it needs an update.

The same 220-clip fixture was measured before and after, with automated tests
stopped during playback. The baseline warm segment rendered 1,895 frames in
73.8475 seconds (25.66/s). The updated editor reached `00:04:00:00`; its retained
warm reports rendered 5,803 frames in 208.7078 seconds (27.80/s), with windows
between 26.47 and 28.82/s, zero errors and a 341.8 ms maximum render. The saved
reports cover timeline frames 939–7199; the browser log buffer had discarded the
first two windows by the final collection. The first, observed earlier, still
took 3,527.6 ms for a cold source render and completed at 10.99/s. This change
does not resolve cold loading. Observation lengths differ, so these measurements
show local improvement rather than a controlled percentage gain or guaranteed
30 fps. They count parent render completions, not native video presentations.

Evidence: `.local/hf-ui-component-profile-before-20261004.json` and
`.local/hf-ui-component-profile-after-20261004.json`. Actual editor checks added
a diagnostic note at one second with a two-second duration: it was visible at
two seconds, absent at `00:00:03:01`, and restored by seeking backward to two
seconds. The note was removed afterward. Evidence:
`.local/hf-bookmark-overlay-ui-20261004.json` and
`.local/hf-bookmark-overlay-review-20261004.jpg`.

The isolated browser regression uses the real preview parent, playback
subscription and bookmark rendering, with doubles for editor stores and
unrelated preview geometry. It covers empty intervals, blank notes, overlapping
and point notes, inclusive ends, backward seeks, visibility, note/color edits,
removal and preservation of Parallax clock updates. It fails against the prior
subscription (five parent renders instead of one), and passes after the change.
This tests camera clock routing, not Parallax geometry. All 1,015 tests pass in
222 isolated suites, with browser tests enabled and no failures or skips
(124.4 s). Product TypeScript passes; changed-file ESLint has zero errors and
one existing project-ID assertion warning. Reports:
`.local/hf-overlay-ticks-before-20261004/summary.json`,
`.local/hf-overlay-ticks-after-20261004/summary.json` and
`.local/hf-overlay-ticks-full-20261004/summary.json`.

## Warm surfaces across long-timeline cuts (2026-10-04)

A four-minute fixture contains 220 clips in the existing timeline: 100
HyperFrames occurrences from five real Brag packages, 40 native videos, 40
titles and 40 images. Every six seconds it changes between one, two, three and
four compositions. The copied packages retain their original fingerprints and
230 resources (33,099,374 bytes). Fixture metadata and creation script:
`.local/hf-long-mixed-fixture-20261004.json` and
`.local/hf-long-mixed-fixture-20261004.mjs`.

The first run exposed repeated multi-second stalls at cuts. The preview keyed
its surfaces only by clip ID and destroyed them as each occurrence ended, even
when the next clip used the same source. The three playback windows completed
8.06, 5.74 and 4.88 parent renders/s; maximum render time reached 6,457.4 ms.
Report: `.local/hf-long-mixed-before-20261004.json`.

Departed occurrences now pause and conceal their surfaces. A later occurrence
can reuse a surface only when its source/layer-edit identity and resource
revision match, then seeks using the new clip's own trim and bounds. Overlapping
copies still own separate surfaces and clocks. Four surfaces can be displayed;
five can be retained in total. The oldest unused surfaces are released before
opening new ones. Five source leases leave the host's sixth session available
for capture and audio preparation. An error from a dormant surface does not
hide the current picture; failure, eviction and project disposal release leases.

This is **Classic-only rendering integration** with no new document, history
or MCP state. It preserves original source files and media. First encounters
still require loading; no speculative preload or media transcode is introduced.

The corrected editor completes the full four-minute timeline: 5,636 parent
renders in 239.982 seconds (23.49/s), with zero render errors and no live
fallbacks. The first 240-frame window includes source loading and completes at
10.30/s, with a 3,346.2 ms maximum render. Subsequent windows range from 22.14
to 27.07/s (24.90/s combined), with a maximum render of 438.3 ms. Browser
inspection confirms five retained surfaces and at most four visible surfaces.
The fixture exercises native video, changing trims, layers and Perspective;
these are parent render completions, not native video presentation counts.
Evidence: `.local/hf-long-mixed-after-20261004.json`.

A replay from the beginning retains the same five delivery surfaces and
completes 2,404 frames in 93.907 seconds (25.60/s), with zero errors and a
384.8 ms maximum render. After Pause and a backward seek to `00:00:01:00`,
all twelve portfolio videos are paused at exactly 1.000 seconds. The thirteenth
video is outside its authored interval and stays paused at zero. Reports:
`.local/hf-long-mixed-replay-20261004.json` and
`.local/hf-long-mixed-paused-20261004.json`. The review screenshot is
`.local/hf-long-mixed-review-20261004.jpg`; after both measurements, only the
first diagnostic title's font size was reduced from 20 to 7 through the editor
so its label fits the canvas. No Brag source was edited.

Regression tests cover gaps, successive IDs, distinct simultaneous trims,
resource and layer-edit changes, dormant/active failures, bounded eviction and
exact lease cleanup. Client tests exercise five pinned sources alongside
capture and audio while enforcing six host sessions and four capture browsers.
The two new regressions fail before the change and pass after it. All 1,014
tests pass in 221 isolated suites with real-browser coverage, zero failures and
zero skips (121.4 s). Product TypeScript, changed-file ESLint and diff whitespace
checks pass. Reports: `.local/hf-warm-cuts-before-20261004/summary.json`,
`.local/hf-warm-cuts-targeted-20261004/summary.json` and
`.local/hf-warm-cuts-full-20261004/summary.json`.

## Continuous native video preview (2026-10-04)

Classic's live surfaces now receive the existing transport's sampled time and
play state. Eligible video compositions use the pinned player's ordinary native
playback between updates. A drift larger than 1.5 source frames triggers a seek;
paused frames still use the exact render path. Each occurrence stops on an
explicit pause, at its trimmed source end, or after 200 ms without parent
updates. An epoch check prevents an asynchronous start from resuming after a
pause. The existing preparation phase also waits for the initial live frame
before starting the shared transport and mixer.

The first seek must finish decoding before native playback starts. A generated
video exposed a failure where the clock advanced but the decoder stayed on its
initial frame if playback began earlier. Starting from an already prepared
frame avoids another seek. Documents with Canvas or internal layer edits retain
the exact per-frame drawing/edit hooks. Native Classic layers, composition
placement and opacity still render through the existing compositor. The child
runtime remains silent; Classic owns audible output.

This is **Classic-only rendering integration**. Playback resources follow the
canonical document and existing transport; no user state, capability or MCP
store is added. Source files and media remain unchanged.

### Paused frame precision

The pinned 0.8.115 runtime tolerates up to 20 ms of native-media drift even in a
forced paused render. After continuous playback, a video could remain just
before an output-frame boundary. The regression reproduces this at source time
0.995 when requesting 1.000 seconds. `runtime-script.ts` tightens the paused
video tolerance to 0.1 microseconds while preserving the runtime's own
trim/rate/loop calculation and its playing-media/audio tolerances. The published
bundle exposes no threshold hook, so this compatibility adapter replaces one
complete pinned statement and rejects missing or duplicate matches. A runtime
upgrade must explicitly revalidate this adapter. Both live and capture prepared
documents use it.

### Verification and measured limits

- The real-browser regression covers a cold start, continuous presentation,
  source trim and 1.5× media rate, lost parent updates, prepared-frame reuse,
  pause during an asynchronous seek, a trimmed end, Canvas/layer-edit barriers,
  reverse seeking and an independently FFmpeg-decoded paused frame. The close
  boundary regression fails before the precision correction and passes after.
  Reports: `.local/hf-continuous-pause-boundary-before-20261004/summary.json`
  and `.local/hf-continuous-pause-boundary-after-20261004/summary.json`.
- Parent-side tests verify cancellation while an occurrence opens, sampled
  transport time, source trim, occurrence bounds and immediate pause messages.
- All 1,012 web tests pass across 221 isolated suites, with browser coverage
  enabled, zero failures and zero skips. Product TypeScript and changed-file
  ESLint pass. Report:
  `.local/hf-continuous-final-regression-20261004/summary.json`.
- A same-machine comparison uses the original twelve Brag portfolio videos,
  parent animation-frame updates and identical three-second playback windows:

  | Live protocol | Presented frames per video | Native seeks per video | Median / p95 acknowledgement |
  | --- | --- | --- | --- |
  | Exact seek on every update | 49 over 3.026 s | 48 | 50.8 / 78.7 ms |
  | Continuous decoding | 90 over 3.008 s | 3 | 11.7 / 16.8 ms |

  These are native presentation observations in software Chrome 152, including
  the stop transition. Acknowledgements measure control completion. Both runs
  remain frozen after pause and match capture pixels exactly on a subsequent
  seek to source time 5. Reports:
  `.local/hf-video-parent-clock-compare-exact-20261004.json` and
  `.local/hf-video-parent-clock-compare-continuous-20261004.json`.
- The existing six-second editor fixture mixes the full 131-resource Brag
  package between a native image and title. UI checks verify native videos
  advance together and stop when Pause is clicked. After the precision fix,
  pausing at `00:00:01:07` leaves all twelve videos at source time 1.233333,
  matching the timeline's frame; they remain paused. Evidence:
  `.local/hf-continuous-ui-paused-20261004.json`. Final six-second UI runs,
  after the automated suites finished, complete 20.88 and 16.02 parent renders
  per second with zero errors. Median render time is 7.9 / 11.6 ms; p95 is
  33.7 / 135.2 ms. Report: `.local/hf-continuous-final-ui-playback-20261004.json`.
  Earlier development runs ranged from about 8 to 27, so performance is still
  variable. The follow-up below measures and corrects two sources of delay.
  Stable 30 fps in the complete editor, long timelines and seeks during
  playback remain open performance requirements. These observations are not
  replaced by the faster isolated result.

### Playback scheduling and resync follow-up

The live protocol now supplies optional diagnostics with `?renderPerf=1`:
parent round-trip time, runtime work, clock drift, continuous updates and
resync counts. Frame acknowledgements still require the matching source and
sequence. Numeric timing samples are checked before recording. The real-browser
test verifies opt-in reporting and that resync counts match actual player seeks.

The first measured runs had no resyncs and median runtime work below 1 ms, but
completed only 23.85 and 19.51 parent renders/s. The preview was scheduling an
extra animation frame after the transport's own animation-frame notification.
It now starts that render immediately, while retaining the existing in-flight
guard and coalescing for other requests. Scheduling alone measured 26.21 and
28.06 renders/s. Reports: `.local/hf-clock-diagnostics-before-20261004.json`
and `.local/hf-clock-diagnostics-immediate-20261004.json`.

A later replay exposed a separate failure: after a stall, the normal seek
paused the runtime clock while the native decoder caught up. That wait created
another clock drift and another seek. Warm resyncs now use the pinned player's
official `seek(time, { keepPlaying: true })` option. The initial paused decode
barrier, immediate pause, source bounds and lost-update lease still apply. A
browser regression inserts a 250 ms paused decode delay during a warm resync;
the old path stops and the corrected path keeps playing without entering that
barrier. Reports: `.local/hf-warm-resync-before-20261004/summary.json` and
`.local/hf-warm-resync-after-20261004/summary.json`.

With both fixes, two six-second runs of the full Brag fixture complete 28.05
and 27.57 parent renders/s with zero errors. Mean transport lag is 3.57 and
2.42 ms. These runs contain no warm resyncs, so the synthetic regression is the
direct evidence for that fix. The paused UI check at `00:00:01:00` leaves all
twelve portfolio videos paused at exactly 1.000 seconds. Evidence:
`.local/hf-warm-resync-final-ui-20261004.json`,
`.local/hf-warm-resync-final-paused-20261004.json` and
`.local/hf-warm-resync-review-20261004.jpg`.

Parent render completion is distinct from native video presentation. A temporary
browser video-quality probe confirmed 163 total frames per portfolio video over
its authored 5.433-second interval in one run, with 0–6 dropped frames per video.
A subsequent resync-heavy run decoded repeated frames, so decoded totals cannot
serve as a presentation-rate benchmark. That temporary probe was removed; its
raw observations remain in `.local/hf-native-video-quality-20261004.json`.
The smaller isolated fixture above remains the direct presentation measurement.
Large mixed timelines and sustained 30 fps still need validation.

Validation after both fixes: all 1,012 tests pass across 221 isolated web
suites with browser coverage enabled, zero failures and zero skips (111.3 s).
Product TypeScript, changed-file ESLint and `git diff --check` also pass.
Report: `.local/hf-warm-resync-final-regression-20261004/summary.json`.

## Cold video capture and seek-performance experiments (2026-10-04)

The shared browser media bridge keeps a `requestVideoFrameCallback` request
pending for each native video. In software Chrome 152, a paused video's first
fast seek could leave its displayed surface on frame zero after `seeked`, even
though `currentTime` and a Canvas copy already contained the requested frame.
This affected the capture/export adapter. Keeping frame presentation observed
fixes the reproduced case without changing media time, adding a playback clock,
or imposing a fixed delay on each frame. The callback runs only when a video
frame is presented; it stops rearming when its element is disconnected.

This is **Classic-only browser rendering integration**. Source assets, the
canonical document, capabilities and MCP contracts are unchanged.

### Verification

- A new browser regression generates an all-keyframe H.264 video and compares
  all twelve native video regions to independent FFmpeg-decoded frames. Four
  fresh browser sessions cover the first seek, forward/reverse seeks, repeated
  frames and hide/reveal. The previous implementation fails this test with mean
  RGB error 23.75 from a stale first frame; the updated implementation passes.
  Reports: `.local/hf-cold-video-regression-before-20261004/summary.json` and
  `.local/hf-cold-video-targeted-20261004/summary.json`.
- Four cold Brag sessions using the local all-keyframe H.264 experiment now
  match live and capture pixels exactly at 4.2, 5 and 8.5 seconds (twelve frame
  comparisons). Before the change, cold first captures differed intermittently.
  Report: `.local/hf-video-cold-fixed-brag-20261004.json`.
- The full isolated web regression passes all 1,010 tests in 219 suites, with
  browser coverage enabled, zero failures and zero skips. Report:
  `.local/hf-cold-video-full-regression-20261004/summary.json`.
  TypeScript and changed-file ESLint pass. The rejected experiments involving
  fixed presentation waits, extra animation frames and repeated native seeks
  are not part of the implementation.

### Performance experiment limits

All-keyframe media copies remain local experiments; no proxy generation or
substitution is enabled in the product. The original Brag files are untouched.
Lossless VP9 copies increased median sequential seek acknowledgement from
44.1 ms to 199.4 ms in the profiled software-browser runs, so that option was
rejected. With the final fix, identical sequential-seek harnesses measured:

| Portfolio media | Median acknowledgement | p95 acknowledgement | Twelve files |
| --- | --- | --- | --- |
| Original H.264 | 43.3 ms | 69.1 ms | 4.30 MB |
| Lossless all-keyframe H.264 | 23.7 ms | 33.5 ms | 64.21 MB |

The H.264 experiment lowers median seek latency by 45%, but costs 14.9 times
the source storage. Original/proxy captures are pixel-identical at 4.2, 5 and
8.5 seconds; live/capture comparisons also match for both variants. Reports:
`.local/hf-video-final-benchmark-original-20261004.json`,
`.local/hf-video-final-benchmark-h264-20261004.json`, and
`.local/hf-video-final-proxy-quality-20261004.json`.
Broader quality, bounded storage, cancellation and actual editor playback
measurements are still needed before integration. Seek acknowledgement is not
editor playback FPS.
The continuous preview section above records the subsequent integration and
its remaining performance limits. The pinned runtime's seek API restarts media
decoders and does not expose an external-clock tick.

## Native video and asynchronous drawing in live preview (2026-10-04)

The Classic live adapter now uses the pinned runtime's seek-completion barrier
before acknowledging a frame. It waits for native video decoding and drawing
registered through `hf-seek` / `waitUntil`, then repeats GPU drawing at the
runtime's sampled time when a Canvas may depend on video. Source media timing,
trim, playback rate and loop rules remain owned by HyperFrames. Classic still
owns audible output. A decoding/drawing error or overlapping seek fails the live
surface and allows the existing capture fallback. Page compositors requiring
the engine's screenshot pass remain on capture.

This also fixes an existing capture/export bug: engine 0.8.115 creates empty
`__render_frame__` images intended for its FFmpeg frame injector. OpenCut's
screenshot adapter uses native Chrome decoding, so no image was injected; their
presence made the runtime skip video seeking and retain the first frame. The
adapter now removes those empty reserved siblings and uses the same media
completion bridge before capture. Populated frame images remain intact.

This is **Classic-only rendering integration** over the existing canonical
document and timeline. It introduces no editor state, capability or MCP tool.

### Verification and limits

- Real browser tests compare live pixels with bounded capture artifacts across
  forward, reverse and repeated seeks. A generated video starts at 0.5 seconds,
  has a 0.25-second media trim and runs at 1.5×. Both its native element and a
  Canvas copy match frames independently decoded with FFmpeg. An asynchronous
  drawing delays completion by 40 ms. Rejected drawing, overlapping requests
  and invalid video emit one failure with no incomplete-frame acknowledgement.
- The existing opaque-sandbox and silent-audio test passes. The complete
  isolated regression passes 1,009 tests across 219 suites with no skips,
  including an unchanged serial rerun of two AI suites whose startup imports
  exceeded their default hook timeout. Product TypeScript and changed-file
  ESLint pass. Reports: `.local/hf-media-full-regression-20261004/summary.json`,
  `.local/hf-media-regression-recheck-20261004/summary.json`, and the combined
  `.local/hf-media-regression-verified-20261004.json`.
- The unchanged full Brag composition has 13 video elements. Live and fixed
  capture pixels are identical at 4.2, 5, 8.5 and 34.7 seconds. At 0.5 seconds,
  264 channels differ by one level (mean absolute RGBA error 0.000072). Report:
  `.local/hf-media-brag-benchmark-20261004.json`.
- During 60 sequential seeks through the twelve-video portfolio section,
  median acknowledgement is 65.1 ms and p95 is 121.2 ms in software Chrome.
  These are seek timings, not editor playback FPS. Real-time playback under
  this load remains an open performance requirement.
- In the full Classic editor, the 131-resource Brag package plays in a live
  surface between a native blue image and native title. The owned six-second
  fixture trims the source to 3.8–9.8 seconds. Its normal MP4 export contains
  180 H.264 frames at 640×360/30 fps and AAC audio. Audio correlation against
  the original trimmed mix is 0.99985, with zero measured sample offset at
  8 kHz. A second export after restarting the development server produces
  identical decoded video (SHA-256
  `c9596d62616fcb75ff300844122bbd42574f91e180c3d681385441bb5fe5c58d`).
  Artifacts: `.local/hf-brag-video-export-fresh-20261004.mp4`,
  `.local/hf-brag-video-export-check-20261004.json`, and
  `.local/hf-brag-video-live-ui-final-20261004.jpg`.
- The scaled MP4 comparison is not pixel-identical: three composition crops
  have mean absolute RGB errors of 4.76, 4.04 and 2.78 against bilinearly
  sampled source captures. It includes native compositing and H.264 encoding;
  a matched full-resolution export comparison remains open. The mixed UI
  performance log includes startup, edits and idle gaps, so it is not used
  as a playback FPS measurement.
- Unregistered wall-clock drawing is still outside the deterministic contract.
  Broader GPU/page-compositor, dynamically created media, nested video and loop
  coverage remains open; these results do not establish parity for every Canvas
  or shader composition.

## Continue interrupted imports in the full editor (2026-10-04)

The existing Import HyperFrames dialog now lists interrupted imports for the
active project, with the source name and completed resource count. Continuing
uses the original scene, placement, source text and resource identities. If all
copies are complete, no folder selection is needed. Otherwise the user chooses
the original folder and only missing resources are uploaded. A stopped recovery
keeps the plan available for another attempt.

Before copying files, the storage adapter journals an immutable plan alongside
the upload ownership record. A retry can replace its own unindexed partial copy.
Successful retention removes the plan's duplicate source text while keeping the
closed-attempt record. The plan is filesystem transaction metadata; canonical
source, composition state, history and import validation remain in OpenCutRuntime.

The existing `timeline.hyperframes.import` capability accepts an optional Classic
`importId`. Canonical validation rejects invalid or duplicate attempt IDs, and
the library projection exposes that identity. A recovered attempt already in the
document finishes saving and retaining its files without another timeline edit.
A separate intentional import of identical source remains allowed. Variable edits
retain the identity when replacing a source; detaching one shared occurrence
leaves the identity with the original composition. This is a **Classic-only import
recovery flow**, extending the canonical capability rather than duplicating it in
MCP. Browser Web Locks reject concurrent use of the same attempt in another tab.

### Verification

- Four isolated import/storage/manager suites pass 44 tests. Coverage includes
  partial-copy reuse, original placement, a committed attempt, failed recovery,
  account/scene containment, byte-preserving UTF-8 recovery, immutable plans,
  closed attempts, concurrent tabs and a fresh process resuming files after its
  upload worker was killed. The full regression includes these cases.
- Five targeted Rust suites pass 25 tests, including import identity persistence,
  duplicate rejection through the registry and `app.state.read`, intentional
  repeated imports, variable edits, source detachment, history and existing
  Classic/native HyperFrames import behavior. A parallel build exhausted Windows
  paging-file capacity; the serial build and tests passed.
- The canonical WASM bundle was rebuilt after the variable-edit identity fix.
  All 37 Classic and 13 canonical required exports pass verification; all 11
  canonical manager tests pass against the final bundle. Report:
  `.local/hf-recovery-final-wasm-20261004/summary.json`.
- Product TypeScript and changed-file ESLint pass (17 pre-existing assertion
  warnings in the storage/API files). The complete isolated web run passed 929
  tests and encountered startup-hook timeouts in two AI suites. Both passed in a
  serial rerun (78 tests), giving **1,007 passing tests, 218 suites, no remaining
  failures and no skips**. Reports:
  `.local/hf-recovery-flow-full-regression-20261004/summary.json`,
  `.local/hf-recovery-flow-regression-recheck-20261004/summary.json` and
  `.local/hf-recovery-flow-regression-verified-20261004.json`.
- A pending `advanced-audio-test-final` import was seeded through the actual
  authenticated local API with only one of three resources copied. The real
  dialog continued it from the original folder. All ten text files and three
  binary files match the Brag originals by SHA-256; the seven existing elements,
  four source packages and project settings are unchanged. Placement is the
  saved 2.5 seconds, although the playhead was at zero before recovery.
- In the owned local fixture, the journal/index were restored to the explicit
  crash boundary after project save and before retention. After reloading the
  editor, Continue required no folder and produced no additional clip, source or
  upload. Resource modification times and journal file identities stayed equal.
  Undo after reopen restores the original scenes, sources and settings exactly;
  Redo restores the recovered import. A final Undo restored the test fixture.
  Evidence: `.local/hf-recovery-ui-evidence-20261004.json`,
  `.local/hf-recovery-pending-ui-20261004.jpg`,
  `.local/hf-recovery-ready-ui-20261004.jpg` and
  `.local/hf-recovery-result-ui-20261004.jpg`.

### Remaining limits

Old journals without a saved plan cannot resume through this dialog. Reselected
text must match exactly; missing binary files are checked by size and modification
time, not by a previously saved hash. Web Locks cover the same origin/browser
profile, and server locks cover one process. This does not solve stale-tab project
save conflicts or multiple servers sharing an account directory. Open plans have
no automatic expiry or garbage collection because an unsaved edit may still be
active elsewhere. Recovery requires the original scene to remain available.

## Durable ownership for interrupted folder uploads (2026-10-04)

Folder imports now retain their upload ownership until the canonical project
save finishes. A failed save leaves the committed edit, copied resources and
ownership record available for retry. Previously the import cleared ownership
before saving, so a crash could make unfinished resources indistinguishable from
completed media.

The Classic local-drive adapter now writes an account/project-scoped journal at
`media/uploads/<attempt>.json` before streaming a resource. It records generated
filenames and temporary-file identities, including files that have not reached
the media index. Final copied filenames include the attempt ID, so one attempt
cannot overwrite or clean up another attempt's bytes. The journal has four
states: open, retained, discarding and discarded. Retention is recorded before
index ownership is cleared; discard intent is recorded before removing bytes.
Closed journals prevent delayed upload requests from resurrecting a completed
or cancelled attempt. Ordinary deletion still keeps copied bytes for Undo.

Copy and finish share an attempt lock. Other attempts can stream concurrently,
and index publication rechecks media identity under the existing index lock.
An old upload without a journal can still finalize or discard using its index
ownership. Journals remain filesystem transaction metadata: no editor document,
capability, MCP endpoint or second editor state store was added.

### Verification

- Nine storage recovery tests pass. Two launch a separate upload worker and kill
  it during streaming, without its cleanup handlers. A fresh process can discard
  the recorded partial copy; a simulated rename before index publication is also
  recovered. Other cases cover delayed requests, concurrent attempts, retained
  intent before index update, interrupted discard, legacy uploads, account scope
  and invalid journal paths. A slow upload does not block another attempt.
- All 26 tests in four targeted import/storage suites pass. The importer test
  checks save-before-finalize order, retains ownership on save failure and
  reports finalization failure without rolling back an existing edit. Report:
  `.local/hf-upload-journal-targeted-20261004/summary.json`.
- Product TypeScript passes. Changed production files have no ESLint errors;
  the storage server retains its ten existing type-assertion warnings. Changed
  import and test files have no warnings. The full isolated regression initially
  passed 910 tests but hit three AI startup-hook timeouts and a WASM constructor
  trap in the last manager test. All four suites passed in a sequential rerun
  (94 tests). Replacing those suites' first results gives **994 passing tests in
  217 suites, zero remaining failures and zero skips**. The trap's cause was not
  established by the successful rerun. Reports:
  `.local/hf-upload-journal-full-regression-20261004/summary.json`,
  `.local/hf-upload-journal-regression-recheck-20261004/summary.json` and
  `.local/hf-upload-journal-regression-verified-20261004.json`.
- The actual folder picker imported `advanced-audio-test-final` into the existing
  isolated four-package project. All ten text sources and three binary resources
  remain byte-identical to the originals. The new journal is retained and its
  media index records no longer carry upload ownership. The original seven
  elements and four source packages are unchanged. UI Undo restores the original
  scenes, sources and settings exactly; Redo restores the import from retained
  files. The fixture was returned to its pre-import state with Undo.
  Evidence: `.local/hf-upload-journal-ui-evidence-20261004.json` and
  `.local/hf-upload-journal-ui-20261004.jpg`.

This establishes durable intent and replay-safe completion/cleanup. The recovery
flow above now discovers and continues **open** attempts with saved plans.
Open journals are deliberately retained: an unsaved canonical edit may still be
alive in another tab, so elapsed time alone cannot authorize deleting its files.
The current in-process locks also do not establish support for multiple server
processes writing the same account directory. These limits remain part of the
interrupted-import completion requirement.

## Live OpenCut Perspective transforms (2026-10-04)

An otherwise eligible HyperFrames occurrence now remains live when its OpenCut
transform tilts the plane on either Perspective axis. Previously either nonzero
axis forced that occurrence through screenshot capture, slowing the entire mixed
frame. The CSS adapter uses the existing resolved quad, with the same plane
projection as Classic's compositor: size and flips, Y tilt, X tilt, perspective,
then Z rotation and placement. The CSS tilt signs reverse because its projection
uses the opposite depth sign. Perspective distance remains 1.5 times the larger
displayed dimension, subject to CSS's one-pixel minimum.

This is **Classic-only rendering**. The canonical transform, animation evaluation,
document state, capabilities and undo history are unchanged. Effects, masks,
unsupported blending or scene wrapping, video/canvas sources and runtime failures
retain their capture behavior. The live-occurrence limit remains four. This does
not address the separate repeatability limitations of authored 3D scripts.

### Fidelity verification

- A real Chrome test compares the production CSS helper on an iframe with
  rendered pixels from the bundled Classic WASM compositor. Ten cases cover both
  axes, combined Z rotation, each flip and both together, nonuniform sizing,
  opacity, portrait proportions, translated placement and the 75-degree UI limit.
- All cases pass. Maximum mean premultiplied RGBA error is **0.373 / 255**;
  at most **1.25%** of pixels differ by more than 8 in any channel. Tolerances
  account for the two rasterizers' antialiased edges. Tests also reject blank
  compositor output. This machine uses the compositor's WebGL fallback in the
  software browser; hardware WebGPU parity remains unverified.
- The render-tree test verifies that adding Perspective preserves the same live
  source lease and native base segment, and that a subsequent runtime failure
  still releases the lease and switches to capture.
- Targeted browser/render-tree/document coverage passes all five tests in three
  isolated suites. Product TypeScript and changed-file ESLint pass. Evidence:
  `.local/hf-perspective-targeted-20261004/summary.json`.
- The full isolated web regression passes **984 tests in 216 suites, zero
  failures and zero skips**, with browser coverage and the local Brag GSAP
  fixture enabled, in 111.8 seconds. Report:
  `.local/hf-perspective-full-regression-20261004/summary.json`.

### Existing Brag fixture measurements

Project `3e993c3a-d148-48c5-bdd2-88921f104a2c` retains its four source packages,
native image/text layers and the final occurrence's ten-degree X Perspective.
Its historical name still ends in "plus capture"; all four occurrences now use
live iframes. The measurement uses the same 1280x720 development workbench,
640x360 scene, fitted preview and six-second 30 fps transport as the earlier
capture comparison. Preparation before playback is excluded.

| Path | Completed frames/s | Distinct completed frames | Median render time |
| --- | --- | --- | --- |
| Earlier: three live, one Perspective capture | 2.50 / 5.34 | 15 / 32 | 187.5 / 177.7 ms |
| Current: four live, including Perspective | 27.40 / 28.89 / 28.84 | 164 / 173 / 173 | 6.1 / 4.4 / 5.5 ms |

All three current runs report zero render errors. The last two complete 173 of
179 observed source-frame positions. These short workbench measurements do not
establish sustained playback, full-screen performance or other-device results.
Required capture paths remain a performance limitation. Evidence:
`.local/hf-perspective-playback-20261004.json`; screenshot at 2.5 seconds:
`.local/hf-perspective-live-20261004.jpg`.

## Composition library in Classic Assets (2026-10-04)

Imported compositions now appear as reusable items in the existing Assets panel.
The library groups package resources under their composition instead of placing
every image among ordinary top-level media. Each item supports Add at playhead,
Show files, Show in timeline and the existing graphic drag path. Resource folders
and All files retain access to imported media; package fonts and other binary
resources are listed as non-draggable files. Search covers names, including
resources, and works within an open composition folder. Library metadata comes
from the canonical runtime, with no second document store or thumbnail execution
of authored scripts.

The header keeps Import, view and sort controls visible in the narrow Assets
panel. Unify and Podcast multicam remain available in More asset actions and in
their existing media context menus. Media labels now use CSS truncation; add
buttons have accessible names and remain visible during keyboard focus.
Reveal media clears an active folder/search and selects All files. Switching
folder, search or view resets virtual-list scrolling so an old position cannot
hide the first results.

### Canonical contract and migration status

- **Classic-only:** `hyperframes.library.read` projects source identity, dimensions,
  duration, resource bindings and occurrences from the existing Classic document.
  It requires project identity and expected revision and executes no source.
- **Classic-only:** `timeline.hyperframes.insert` adds another occurrence of an
  already imported source. Project, active scene and expected revision are checked.
  The action supports undo/redo, dry run, cancellation and registry idempotency.
  It reuses the original asset ID and leaves source properties and media bindings
  unchanged. Both capabilities are exposed by the registry and enabled in the
  Classic WASM adapter; no transport-specific tool or rewrite UI was added.
- Library grouping/search/selection are disposable UI state. The normal graphic
  drag handler still commits through the existing canonical editor transaction.
  Add at playhead calls the dedicated insertion capability.

### Verification

- Three new Rust registry tests cover read-only metadata, source/resource reuse,
  original native elements, undo/redo, wrong project/scene/track, stale revisions,
  missing sources, invalid time, cancellation, dry run and idempotent retry.
  These and the nine existing Classic HyperFrames tests pass. Clippy passes with
  warnings denied for this target.
- The real-WASM manager test verifies selection, source reuse, undo/redo, saved
  history and reopening. All 11 manager tests pass. Both WASM export checks pass;
  product TypeScript and changed-file ESLint pass.
- The full isolated web run passed 875 tests but timed out while loading three
  AI suites during development recompilation. Those three suites then passed
  all 108 tests in an isolated single-worker rerun: **983 passed, zero remaining
  failures and zero skips**. Reports:
  `.local/hf-library-full-regression-20261004/summary.json` and
  `.local/hf-library-ai-recheck-20261004/summary.json`.
- Browser verification used the existing four-package Brag/native project
  `286360fa-97fd-480e-8a80-2643311705b6`. The library shows four compositions and
  the native blue image; the composition folders contain 3, 42, 25 and 27 resource
  files. Folder search, empty search, All files, both display modes, navigation
  to the layer inspector and Reveal media from a filtered folder work.
- Add at playhead increased the document from seven to eight elements, kept all
  seven originals byte-for-byte equivalent as JSON values, and retained the same
  four source packages. UI Undo restored the scenes, sources and settings exactly;
  Redo restored the second occurrence. Evidence:
  `.local/hf-library-insert-evidence-20261004.json` and
  `.local/hf-library-undo-evidence-20261004.json`.
- Screenshots: `.local/hf-library-ui-20261004.jpg` and
  `.local/hf-library-resources-20261004.jpg`. The first shows the library beside
  four rendered Brag compositions, native layers and the selected layer inspector.

Actual pointer dragging from a composition card, cross-scene navigation and the
complete interface audit still need broader interactive coverage. Long playback,
capture throughput, interrupted import recovery and remaining export parity are
also still open; this checkpoint does not complete the integration.

## Feature preservation regression audit (2026-10-04)

The web suite now runs through `bun run test:web` from `classic/`, one isolated
process per file. Bun is the default; the audio browser suite explicitly uses
Node, matching the server runtime. This prevents process-wide module mocks from changing other
suites. Tests requiring real Classic Rust exports explicitly declare the
`@opencut-test-wasm: real` preload. Tests with partial mocks merge the generated
WASM exports before their own overrides. A universal preload was rejected:
it made renderer startup, AI tools and caption timing tests bind real functions
where those tests deliberately needed mocks.

The audit repaired missing WASM setup/exports, initialized a signed-in browser
fixture for the AI client, updated the AI skill inventory, and corrected a
preview-frame mock that incorrectly expected a third `Array.from` callback
argument. No production editor behavior changed in this checkpoint.

### Results

- **215 web suites: 968 tests pass, zero failures, 11 optional browser tests
  skipped**, in 44.7 seconds with two workers on this machine. Coverage includes
  timeline editing, ripple/cut/trim and ordering (135 tests), AI (179), storage
  and renderer services (177), subtitles (61), editor managers and canonical
  commands (41), text (37), plus accounts, batch editing, backgrounds, masks,
  effects, transitions, retiming, templates and UI element bundles. Full report:
  `.local/hf-regression-final-20261004/summary.json`.
- Four suites were rerun after the final mock/precision cleanup: **75 tests
  pass** (`.local/hf-regression-postreview-20261004/summary.json`).
- **74 root Rust tests pass** across `opencut-editor-api` and `opencut-mcp`,
  including registry projection, transaction rollback, scope, authentication
  and loopback transport. **158 Classic Rust tests pass** across `agent`,
  `background-removal`, `time`, `bridge`, `effects`, `masks`, `podcast`,
  `premiere`, `storage` and `timeline`. Native GPUI/GPU/compositor tests were not
  included in that command. Logs: `.local/hf-native-regression.log` and
  `.local/hf-classic-rust-regression.log`.
- Product TypeScript (`tsconfig.build.json`) passes. The full test-fixture type
  audit still has errors, including fetch mock signatures, branded media times
  and incomplete fixture types. `tsconfig.test.json` makes this audit explicit
  with Bun types and ES2020; it is not a passing gate yet. The product build
  configuration remains separate. Diagnostics: `.local/hf-test-typecheck.log`.
- Real Chrome tests for capture, live document isolation, internal layer edits,
  host scope/capacity and declared variables all pass: five suites, ten tests
  (including two capture tests already counted in the default run). GSAP volume
  envelope sampling passes separately with the local Brag GSAP fixture.
  Reports: `.local/hf-regression-browser-20261004/summary.json` and
  `.local/hf-gsap-volume-regression.log`.

### Private audio migration coverage

Four preset tests previously required the removed public shared library.
Commit `023cc9db` intentionally moved that user-owned data into authenticated
account storage. The revised tests create synthetic private audio at the
presets' stable IDs, run the real legacy migration, and read both the manifest
and bytes through the actual authenticated routes. Renamed metadata preserves
IDs and exact source bytes; another account receives no library entries and
404 for the asset, while an anonymous request receives 401. Existing preset
clip timing assertions remain.

These tests prove the migration/routing contract. They do not verify that the
owner's real media has been imported on this installation, or make those sounds
available to fresh accounts. Presets still reference account library IDs;
missing-library feedback and the fresh-account preset experience need review.
Private media was not restored to `public/` or added to Git.

### Audio browser suite now uses the server runtime

The invalid nested-audio fixture extends a clip 0.1 seconds beyond its parent.
Phase tracing showed that canonical rejection completes in 1–2 ms under Bun
1.3.5, followed by a 30-second stall in the engine's final Chrome memory sample
and a five-second page-close timeout. Several runs then crashed Bun. Disabling
the sampler reduced the delay but did not eliminate the page-close timeout;
keeping preview resources alive and moving cleanup out of the error-unwinding
path also did not resolve it. Those experimental edits were reverted.

The unchanged production adapter handled the same fixture under Node 24.12.0
in **954 ms**, including rejection and browser disposal. The engine declares
Node as its supported runtime, and the Next server runs on Node. The three
real audio tests now use `node:test`, retaining their video-audio discovery,
nested occurrences, trims, rates, gains, fades, decoded PCM, account/project
isolation, cancellation and GSAP envelope assertions. A new assertion requires
invalid-probe cleanup within five seconds, then opens a valid composition and
captures a PNG with the same runtime and preview host. Memory sampling remains
enabled. Production capture/disposal code is unchanged.

`// @opencut-test-runner: node` explicitly selects this runtime in the isolated
runner; there is no retry or runtime selection based on pass/fail. A small
TypeScript hook loads the same source files and installed dependencies under
Node. WASM fixture bytes now load through `node:fs/promises`, shared with the
Bun suites. Node TAP totals and the selected runtime are recorded in each report.

Verification after the change:

- All three audio tests pass in **21.9 seconds** with Chrome and FFmpeg. Report:
  `.local/hf-audio-node-suite-20261004/summary.json`.
- The full suite with browser tests and the local Brag GSAP fixture enabled
  passes **979 tests in 215 suites, zero failures and zero skips**, in **90.1
  seconds** with two workers. This includes the default 968 tests and all 11
  previously optional browser tests. Report:
  `.local/hf-regression-with-browser-node-20261004/summary.json`.
- Changed TypeScript test files pass ESLint. The test type audit still reports
  51 existing fixture errors elsewhere, with none in the changed audio test or
  canonical runtime fixture (`.local/hf-audio-node-typecheck.log`).

Bun's CDP/cleanup issue is not claimed fixed upstream. The verified product path
and its audio regression suite now run in Node. Diagnostic evidence remains in
`.local/hf-disposal-phases.log`, `.local/hf-disposal-node.log`, and the earlier
Bun failure logs.

This regression audit is partial preservation evidence. The broader UI review,
full interactive workflows, remaining Brag exports, child timing editing and
larger-timeline playback checks are still required before completion.

## Declared composition variables (2026-10-04)

The existing Graphic inspector now shows declared HyperFrames variables for the
selected clip: text, colors, numbers, booleans, enum choices, images and fonts.
Apply checks the changed animation before committing; Reset restores authored
values. Other occurrences stay independent. Values with the same name apply
throughout the selected compound, including repeated nested compositions.
Individual nested-host variable overrides remain a separate future capability.

`HyperframesSource.variables` stores explicit values alongside unchanged source
files/resources. Empty values are omitted, so old source fingerprints and saved
archives retain their identity. Rust reads declarations from HTML, enforces
matching types, numeric bounds, string lengths, enum choices, a 256-value limit
and a 256 KiB payload limit. One value must satisfy all matching declarations.
Malformed optional display metadata is normalized before reaching the UI.

The canonical capabilities are `hyperframes.variables.read`,
`hyperframes.variables.prepare`, and `hyperframes.variables.set`. The write
requires explicit project/scene/element/revision and a freshly observed manifest
for the derived source. The UI holds the revision across asynchronous preflight,
checks account/project/scene scope again, and offers cancellation. Shared source
assets fork for the edited occurrence; a dedicated asset can update in place.
Existing timeline placement and visible duration stay intact. A new source that
cannot cover the clip is rejected. Opacity overrides are rebound only when all
layer identities still match; a structural change requires resetting those
opacity overrides first. This is **Classic-only**, through OpenCutRuntime.

The render adapter installs values before authored scripts run. In pinned
HyperFrames 0.8.115, top-level `__hfVariables` alone does not reach nested scripts'
scoped `getVariables()`. OpenCut also applies explicit values when the runtime
populates `__hfVariablesByComp`, preserving its host defaults beneath those
values. Both live and capture use the same adapter. This scope adapter must be
retested when upgrading HyperFrames. Source identity includes variable values,
so frame, live-session and audio caches distinguish the variants.

Verification:

- Two new Rust registry tests cover validation, legacy fingerprints, unchanged
  file bytes, independent repeated clips, preflight fingerprint mismatch, dry
  run, retry idempotency, cancellation, locks, stale revisions, shortened source,
  changed layer identity, opacity preservation and undo/redo. Eight import and
  two opacity regression tests also pass.
- A real Chrome/WASM test verifies root script initialization, declarative text,
  CSS color, numeric size and enum layout. Two repeated nested instances receive
  the same explicit title. A title containing closing script tags remains text.
  Live/capture RGBA frames match at `0.5, 2, 0.5, 0.5` seconds, including capture
  reopen after live promotion. Persisted history restores the values and opacity.
- UI project `d42d8daf-3bfd-4807-8c26-b4f1aae5e27a` contains two copies plus native
  text and an image. Changing the left title to `Edited in OpenCut` and accent
  to `#66e3a4` leaves the right title/color original. Reload retains both edits;
  persisted Undo/Redo changes the edited accent back and forward. Cancel during
  preflight leaves the canonical values unchanged; reload restores the original
  size of 60. Reset restores the authored title; Undo restores the edited one.
  Both clips retain byte-identical original HTML. UI evidence:
  `.local/hf-variables-ui.png`.
- UI export is H.264, 640x360, 30 fps, exactly four seconds and 64,150 bytes.
  Its decoded two-second frame visibly preserves both independent appearances
  and native layers. This fixture has no active audio. Evidence:
  `.local/hf-variables-export.mp4`, `.local/hf-variables-export-frame.png`.
- Nine cache/client tests (256 assertions), five capture/session tests (25
  assertions; three optional browser tests skipped), scoped TypeScript,
  changed-file ESLint, Editor API Clippy, the release WASM build and binary
  export checks passed. Full editor regression and broader Brag coverage remain
  pending; this increment does not complete the integration.

## Per-occurrence visual layer controls (2026-10-04)

Classic compound clips now expose Hide/Show, opacity percentage and Reset in the
existing Composition layers inspector. Each edit belongs to that timeline clip.
Other uses of the same source keep their own appearance, and the package's HTML,
scripts, resources and authored animation remain unchanged. Audio layers remain
read-only here; visual opacity does not mute embedded narration.

The canonical `hyperframes.layer.opacity.set` capability requires an explicit
project, scene, element, layer key and revision. It validates locks, finite
opacity in `[0, 1]`, source identity and the complete observed manifest, and uses
normal transactions, dry runs, cancellation, idempotency and undo history.
`GraphicElement.hyperframesLayerEdits` stores the source/manifest fingerprints
and a bounded map of opacity overrides. Setting one removes that override.
Ordinary Classic commits and admin patches validate the same state.

`hyperframes.layers.render.prepare` produces the render plan. Each capture
reopen checks it against a freshly observed manifest; ambiguous `manifest/N`
rows cannot be edited. The shared live/capture DOM adapter resolves exact
occurrence paths and checks the authored ID, restores author styles before each
seek, then multiplies the evaluated opacity after the official runtime seeks.
Parent and child edits compose, while repeated seeks do not accumulate changes.
Render cache keys include the overrides. No extra timeline or editor state was
introduced. This editing capability is **Classic-only**, through OpenCutRuntime;
it has not been ported to the rewrite UI or rewrite timeline model.

Verification completed for this increment:

- Registry tests cover targeted edits/readback, repeated source occurrences,
  unchanged source packages, dry run, retry idempotency, cancellation, stale
  revisions, invalid targets/values, locked tracks, undo/redo, reset and rejected
  manifest changes. Existing timeline projection/history tests also pass.
- A real Chrome/WASM test edits a parent and one child in two repeated nested
  compositions, checks the unaffected sibling, and compares complete live and
  capture RGBA frames at `0.5, 2, 0.5, 0.5` seconds. They are identical. It also
  reopens capture after live promotion and round-trips the saved undo archive.
- Actual Brag UI project `980bd89b-dda1-48ae-9098-e660c98334a6` contains two uses
  of `advanced-audio-test-final`, native text between them and a native image
  below. Hide affected only the selected occurrence; Undo restored it. At 50%,
  the two DOM surfaces report opacity `1` and `0.5`. Reopening retained 50%, and
  persisted Undo/Redo restored 100%/50%. Source packages compare equal to the
  fixture before editing. Evidence: `.local/hf-layer-opacity-50.png`.
- UI MP4 export with the edit completed: 640x360, 30 fps, H.264, stereo AAC at
  44.1 kHz, 6.014 seconds and 479,221 bytes. Its decoded frame at 0.5 seconds
  shows the edited occurrence and preserved native/sibling layers. Evidence:
  `.local/hf-layer-opacity-export.mp4` and
  `.local/hf-layer-opacity-export-frame.png`.
- A second UI export after Reset, with all other settings unchanged, has
  identical decoded stereo PCM audio. SHA-256 for both outputs (PCM s16le):
  `c7db66bbb549caea21c18712c0a74c872a19a8d697d1fb98610931efe121ee64`.
  The decoded video comparison shows the opacity change on the selected source
  section. The project was returned to 50% with Undo after this comparison.
- Three Rust tests and 24 selected TypeScript tests passed (414 assertions),
  including the real Chrome test above. Three older optional browser cases were
  skipped in the non-browser regression invocation. Tests that mock modules ran
  in separate Bun processes. Scoped TypeScript, changed-file ESLint, Editor API
  Clippy (`--tests -D warnings`), the release WASM build and both binary export
  contract checks passed. These are scoped checks; the full editor suite remains
  outstanding.

Child retiming, movement, text/source/variable controls, video/canvas live
support and the broader preservation/performance audits remain open.

## Inspected evidence (2026-10-03)

Upstream source: [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes),
commit `b7343e3a95791bdc3448eddd6f00b4e73128b345`. Read-only local reference at
`.local/hyperframes-upstream`. Upstream uses Apache-2.0; preserve its license and
notices if code is reused. The current Rust source-package code is original.

User reference directory: `C:\Users\etiez\OneDrive\Documents\ChatGPT\Brag`.
`brag-reconstruction-2026-10-03/advanced-audio-test-final` pins HyperFrames 0.8.91:
720×1280, 30 fps, 6 seconds. Its inline script generates the visual scenes.
`npx --yes hyperframes@0.8.91 timeline --json` from that project reports only the
authored narration row. This is direct evidence that static HTML extraction alone
cannot reproduce this user's composition layers. Inspection did not modify the
reference project or its version pin.

### UI and timeline

- Studio composes its existing timeline from lane, ruler, playhead and overlay
  parts (`packages/studio/src/player/components/Timeline.tsx`). Exported Studio
  components need host contexts; mounting the complete Studio would introduce a
  second editor state and does not meet this task.
- `timelineViewportGeometry.ts` selects a visible time window with overscan and
  preserves a row anchor when geometry changes. Useful for expanding nested
  compositions without jumping the scroll position.
- `useTimelinePlayerLoop.ts` reads the playback adapter and broadcasts time to
  direct DOM subscribers; React state is synchronized at transport boundaries.
- Visual inspection of the already-open Studio at `localhost:3002` showed a
  96.9-second Brag project: fixed track names and clip counts, compact labeled
  thumbnail clips, one toolbar, a central preview, and a contextual inspector.
  The useful improvement is hierarchy and readable selection/context, not merely
  copying its colors. The reference also reports lint errors; its appearance
  does not establish source correctness or performance.
- Classic already has indexed/virtualized track layouts and a playhead subscribed
  to playback events (`visible-track-layouts.ts`, `use-timeline-playhead.ts`).
  Measure remaining layout work before replacing these mechanisms.
- First Classic improvement: move its existing playhead with `translateX`
  instead of changing `left` every frame. Geometry, scrolling, keyboard seeking
  and canonical playback events remain in place. Browser timing measurements
  are still required before reporting a speedup.

### Source, layers and timing

- HTML/CSS/JS plus media form the project; `data-*` attributes describe authored
  timing. The live runtime resolves script-created nodes, media durations and
  expressions (`core/src/runtime/startResolver.ts`, `clipTree.ts`).
- A display lane is not compositing z-order. Preserve source CSS and host nesting.
- The same source can appear in multiple host slots. Use an occurrence-scoped key
  plus source-file identity, not a global author ID, to address child layers.
- A root composition must stay intact for fidelity: flattening its children into
  unrelated native text/shape clips loses CSS, shared animation and dependencies.
- Classic's existing `graphics/html-raster.ts` strips scripts/audio/video and
  rasterizes CSS fragments through SVG. Keep that feature; add a separate renderer
  for full HyperFrames compositions.

### Playback and rendering

- The runtime provides a common seek contract. Its transport clock can follow
  audio and handles stalls (`core/src/runtime/clock.ts`). One OpenCut transport
  must drive composition time, trim offset and speed.
- Engine services include browser pooling, `beginFrame` capture, streamed FFmpeg
  encoding and parallel capture. Their presence is not a measured speed claim.
- Use a persistent isolated composition runtime for preview and deterministic
  capture for export; rebuilding HTML or screenshotting it on every preview
  frame would discard the main performance advantage.
- All generated binary results must use the bounded `ArtifactStore`. Durable
  imported media belongs to project media storage, not expiring output artifacts.

## Implemented contract and migration status

**Canonical source contract, Classic command/view adoption, folder import UI,
isolated runtime, compositor frames and timeline audio integration are implemented.
Multiple live previews are implemented; full media/export parity remains pending.** No alternate timeline was added. The lazy browser binding runs the same
`OpenCutRuntime` and owns adopted Classic history and validated document changes.
Projects without an adopted session retain the existing Classic path.

### Folder ingestion and isolated runtime (2026-10-04)

- `hyperframes.package.plan` is a pure registry capability shared by native and
  browser hosts. It validates relative paths and byte counts, identifies HTML
  entry candidates, excludes `.git`/`node_modules`, and classifies source versus
  binary resources. Other folders are preserved, including assets referenced
  only by scripts. Duplicate paths and paths outside the package are rejected.
  Package paths stay in a case-sensitive URL namespace; they are not copied to
  matching Windows paths. Binary bytes use existing asset IDs in the media store.
- The browser adapter preserves UTF-8 source, including BOMs, Hebrew and CRLF,
  and rejects malformed UTF-8. Fonts, WASM and other binary data use the existing
  project media store with type `file`; they cannot be inserted as ordinary
  video clips. Existing audio, video and image types remain available.
- `@hyperframes/core` and `@hyperframes/player` are pinned to 0.8.115. The preview
  document uses their runtime injection helper and the original entry URL.
  Runtime composition loading retains author script order, module URLs, nested
  hosts and dynamic fetches. It does not write staging files or alter source.
- The loopback preview host exposes only package members on a random 192-bit
  `<token>.localhost` origin. It has no editor controls or account cookies.
  Hostnames must match exactly; CSP isolates scripts from the app, and media
  responses support byte ranges. Each host caps cached text at 64 MiB and eight
  previews, expires idle entries after 30 minutes, and supports explicit close.
  This is derived rendering state, not another editor document store.
- All eight Brag folders loaded in the in-app browser through the official player
  and accepted a seek to two seconds. Durations were 20, 15.5333, 15.5333, 20, 6,
  96.9, 6 and 6 seconds; the last was resolved by executing its generated scene.
  A separate fixture verified nested HTML loading and a JSON fetch relative to
  an entry below the package root. The reference files and version pins were
  unchanged. Audio was muted during this probe, so this does not establish audio
  output parity or smooth playback performance.
- Preparing and registering these previews took approximately 6–90 ms per
  project in this local probe, after loading the WASM runtime and reading files.
  This is not an end-to-end import or frame-rate benchmark. The ignored scripts
  and report are `.local/hyperframes-runtime-probe*` and
  `.local/hyperframes-player-probe.ts`.

The authenticated host and existing Classic compositor now use these adapters.
Importer UI, live DOM preview, media/audio synchronization and real-project export
parity remain pending. Do not expose the importer before its supported behavior
and failure reporting are complete.

### Persistent frame capture (2026-10-04)

- The Classic host adapter now uses `@hyperframes/engine` 0.8.115 for persistent
  capture sessions. An isolated page stays loaded across seeks. The adapter
  connects the official runtime's `__player.renderSeek`/`getDuration` to the
  engine's `__hf` protocol; timing and animation remain in HyperFrames.
- A small, tracked Bun patch lets the engine navigate the exact original entry
  URL and keeps Chrome's sandbox enabled, including its GPU probe. There is no
  general browser automation or filesystem endpoint. The adapter accepts only
  the validated package and explicitly resolved resource bindings.
- Each page has a private browser, package origin and read-only request policy.
  There are at most four sessions, two queued frames per session and a
  16-megapixel frame limit. Capture cancellation closes the browser, failed
  initialization releases the slot, and idle sessions expire after two minutes.
  The engine's required scratch directory stays empty and is removed on close.
- `storeArtifact` and `removeArtifact` expose the existing Rust ArtifactStore to
  the renderer host. PNG bytes receive canonical IDs, checksums, expiry and
  capacity eviction. Closing a capture leaves already returned artifacts valid
  in that store; no agent needs a temporary frame path.
- Browser tests verify nested entry paths, dynamic JSON, nested HTML, CSS seek
  positions, transparent pixels, authored body backgrounds, queue ordering,
  failed preparation, cancellation and close. The synthetic fixture produces
  identical PNGs when seeking 0.5 → 2 → 0.5 seconds.
- All eight real Brag projects produced three frames with these same seek
  checkpoints. Seven produced identical repeated PNGs. In
  `brag-reference-recreation/composition`, 79 of 921,600 pixels differed around
  the 3D phone edges (maximum channel difference 55; mean absolute channel
  difference 0.000360). Exact repeatability for this case remains unresolved.
  No original source was modified. Probe artifacts were first read from the
  canonical store and then saved by the ignored inspection script.
- On this machine, initialization took 1.14–1.68 seconds per project and frame
  capture plus artifact read/write took 85–414 ms. This was software-GPU PNG
  capture, not a playback benchmark. The adapter provides an export/compositor
  fallback; a live DOM preview path is still required for fluid playback.
- The ignored probe and report are `.local/hyperframes-capture-probe.ts` and
  `.local/hyperframes-capture-probe-results.json`. Audio mixing, decoded video
  injection, arbitrary author timer virtualization, comparison with original
  HyperFrames exports remain unverified or unimplemented. This adapter is not
  yet exposed as an import feature.

### Classic compositor and authenticated host (2026-10-04)

- `/api/hyperframes` uses the existing loopback/account authentication and exact
  account/project ownership for every session and artifact. It resolves only
  registered project media. A separate host runtime validates source and owns
  the bounded ArtifactStore; it never attaches an editor document or history.
- Preview, thumbnails and export supply the canonical composition map to the
  existing scene builder. HyperFrames frames enter `GraphicNode`, so native
  ordering, transforms, opacity, masks and effects use the existing compositor.
  Source time includes the clip's trim offset. Imported intrinsic dimensions
  are stored and validated; older clips without those dimensions still load.
- Browser clients keep at most two capture sessions, evict old sources, close on
  project/reset/export cancellation, and invalidate when media bindings change.
  Failed captures discard their session so a later render can open a fresh one.
  Each clip owns its canvas; bitmap handles close after each draw. Canvas version
  stamps refresh GPU textures after seeks and resource changes.
- A separate local test account on port 3165 used a 640×360, 30 fps, four-second
  project: a native blue image, a moving HyperFrames square at 50% opacity with a
  one-second source trim, and a native green image above it. The ordinary Classic
  timeline and inspector rendered the result. Seeking to 0, 2 and 3.5 seconds,
  a 40-pixel position edit, and Undo were checked through the editor UI.
- The normal MP4 export produced 120 H.264 frames, 640×360, 30 fps and exactly
  four seconds. Decoded frames confirm purple at the square's expected source
  positions (150 px initially and 250 px at two seconds), opaque green above it,
  and only native layers after the three-second trimmed clip ends. Sampled pixel values
  differ by at most two levels from the fixture colors after H.264 encoding.
  The generated file and extracted frames are in ignored
  `.local/hyperframes-mixed-render-proof/`. The reference folders and user
  projects were not modified.
- This is the capture fallback. It does not establish smooth playback, embedded
  audio/video fidelity, speed support, all effect combinations, or Brag export
  parity. More than two distinct visible sources may require repeated browser
  initialization; that path needs the planned live preview and measured caching.

- `hyperframes.project.inspect`: pure bounded source inspection, no script
  execution, filesystem reads or URL fetching. Reports authored elements,
  instance hierarchy, references and unresolved runtime needs.
- `timeline.hyperframes.import`: explicit project ID and expected revision;
  source becomes a typed `MediaAsset.hyperframes` and one existing `compound`
  timeline item. Omitted start appends; explicit start overlays. An existing
  video/overlay track can be selected; otherwise adds an overlay track to the
  same timeline. Native project resolution, frame rate and existing items stay
  unchanged. Registry projects MCP automatically.
- Registry idempotency metadata, dry run, cancellation checks, undo/redo and
  canonical `app.state.read` are covered by tests.
- Registry retry receipts now distinguish dry runs from commits, so reusing a
  request key after an import preview still performs the real write once.
- Source text is retained exactly. Binary dependency paths bind to existing
  OpenCut media asset IDs. Unbound dependencies are reported in inspection.
- Immutable source packages are shared across in-memory snapshots and undo
  history, while saved JSON remains self-contained. Asset lookup during document
  validation is indexed so native clips do not scan the whole asset library.
- Schema version 4 adds the optional composition payload; older documents
  migrate through the existing exact-time migration.
- The FFmpeg-only renderer rejects a HyperFrames source asset explicitly until
  its composition renderer is installed; it must never silently omit it.

### User-facing folder import (2026-10-04)

- The Assets panel's existing Import button retains ordinary media import. Its
  adjacent menu opens **HyperFrames project folder**. The dialog chooses an HTML
  entry, then places a new graphic track at the playhead, at the end, or at zero.
  After import the preview seeks to the new clip. Progress, cancellation and
  runtime failures are visible in that dialog.
- `timeline.hyperframes.import` now accepts optional `classicResourceAssets`.
  Canonical validation rejects unrelated, duplicate, transient or overwritten
  media bindings. Resources and composition enter the document in one mutation.
  A dry run validates the prospective import before copying any binary data.
- The host pins multi-request work to its initiating account/project/scene and
  abort signal. Runtime readiness supplies generated duration before the actual
  edit. Failed uploads and cancelled imports discard only copied resources owned
  by that attempt's random upload token. Finalization removes that token. Normal
  media deletion still retains bytes for Undo. A cleanup failure is reported;
  a save failure after commit retains the new clip and its files.
- Rust Undo removes the imported bindings and clip atomically. Classic's existing
  media history policy retains the durable library bindings when undoing the
  timeline insertion, so Redo uses the same copied files.
- Browser proof used the isolated render-verification account. A folder with two
  HTML entries, a local GSAP library and a PNG was selected through the real
  directory picker. `main.html` had no authored duration; its registered GSAP
  timeline resolved to four seconds. Appending at four seconds made an eight
  second project. Undo/Redo and exiting/reopening restored the composition and
  image. A second import at zero verified overlay placement. Hashes of all saved
  source strings and copied PNG bytes match the originals; evidence is in
  `.local/hyperframes-folder-import-proof.json`.
- A deliberately unresolved composition exercised runtime failure after upload.
  With staged cleanup enabled, both the file count and media-index count were
  unchanged after rejection. The successful import's upload token was removed.
- At this stage embedded audio was explicitly marked unsupported in the dialog
  (superseded by the timeline audio connection recorded below). The actual
  Brag folder verification below extends the synthetic flow. The other seven Brag
  UI imports, generated children, fast preview, video fidelity and crash recovery for staged
  uploads remain pending. The new folder export was invoked through the UI, but
  its downloaded MP4 could not yet be recovered for frame verification; the
  earlier synthetic compositor MP4 remains the verified export evidence.

### Canonical runtime in the browser

- `classic/rust/editor-runtime-wasm` exposes the live capability registry,
  read-only snapshots, portable session bytes and bounded artifact reads. It
  depends directly on `crates/editor-api`; it has no independent editor model.
- `loadCanonicalRuntime()` is an asynchronous import. The registry and JSON
  Schema validators live in their own WASM module. An initial combined build
  increased the main Classic binary from 3,919,268 to 10,021,797 bytes; the
  separate build restores the main binary to exactly 3,919,268 bytes; the lazy
  runtime module is 6,304,295 bytes. This is a size check, not a playback speed
  measurement. Build and export checks cover both packages. The dev launcher
  checks for both generated binaries, and Webpack/TypeScript resolve their
  local generated packages together to avoid stale Bun package copies.
- Platform clocks, random initialization and Tokio features now support
  `wasm32-unknown-unknown`. Native filesystem/process capabilities remain
  discoverable with an explicit unavailable reason in a browser. Metadata-only
  media registration, source inspection and canonical editing remain available.
- Session persistence now separates serialization/validated restoration from
  native filesystem access. A failed restore leaves the document unchanged.
  A successful restore clears old retry receipts so an earlier receipt cannot
  falsely claim that an edit exists after loading an older saved revision.
- Actual WASM execution under Node verifies mixed import, byte-for-byte source
  preservation, dry run followed by commit with the same retry key, stale
  revision rejection, undo/redo, session restore, invalid-restore rollback,
  native capability rejection and bounded artifact access. These are runtime
  tests, not an end-to-end Classic UI or rendering test.
- A read-only WASM probe inspected all eight Brag packages and imported the
  seven with authored numeric durations into one canonical timeline. Restoring
  the serialized session reproduced the document. The eighth package needs
  live duration resolution; no duration was guessed. Media remained unbound
  in this source-only probe. Local probe: `.local/hyperframes-wasm-probe.mjs`.
  The final release probe took 445 ms to initialize the registry and about
  4–18 ms per import on this machine under Node. This excludes resource copying,
  browser UI work, script execution and rendering; those still need measurement.

### Existing Classic document boundary

- Schema 5 adds optional `Project.classic`: the original serialized Classic
  project plus durable media records. Unknown project, scene and feature fields
  remain in that document. Validation checks identity, rational frame rate,
  canvas, scene/track/element IDs, integer timing and composition/resource links.
  File, URL and buffer handles are rejected in durable media bindings.
- `project.classic.attach` loads that document; `project.classic.commit` accepts
  a validated whole-project edit. Both require project ID and expected revision,
  support dry run and use the existing registry. Commits use canonical history.
  A Classic project cannot also contain a native timeline or native media list.
- `timeline.hyperframes.import` now branches on the document representation.
  For Classic it inserts a `graphic` element with definition `hyperframes` into
  the active scene's existing graphic lanes, using the 120,000-tick clock.
  The source lives once in `hyperframesCompositions` in the same Classic project.
  Omitted position appends to the active scene; explicit position overlays.
  Other scenes and the main project's duration are handled independently.
- The existing Classic timeline element, effect, mask, caption and Parallax data
  remains intact. Root/native FFmpeg rendering explicitly rejects Classic
  documents until routed to their renderer. The graphic definition, live preview
  adapter and import UI are not installed yet; this is not a usable import flow.
- The WASM `invokeSync` entry point uses the same live registry for an explicit
  list of immediate transactions. Async/native operations are rejected through
  this entry point. The tests exercise attach, import, read, commit, undo and redo
  through the real JS/WASM boundary, without an asynchronous gap in a command.
- Classic's history snapshot codec now preserves the complete project and scene
  fields while stripping transient audio buffers and excluding thumbnails from
  history. Storage serialization/deserialization likewise retains additional
  project and scene fields. A shared Classic fixture checks Parallax, captions,
  masks, effects, retiming, fonts, agent history, future fields and exact source
  text through registry edits, undo, redo, serialization and reopen.
- The bridge preserves exact `30000/1001` frame rates. Converting that value back
  from rounded decimal seconds would otherwise change the Classic clock.
- `project.classic.session.attach` can now adopt the current Classic document
  and both existing history stacks atomically into an empty runtime. Every
  boundary is validated against the same project before anything changes;
  stacks retain their order and support dry run and retry keys. The matching
  `project.classic.session.read` returns the canonical session for persistence.
  Inert host context travels with each undo/redo action so the UI can restore
  selection or identify a media side-effect callback. Rust never executes that
  context. The host now reconnects live command callbacks and its project/media
  views when it adopts that session.
- History undo/redo now checks explicit project and revision context before
  changing either stack. MCP treats Classic attachment as a lifecycle action,
  so it does not try to activate a project that has not been adopted yet.

### Classic CommandManager integration

- `CommandManager.enableCanonical()` lazily adopts the current project and both
  history stacks. New imports call `timeline.hyperframes.import` inside a
  canonical transaction, then publish the resulting scenes into the existing
  managers. No additional timeline or history stack is retained in JavaScript.
- Ordinary project and media setters validate their durable state in Rust before
  publishing it. Scene track/list updates publish only after project validation;
  deleting the active scene selects a surviving main scene. Preview commits also
  enter CommandManager before changing committed tracks.
- Nested commands share one transaction. Failed edits restore the canonical
  document, views, selection and redo history. Registry change notifications wait
  until commit, and rollback removes canceled retry receipts while retaining
  earlier successful receipts.
- Live callbacks preserve Classic's selective undo behavior and media add/remove
  side effects. Redo updates the previous-selection context, so its next undo
  returns to the selection made immediately before redo. Existing asynchronous
  media-file persistence still has its original failure handling; this bridge
  does not make those external writes transactional.
- Classic keeps its full live history, including more than 200 actions. Compact
  persistence retains the existing 100-entry limit and stops at commands with
  nonpersistent media side effects. Reopened history uses canonical snapshots.
  Media file/URL handles stay in the host and are excluded from the archive.
- `project.classic.session.archive`/`restore` store immutable source packages once
  per SHA-256 fingerprint. Both in-memory history and restored boundaries share
  source references. Corrupt, missing or mismatched source references reject the
  entire restore. Unknown composition properties remain intact.
- `project.classic.session.status` reads revisions, availability and inert
  selection/callback context without serializing source packages.
  `project.classic.synchronize` preserves existing history for host refreshes.
- Real-WASM CommandManager tests cover adoption, mixed import, selective undo,
  selection, nested commands, rollback, media callbacks and compact reopen. The
  import chooser, graphic definition, preview, export and browser verification
  remain pending. Ordinary Classic sessions load this module only when needed.

### Classic reference probe and history cost

A local Node/WASM probe imported the seven Brag projects with authored durations
into the existing Classic fixture, preserving its main video lane and prior undo
entry. It then committed 20 edits, undid all 20, exported both history stacks and
adopted the saved session into a fresh runtime. Source text, timeline content and
both stacks matched. The eighth project still needs its generated duration.

On this machine, runtime setup took 496 ms, source imports took 2.8–18.2 ms and
the median full-document commit took 9.1 ms (maximum 17.1 ms). These measurements
exclude media copying, rendering and browser UI work; they do not establish
playback performance. The source document was 2,190,960 bytes, but serializing
history produced 51,791,348 bytes. Process RSS reached 601 MB while holding two
WASM runtimes, JS snapshots and the round-trip archive.

After source sharing and compact persistence, the same source document and 20
edits produced a 2,343,201-byte archive. Process RSS was 151 MB with the same
two-runtime round trip. Setup took 580 ms, imports 1.6–21.9 ms, and full-document
commits a median 6.5 ms (maximum 9.0 ms). Source, both history stacks and existing
Classic tracks matched after restoration. These are Node/WASM storage and edit
measurements, not browser playback measurements. Probes are in ignored
`.local/hyperframes-classic-probe*` and `hyperframes-classic-compact-probe*` files.

## Preview cache verification (2026-10-04)

Classic now compares the bound resource values before invalidating HyperFrames
rendering. Canonical media republishing, loading notifications, names, thumbnails
and unrelated media no longer dispose the capture client. File/URL replacement,
binding revision, missing state and storage metadata still invalidate it. Values
are copied for comparison so in-place relinking is detected. Dependencies of
previously cached sources remain observed until reset, including after deletion
and restoration through Undo. Project/account changes invalidate old contexts.

The render client retains up to 24 decoded frames, capped at 64 MiB of estimated
RGBA storage. It reuses them across render-tree rebuilds and identical source
copies; eviction and disposal close the ImageBitmaps. Oversized frames are drawn
and immediately released. In-flight decoding after cancellation also releases
its bitmap without drawing. These are derived rendering caches; canonical editor
state and history remain in Rust.

An authenticated API probe used the imported synthetic GSAP folder at 640×360.
The first frame took 999 ms including session startup. Twenty identical-time
requests after cloning the projected document/media took 0.49–0.76 ms each and
made no additional capture requests. An uncached seek took 53 ms. Resetting the
cache and recapturing the original frame took 2,120 ms, including session close
and reopen. The decoded RGBA hash matched after reset, while seeking changed the
pixels. This probe decodes with Sharp and excludes browser/GPU paint time;
it is not a real-time playback benchmark. Evidence and the repeatable probe are
in ignored `.local/hyperframes-cache-proof.json` and `.local/hyperframes-cache-proof.ts`.

The actual editor also rendered a mixed native/HyperFrames timeline after moving
the red composition 48 px and restoring its position with Undo. The cache tests
cover bounds, cancellation, resource changes, source edits and account/project
switching. A separate real-WASM CommandManager test performs 20 canonical edits
plus Undo/Redo: media objects are republished while one open and one capture serve
all rendered requests. Fresh-frame capture, audio, multiple-composition browser
churn and the fast live preview remain outstanding.

## Runtime layers and Classic inspector (2026-10-04)

The isolated capture host now reads the official `__clipManifest` after runtime
readiness. Rust validates and persists its source fingerprint, runtime version,
resolved duration, bounded layer list, parent occurrence keys, package paths,
timing, media offsets/rates, natural durations and authored audio attributes.
Temporary preview URLs and host filesystem paths are not stored in the manifest.
Original source bytes remain the editing authority.

- `hyperframes.manifest.validate` is a closed-world Read capability.
  `hyperframes.manifest.set` updates an existing composition through a closed-world
  Write transaction with project/revision checks, idempotency, cancellation,
  dry run and undo. Folder import can commit the manifest with its resources and
  clip in the same transaction. Native and Classic documents use the same model;
  the browser UI is Classic-only. Live desktop MCP forwarding remains pending.
- The Graphic inspector shows a searchable, indented list of layers and their
  source times. Each row expands to show its file, media reference and timing.
  Rendering starts with 100 rows and offers more on demand. Existing imports can
  read their layers without reimporting. This operation reuses the project preview
  client, checks its scope and resource revision, and publishes through the
  canonical CommandManager. Local component state is limited to search, progress
  and disclosure controls.
- Preview clients release their sessions and decoded frames on a non-persisted
  `pagehide`, including reload/navigation. A page retained in the browser's
  back/forward cache keeps its client. This avoids consuming capture slots until
  idle expiry when the old document is already gone.
- Identity uses runtime IDs and composition ancestry, with a distinct DOM path
  for each occurrence. Repeated nested hosts are tested. Anonymous or ambiguous
  nodes retain observed timing and diagnostics without guessed source identity.
  The runtime list is not a complete inventory of every untimed decorative node.
- All eight Brag references loaded and yielded 176 layers, including 12 audio
  occurrences and 13 videos. The v2 recreation has 10 layers with unresolved DOM
  identity; the full reconstruction has 30. All media occurrences were observed.
  Narration, music and impact paths, timing and authored volumes were retained.
  Evidence: `.local/hyperframes-manifest-probe.ts` and its results JSON. This probe
  does not modify the Brag folders.
- The existing mixed Classic project displayed the image layer, package media
  path and 0–4s range. Reading layers on older imports persisted to the project;
  UI Undo/Redo removed/restored the manifest while keeping the clip and native
  tracks. A source containing only untimed CSS decoration can report zero layers.
- The actual Brag `advanced-audio-test-final` folder imported through the directory
  picker and appended at 8–14s, keeping the existing native and HyperFrames clips.
  Its four layers (Narration, Opening, Claim and Proof) appeared immediately with
  their resolved source times; the preview displayed its opening at project time
  9s. Reload preserved all four layers, the imported media and timeline placement.
  Layer search and source-file details worked after reopen. Hashes of all source
  strings and three copied binary resources match the originals, and all uploads
  were finalized. Evidence: `.local/verify-hyperframes-brag-proof.ts` and
  `.local/hyperframes-brag-import-proof.json`.
- Reload testing exposed intermittent black previews in the in-app browser.
  The same saved project rendered correctly in a fresh tab and on some reloads;
  other reloads kept the canvas black while seeking and playback time advanced.
  The capture endpoint still returned the correct Brag frame (saved as
  `.local/hyperframes-brag-reopen-frame.png`). Temporary diagnostics also recorded
  completed compositor renders during a black-preview run, without a console
  error. A later reload showed the correct frame and selection handles. The
  cause is unresolved; no speculative rendering fix or diagnostic code is
  included in this change. Reopen data preservation is verified, but reliable
  preview restoration needs a regression fix and repeatable browser coverage.

The inspector is read-only. Expandable child rows in the existing timeline,
child edits, variable editing, audio mixing/export and fast playback remain
outstanding. A manifest records observations; it does not implement audio
playback or guarantee identity for generated anonymous elements. Replacing bound
media invalidates rendering, but stored natural durations require another read.

## Preview startup and recovery (2026-10-04)

- A native-only control project rendered its blue image and green overlay after
  reload. The mixed project also rendered correctly during later reloads and
  seeks. Temporary pixel probes observed valid source and compositor pixels;
  they changed timing and do not identify the intermittent black-preview cause.
- A separate startup race was reproduced: project loading can request its
  thumbnail before the concurrently started GPU is ready. `CanvasRenderer` now
  waits for the shared GPU initialization before mounting or rendering output.
  Failed initialization can be retried. This applies to native and HyperFrames
  projects, preview, thumbnails and export consumers of that renderer.
- Preview renders lasting more than 250 ms show “Preparing preview…”. A failed
  render or canvas mount shows an error and a “Retry preview” button. Retrying
  also retries the canvas mount; it preserves the timeline and current time.
  Timers are cleared on completion and unmount. Fast frames do not display the
  preparation notice.
- Browser verification injected one temporary capture failure at project time
  9.5 s (Brag source time 1.5 s) in the isolated test account. The error appeared;
  clicking Retry preview reopened capture and displayed the correct Brag frame
  at the same time. The temporary server fault and pixel probes were removed.
- One regression test (13 assertions) covers delayed shared GPU startup,
  initialization failure, retry, thumbnail consumption and preview mounting.
  Four queue/output-scaling tests (11 assertions), scoped TypeScript and changed
  file ESLint also passed. This is a verified startup fix and failure-recovery
  improvement; reliable recovery from the separate intermittent black preview
  remains unproven.

### Audio rendering adapter (2026-10-04)

The pinned engine exports `parseAudioElements` and `processCompositionAudio`.
Its mixer owns fades, rate changes, effects, groups and automation, and writes
`audio.m4a` to preserve AAC priming metadata. The producer first resolves nested
media occurrences and then probes timeline volume changes before calling that
mixer. Reading only `<audio>` tags or copying the layer manifest is insufficient
for parity. The Classic host now uses these public engine APIs, the public core
media occurrence/group stamping helper and its volume-envelope probe. Timing
comes from the validated runtime manifest. A disposable page samples volume,
so future GSAP state cannot leak into the page used for visual capture.

- `hyperframes.audio.prepare` is a pure, cancellable Read capability in the
  canonical registry and WASM wrapper. It binds observations to the exact source
  fingerprint and pinned runtime, validates registered resource references,
  bounds timing/gain/rate/envelopes/effect JSON and checks consistent group
  settings. It replaces author-controlled mixer filenames with ordinal IDs.
  This derived plan does not alter the project, history or original source.
- The authenticated Classic render host exposes an `audio` action on an existing
  account/project-scoped session. It serializes audio work, shares concurrent
  requests, caches the artifact, checks expiry/eviction, supports cancellation,
  and keeps the visual session alive during mixing. Output uses the existing
  bounded ArtifactStore and scoped artifact reader. This is a Classic-only host
  adapter; native rendering and playback are not migrated by this change.
- Resource staging copies only registered inputs under generated filenames in
  a host-created scratch directory. FFmpeg/FFprobe paths are host configuration.
  The official media probe discovers audio in videos without authored metadata
  and skips silent videos. Authored mute, hidden ancestors and hidden buses are
  retained. Mixer failures and degraded automation fail explicitly.
- Work limits: 30-minute composition, 32 media nodes in the browser probe,
  32 planned tracks, one hour combined track duration, 100,000 envelope samples,
  4 MiB plan, 512 MiB staged resources and 64 MiB output. Audible looping media,
  unresolved source identity, media outside the imported package and clip windows
  outside root or nested composition bounds are rejected explicitly. Silent looping videos
  are skipped. These cases need further support before full parity is claimed.
- `classic/scripts/build-hyperframes-audio-probe.ts` regenerates the browser
  helper from pinned core implementations. Its Apache license and attribution
  are included under `classic/licenses` and `classic/THIRD-PARTY-NOTICES.md`.

Verification:

- 29 Rust import/package/manifest/audio tests passed. Five audio tests cover
  invalid plans, source/resource boundaries, cancellation, safe IDs, repeated
  preparation of 12 independent buses, nested-window preflight and unchanged
  canonical state. A real Chrome probe of nested audio extending past its host
  timed out; the canonical manifest check now rejects that unsupported window
  before evaluating the audio probe in the page. Cleanup of that fixture still
  reaches the engine timeout and forces browser shutdown; faster cleanup remains
  a follow-up.
- Nine real Chrome capture/audio/host tests passed (119 assertions), including
  repeated nested audio, timing, rate, fades, separate group gain, authored mute,
  GSAP volume above unity, video stream discovery, audio artifact ownership,
  concurrent cache reuse and continued visual capture after audio probing.
  Decoded PCM verifies the expected silent gaps and per-channel RMS amplitude.
- All eight Brag references rendered audio through the host. The six-second
  `advanced-audio-test-final` narration has zero sample offset against its source
  at 8 kHz, correlation 0.9999189 and gain 0.998223 after AAC encoding. Decoded
  output includes 16 ms trailing codec padding; timeline playback must use the
  canonical six-second clip window. This is audio-source comparison, not a
  downloaded mixed Classic export comparison.
- Local evidence: `.local/hyperframes-audio-probe-results.json`,
  `.local/hyperframes-audio-correlation.json` and
  `.local/hyperframes-brag-audio-0.m4a` through `-7.m4a`.
- The actual authenticated `/api/hyperframes` route also rendered narration from
  the imported mixed Classic project. Artifact checksum matched the standalone
  probe, a repeated request reused the same handle and another project received
  HTTP 404. Evidence: `.local/hyperframes-audio-api-proof.json` and
  `.local/hyperframes-brag-audio-api.m4a`. The isolated test server was restarted
  after rebuilding WASM so its process held the new runtime and host class.
- Scoped TypeScript, changed-file ESLint, editor-api Clippy, WASM export checks
  and nine real-WASM CommandManager tests (129 assertions) passed.

### Classic timeline audio connection (2026-10-04)

- `hyperframes.audio.clips.read` reads a project, scene and exact revision from
  the canonical runtime. It projects compound placement, trim, gain and volume
  animation into existing Classic audio mixer inputs. These are derived views;
  no additional document tracks or history entries are created. Source duration
  bounds exclude AAC padding. Visual hiding does not mute audio; explicit clip
  or track mute does. Graphic looping/retime remains unsupported by the visual
  source and is not introduced only for audio.
- The account/project-scoped render client checks artifact size and SHA-256,
  shares duplicate requests, caches silence, and retains at most eight audio
  files / 64 MiB. Resource replacement and project/account changes invalidate
  audio and frames together. Failed reads can be retried.
- Playback waits for compound audio through its existing preparation mechanism.
  The same clips feed export's decode cache, gain automation and mastering.
  Decode/mixer failures fail the operation; playback displays the error and
  pauses. Export cancellation now covers audio preparation as well as frames.
  The existing parallax playback mapping also receives these derived clips.
- Native Rust and real WASM tests cover placement, trim, authored duration,
  hidden/muted behavior, revisions, source identity, unchanged state, host edits
  and Undo/Redo. Collector tests verify shared decoding across multiple cuts and
  propagation of missing-audio errors. Thirty targeted Rust tests passed, as did
  ten real-WASM CommandManager tests (138 assertions), six audio client/cache
  tests (185 assertions), and one collector test (six assertions). Scoped
  TypeScript, changed-file ESLint, editor-api Clippy with `-D warnings`, release
  WASM build, and the 37 legacy / 13 canonical export checks passed.
- An actual audio-enabled Classic export produced a 14-second H.264/AAC MP4
  (640x360, 44.1 kHz stereo, 814,607 bytes). It contains native narration at
  0–5 seconds and the Brag composition at 8–14 seconds. Decoded PCM compared
  against the original narration at 8 kHz has zero lag for both, correlation
  0.999953 for native audio and 0.999871 for compound audio; the 5.2–7.8-second
  gap has zero RMS. The frame at 9.5 seconds shows the expected Brag text/circle.
  Evidence: `.local/hyperframes-native-and-brag-audio.mp4`,
  `.local/hyperframes-export-audio-check.json`, and
  `.local/hyperframes-audio-export-frame.png`. Export cancellation also returned
  the normal export form through the UI. Playback preparation completed and the
  playhead reached the end; audible live playback and smooth performance have
  not been established by this export check.
- Splitting the Brag clip through the normal timeline toolbar at 9.5 seconds
  (source offset 1.5 seconds) and exporting again preserved the entire decoded
  audio exactly. Both MP4s decode to the same float PCM SHA-256,
  `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  The split export passes the same timing/correlation checks. Evidence:
  `.local/hyperframes-split-native-and-brag-audio.mp4`,
  `.local/hyperframes-split-export-audio-check.json`, and the actual editor
  screenshot `.local/hyperframes-split-audio-timeline.png`. Undo through the
  editor restored the single compound clip after this check.
- Adding the imported narration resource as an ordinary native clip defaulted
  to five seconds because package resource metadata lacks its media duration.
  The native comparison above uses that actual five-second clip. Resource
  metadata probing is a follow-up; the compound itself retains its six seconds.
- Transcription and standalone audio extraction use separate entry points and
  do not yet include compound audio. Child audio controls, waveform display,
  live preview performance and the remaining unsupported nested windows need
  follow-up work.

### Composition layers inside existing tracks (2026-10-04)

- `hyperframes.layers.timeline.read` projects one Classic compound clip into
  ordered child rows. Rust preserves occurrence keys and hierarchy, intersects
  each layer with its ancestor windows and the compound's trimmed source window,
  and returns timeline ticks. Reads require an explicit project, scene, element
  and revision. No source execution, document changes or additional tracks occur.
- Existing track headers expand/collapse these rows beneath the compound. Labels
  remain in the fixed column, time bars share the existing ruler, and both use
  the same height in scrolling, selection and drop geometry. Rows are rendered
  only near the vertical viewport and bars near the horizontal viewport. Native
  clips, keyframe expansion and the existing timeline remain in place.
- Clicking a row selects its compound and seeks to that row's timeline start.
  This respects the existing AI range lock. Expansion is temporary view state;
  timing/identity are read from the canonical registry after edits and history
  changes. Projects lacking a runtime manifest direct the user to read layers
  in the inspector.
- Actual Brag UI verification: Narration spans 8–14 seconds, Opening 8–9.75,
  Claim 9.75–11.6 and Proof 11.6–14. Clicking Claim seeks to 9.75 seconds.
  Splitting there leaves Opening in the left clip, Claim/Proof in the right,
  and clips narration to each side. Undo restores the original four rows.
  Collapse restores ordinary track height. Enter expands the row without
  invoking the global jump-to-start shortcut; Space activates Proof at 11.6
  seconds without starting playback. All eight visible layer buttons become
  disabled while AI range selection is armed and recover when cancelled.
  Evidence: `.local/hyperframes-expanded-timeline.png`. Independent child timing/source
  edits are still pending; these bars currently navigate and show structure.
- Fourteen Rust source/manifest/Classic-layer tests, ten real-WASM command tests
  (141 assertions), thirteen existing track visibility/hit-testing tests
  (17 assertions), scoped TypeScript, changed-file ESLint and editor-api Clippy passed. Release WASM
  and its existing export contract were rebuilt and verified.

### Preview capture resolution and measured cost (2026-10-04)

- The persistent screenshot adapter now samples previews at the resolution
  needed by the output canvas and the resolved layer scale. It rounds upward
  to 1/8, 1/4, 1/2 or full resolution. The authored CSS viewport, source size,
  timing, source package and canonical document remain the same. Only derived
  PNG pixels change. The existing Classic compositor still controls layer order,
  transforms, opacity, masks and native/HF combinations.
- Preview frame and GPU invalidation keys include sampling resolution. Export
  forces full source resolution and cannot reuse a reduced preview bitmap.
  Capture options change only inside the serialized queue and are restored
  afterward. PNG header dimensions are checked and stored in ArtifactStore.
  Perspective, clip effects, scene effects, nested scenes and parallax retain
  full source captures because subsequent camera/effect stages can magnify them.
- On Windows / HeadlessChrome 152, three real Brag packages were sampled at
  0.5–1.067 seconds (18 sequential frames, first three omitted from statistics).
  The software-rendered host's median request-to-artifact times were:

  | Package | Full source | Half dimensions | Quarter dimensions |
  | --- | ---: | ---: | ---: |
  | `advanced-audio-test-final` | 153.8 ms | 64.4 ms | 50.4 ms |
  | `brag-vertical/composition` | 369.6 ms | 135.0 ms | 74.0 ms |
  | Reconstruction 96.9-second composition | 98.6 ms | 89.9 ms | 81.1 ms |

  These measure the isolated render host, excluding editor transport, bitmap
  decode and composition. The third sample covers only its opening second;
  it does not establish performance or repeatability of its later 3D scenes.
  At a fixed 1080x1920 frame, PNG screenshot encoding itself took 277 ms with
  hardware acceleration, versus 118 ms at half dimensions. WebP was not a
  consistent improvement: its 85-quality path was slower on partial-alpha
  content. Hardware acceleration alone did not remove the capture bottleneck.
  The product retains its existing PNG/software path with adaptive preview
  sampling. This is an interim improvement; a live DOM preview path is still
  required for smooth playback. Full intrinsic offscreen targets remain in use.
- Browser tests verify partial alpha, nested content at the source's far edge,
  forward/reverse seeks, concurrent mixed-resolution requests, invalid sampling
  rejection, and exact full-resolution pixels after a preview request. Cache and
  real-WASM scene-builder tests verify viewport resizing, source trim/placement,
  one shared browser, and full-resolution export. The real capture/host suite,
  frame cache/client tests, scoped TypeScript and changed-file ESLint passed.
  Eight existing transform, static-cache and frame-scaling checks passed using
  a local preload of the actual Classic WASM; their default Bun invocation
  still needs a harness fix for the generated `.wasm` module import.
- The actual Classic UI sought among Brag sections and exported the mixed
  14-second project after reduced preview captures. Its entire decoded video
  and float PCM exactly match the earlier full-resolution export:
  video SHA-256 `b76a85a1dc793e6618def4ebf34a1a458ae1e3871433b8fcc04eb1a112b73631`,
  audio SHA-256 `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  Evidence: `.local/hyperframes-after-preview-scaling.mp4`,
  `.local/hyperframes-scaled-preview.png`, `.local/hf-perf-software.json`,
  `.local/hf-perf-scaled-0.5.json`, `.local/hf-perf-scaled-0.25.json`, and
  `.local/hf-encoding-benchmark.json`. Sampling decisions and capture caches are
  platform rendering resources, so this adds no editor state or MCP mutation.

### Isolated live DOM preview (2026-10-04)

- The existing Classic preview now places an eligible topmost HyperFrames DOM
  layer over the compositor canvas. It uses the same render-tree timing, source
  trim, animation resolution, fit, rotation, scale, flips and opacity as the
  capture path. The authored viewport stays at its intrinsic dimensions and the
  surface scales to the existing preview. Native layers below it still render
  through the shared compositor. Selection handles and timeline navigation stay
  in the existing editor. Export always uses the complete capture/compositor path.
- Eligibility is deliberately limited to an unmasked, normally blended topmost
  compound without clip/scene effects, perspective, parallax or nested scene
  rendering. The isolated bridge rejects video/canvas layers, external resources,
  runtime failures and unsupported navigation. These cases automatically use
  the existing capture adapter; they remain supported by that adapter. General
  interleaving of native and multiple DOM surfaces is still pending.
- Live delivery is opened through the account/project-scoped render session. A
  trusted outer shell constrains the authored inner frame to its random package
  origin, including after attempted navigation. Both frames have opaque sandbox
  origins. Their only accepted commands are sequenced seeks; acknowledgements
  never invoke editor actions. CSP limits live resources to the registered
  package. Closing the session revokes delivery. The existing preview byte/count
  limits include the generated shell.
- Classic remains the audio owner. The bridge mutes media elements and runtime
  output, and prevents Web Audio nodes from connecting to the physical output
  destination while leaving analysis graphs usable. A browser test explicitly
  enables autoplay, starts authored audio and an oscillator, and verifies muted
  media plus zero connections to the output device. This avoids relying solely
  on the browser's autoplay permission policy.
- One of the client's existing two session slots is reserved for the current
  live surface. Preparing audio, thumbnails or captures for other compositions
  cannot evict its resources. Export, disposal and a return to capture release
  that reservation; both slots remain available to mixed-frame rendering.
  A replaced handle cannot release the new reservation. Switching project/account or replacing a resource
  still invalidates the derived resources. No additional editor state, timeline,
  document migration or mutation capability was introduced.
- Two real Brag packages were compared at source times 0.5, 2.5 and 5 seconds:
  `advanced-audio-test-final` (720x1280) and `brag-vertical/composition`
  (1080x1920). All six full-resolution RGBA comparisons were exact. In the latest
  software-Chrome run, 90 sequential seeks per package (first five excluded)
  had median acknowledgement times of 1.5 and 1.9 ms, with p95 of 2.6 and 8.2 ms.
  These timings measure the isolated live seek/relay, excluding paint, native
  composition and editor scheduling; they are not end-to-end playback FPS.
  The 96.9-second reconstruction correctly chose capture because it has canvas
  content. Its later 3D repeatability remains unverified.
- Tests cover fractional-frame flooring, repeated/reverse seeks, partial alpha,
  navigation blocking, media/Web Audio silence, exact account/project ownership,
  session close revocation, source revision invalidation, bounded session
  retention during other renders, canonical trim/transform projection, layer
  order, export exclusion, reservation release and runtime fallback. The real capture/live/host suite
  passed seven tests (102 assertions); the scoped cache/host/client and real-WASM
  renderer suites also passed. Actual UI playback reached the mixed project's
  end with the live surface still present after audio preparation.
- The actual 14-second mixed-project export after this change is identical to
  the previous capture-only preview export after decoding: video SHA-256
  `b76a85a1dc793e6618def4ebf34a1a458ae1e3871433b8fcc04eb1a112b73631`,
  float PCM SHA-256
  `ec8789f5357f8901da85d1f8f44a17fc872ef80e745bec7f875d4b9fdf397e43`.
  The DOM surface was removed during export and restored afterward. Scoped
  TypeScript, changed-file ESLint and eight existing transform/static-cache/
  output-scaling checks (with the local real-WASM preload) passed.
- Local evidence: `.local/hf-live-benchmark.json`,
  `.local/hyperframes-live-benchmark.ts`, `.local/hf-live-*-*.png`,
  `.local/hyperframes-after-live-preview.mp4` and
  `.local/hyperframes-live-preview.png`.

### Native layers above live DOM compositions (2026-10-04)

- The topmost restriction described above is lifted for ordinary native layers
  using normal blending. The preview derives a native base and foreground from
  the existing render tree, places the live compound between them, and preserves
  the original order. Text, image, video, sticker and graphic nodes remain on
  their existing renderer paths. No document fields, editor state or capabilities
  were added; this is a Classic-only rendering improvement.
- The shared compositor prepares both native groups before submitting their
  output. It copies the foreground with transparent pixels into a separate canvas,
  then restores the opaque base without an asynchronous gap between submissions.
  A `copy` operation clears pixels from moved or ended clips. Texture IDs are
  distinct between the groups, and both groups are synchronized together so
  alternating renders do not evict and re-upload their textures every frame.
- The compositor's WebGPU surface now requests premultiplied output. This is
  restricted to compositor surfaces; other GPU effect-output surfaces retain
  their existing configuration. wgpu 29's browser implementation accepts this
  mode despite listing only Opaque in its capabilities. WebGL retains its
  supported surface mode and default alpha/premultiplied-alpha context settings.
- Direct browser checks with the rebuilt WASM passed on WebGPU and forced WebGL:
  empty pixels are `[0,0,0,0]`, half-alpha red at half opacity produces
  `[255,0,0,64]`, the sampled hybrid foreground/base matches the complete GPU
  composition exactly, and an ended foreground leaves no pixels. These are
  controlled 64x36 alpha/compositing checks, not complete media or FPS coverage.
- In the actual Classic UI, an ordinary text clip was added above the imported
  `advanced-audio-test-final` compound at 10.5 seconds. Content, font size,
  position and 0.65 opacity edits kept the live iframe visible with a native
  foreground canvas. Multiply removed the live surface and used capture;
  returning to Normal restored the live surface and foreground. Seeking beyond
  the compound's end removed the live surface; seeking backward restored it.
- The test text was temporarily removed to export the same 14-second baseline.
  The downloaded MP4's decoded video and float PCM hashes exactly match the
  hashes recorded in the preceding section. Undo restored the native text after
  export, and the live preview resumed with the foreground canvas. The verified
  export is `.local/hyperframes-after-native-live-overlay.mp4`.
- Renderer startup/queue tests passed two tests (23 assertions), the real-WASM
  scene/live tests passed three (35 assertions), and eight existing transform,
  static-node and output-scaling checks passed (19 assertions). Tests cover
  foreground order, native blend fallback, source timing, non-mutating tree
  partitioning, texture ID separation and opaque-base restoration even if the
  foreground copy fails. Scoped TypeScript, changed-file ESLint, targeted Rust
  formatting and both WASM export manifests passed.
- One compound is live at a time. Other HyperFrames compounds in the base still
  use capture. Backdrop-dependent native blend modes, scene effects, camera,
  parallax and unsupported compound content retain the full capture path.
  Multiple live surfaces, native video-specific browser checks, dynamic source
  changes and measured end-to-end playback FPS remain pending.
- Evidence: `.local/hyperframes-native-text-live.png`,
  `.local/hyperframes-with-live-native-overlay-project.json`,
  `.local/hf-overlay-gpu-probe.html`, `.local/hf-overlay-webgpu-result.json`
  and `.local/hf-overlay-webgl-result.json`.

### Measured Classic playback and remaining capture bottleneck (2026-10-04)

The editor now has an opt-in playback probe at `?renderPerf=1`. It records
completed preview frames, distinct timeline frames, gaps between those frames,
render duration, lag behind the existing playback clock and failed renders.
Preparation and paused editing are excluded. Seek, stop and disposal delimit
measurement windows, and stale in-flight frames cannot contaminate a later run.
Windows contain at most 240 completed samples. Console output stays local and
contains numeric diagnostics rather than source content. The existing pipeline
profiler also emits a JSON summary for inspection.

For controlled comparisons, adding `&hyperframesPreview=capture` disables live
surfaces for that document while retaining the same project, source, audio,
native renderer and preview resolution. This override requires diagnostics to
be enabled and does not change the saved project or export behavior.

Two six-second benchmark projects were prepared through the existing scoped
project/media APIs using the imported `advanced-audio-test-final` source. Both
use a native blue image, native translucent text and the compound's audio. The
second places two occurrences of the **same source and time** side by side.
This does not establish performance for different source packages.

| Actual editor scenario | First / repeated completed frames per second | First / repeated median render time | First / repeated p95 render time |
| --- | --- | --- | --- |
| One live compound between native layers | 29.24 / 29.21 | 3.1 / 3.0 ms | 7.0 / 6.5 ms |
| Same project, capture override | 10.00 / 9.17 | 75.6 / 82.7 ms | 127.4 / 154.1 ms |
| Two occurrences, current one-live/one-captured path | 9.84 / 9.84 | 79.0 / 81.4 ms | 139.3 / 129.9 ms |

- Target: 30 fps. Each run lasted approximately six seconds and reported zero
  render errors. The live runs completed 175 distinct frames each. The capture
  runs completed 60 and 55; the two-occurrence runs completed 59 each. The latter
  had mean transport lag around 80 ms. These are render-completion rates in the
  actual Classic UI, including source resolution and native composition, not
  physical display-refresh measurements or isolated seek acknowledgements.
- Environment: the same local Next.js webpack development server and Codex
  in-app browser, a 1280x720 browser viewport, DPR 1, a 640x360 logical scene and
  a 451x253 compositor output. The browser panel was hidden and the document
  reported `visibilityState: visible`. Production builds, visible-panel timing,
  full-screen playback and other devices remain unmeasured.
- The repeated two-occurrence pipeline summary attributes about 81.5 ms per
  frame to source resolution (two measured groups), about 1 ms to the two GPU
  submissions, and about 0.4 ms to texture synchronization. The existing generic
  `preview.frame.interval` statistic includes pauses between runs; use the new
  playback-only reports for throughput. Capture remains the dominant cost.
- These measurements identified the need for multiple live occurrences and
  explicit session lifetimes. At that checkpoint, one live surface pinned one
  of two client sessions and retained a headless capture browser. The host
  separation below removes the retained browser; the subsequent multiple-live
  implementation also removes the measured extra screenshot from this case.
- Probe tests passed three tests (nine assertions), covering disabled and paused
  collection, duplicate frames, late completion after seek/pause, bounded
  windows and failure counts. Scoped TypeScript including the new tests and
  changed-file ESLint passed. No canonical state or capabilities were added.
- Local evidence: `.local/hf-editor-playback-benchmark.json` (six raw reports
  and pipeline summaries), `.local/hf-playback-fixtures.json`,
  `.local/hf-playback-fixtures.ts`, and
  `.local/hf-playback-two-compositions.png`. Benchmark project IDs are
  `e8b3c007-9ed8-4cd1-a75f-c04c394814e9` and
  `28760c93-3b7d-4ff2-98b9-026ae72e0597` in the isolated integration account.

### Release capture browsers while live previews are displayed (2026-10-04)

The Classic render host now retains validated metadata, source resources and
live delivery independently of its headless capture browser. Promotion to a
live preview closes Chrome and revokes its original capture URL. A subsequent
screenshot or export opens a new sandboxed capture on demand. Returning to
live delivery closes that capture and reuses the existing live URL.

- Each scoped entry serializes screenshots and promotion. An active capture
  finishes before its browser closes; queued capture cancellation does not
  interrupt an earlier frame. Closing the entry aborts loading and queued work.
- The host retains at most six scoped entries. The existing four-browser and
  eight-origin bounds remain. Six live delivery origins leave two origins for
  one screenshot session and one disposable audio probe. This is a bounded
  resource budget, not a promise of six simultaneously displayed UI surfaces.
- Heartbeats retain metadata and live resources without launching Chrome.
  Entries idle for two minutes expire even after their capture browser has
  closed. Completed artifacts retain their normal scoped ArtifactStore lifetime.
- Two real-browser tests passed with 61 assertions: exact account/project
  isolation, original URL revocation, identical PNG after reopen, reduced-size
  capture, stable live URL, six retained live sources, audio probe capacity,
  entry limits and slot reuse. Four controlled lifecycle tests passed with 24
  assertions, including overlapping promotion/capture, lazy-open cancellation,
  queued cancellation and idle expiration. Scoped TypeScript and changed-file
  ESLint passed.
- Actual Classic UI verification used the existing six-second Brag benchmark:
  playback completed 169 distinct frames at 28.21 fps with zero render errors
  (development build, same 451x253 compositor viewport). MP4 export then
  reopened capture successfully: 180 H.264 frames at 640x360 plus AAC audio,
  420,573 bytes. FFmpeg decoded both streams without errors. Seeking to 2.5 s
  after export restored the live composition and native foreground text; the
  development server had no remaining Chrome child. This is a lifecycle
  regression check, not evidence of a throughput improvement over the previous
  single-live measurement. Evidence: `.local/hf-after-capture-release.mp4`,
  `.local/hf-after-capture-release.png` and
  `.local/hf-after-capture-release-playback.json`.
- This changes derived rendering resources only. Canonical state, timeline
  behavior and capabilities are unchanged. Multiple client leases, occurrence
  identity and multiple native/live segments were the next performance work,
  implemented and measured below.

### Multiple live compositions in the existing timeline (2026-10-04)

Classic now displays up to four eligible HyperFrames occurrences as independent
live surfaces. The scene builder supplies each canonical clip ID alongside its
source identity. Repeated source packages share delivery resources while each
iframe seeks its own trimmed source time and uses the clip's placement, opacity
and layer order. Reordering changes CSS stacking without reparenting iframes.

Native layers below, between and above these surfaces remain in the existing
GPU compositor. Each native segment above the base uses a transparent canvas.
All segments are prepared first, their textures are synchronized together under
distinct IDs, and their canvases are copied before the opaque base is restored
without an asynchronous gap. Ended native layers clear their previous pixels.

- The client reserves sources through independent, idempotent occurrence
  leases. Releasing one occurrence cannot evict another occurrence using the
  same package. Four source reservations leave one ordinary capture cache slot;
  releasing them trims back to the original two-session LRU.
- Effectful copies can still require screenshots while another occurrence of
  their source is live. Only one such pinned source keeps a warm capture browser;
  switching capture sources releases the previous browser through the existing
  host promotion while preserving its live URL. This leaves capacity for the
  ordinary capture slot and disposable audio probe.
- Backdrop-dependent blends and scene wrappers stay below the selected live
  surfaces. Masks, unsupported perspective, canvas/video content and runtime
  failures continue through the full capture path. Export retains that path.
  These limits remain part of the incomplete broader integration.

Actual playback of the unchanged two-occurrence Brag benchmark at 451x253
compositor pixels in the same development browser improved from **9.84 / 9.84
fps** to **28.37 / 28.85 fps**. The new runs completed 170 / 173 distinct frames
with zero render errors; median render time was 3.9 / 3.5 ms and p95 was 26.1 /
23.8 ms. This measures completed preview renders against the existing transport,
not physical display refresh. Production, full-screen and broader-project
measurements remain outstanding. Reports: `.local/hf-multiple-live-playback.json`.

The two-occurrence project exported both from live preview and from the capture
override. Both files are 528,101 bytes. All decoded video frames match
(`118e1939b029bff83bf52b6696b2ee023de8629ca5d4a04d2fbc787573abad12`)
and decoded float PCM matches
(`54b3d756f534a52c8aa4ccb7555c40b3d92f8ad656c9bfdfdc4e9692fe399f20`).
Evidence: `.local/hf-multiple-live-export.mp4` and
`.local/hf-multiple-capture-export.mp4`.

A separate isolated project (`fa29717a-140f-40e2-a2be-32f24aa601f6`) verified
overlapping occurrences with a one-second source offset, a native text layer
between them and another in front. At 1.5 s the compositions showed different
source states and correctly occluded the middle text. At 2.5 s that text had
ended and no yellow pixels remained visible. At 5.5 s the trimmed occurrence
had ended: only one iframe and one foreground canvas remained. Evidence:
`.local/hf-interleaved-fixture.ts`, `.local/hf-interleaved-live-1_5.png`,
`.local/hf-interleaved-live-2_5.png`, `.local/hf-interleaved-live-5_5.png`.

Verification: three real-WASM render-tree tests passed (62 assertions), seven
client/cache tests passed (236 assertions), and two renderer queue tests passed
(30 assertions). Coverage includes shared-source timing, canonical occurrence
IDs, native segments, reordering, blending fallback, the four-surface bound,
lease release, capture browser rotation, and uninterrupted GPU copy order.
Scoped TypeScript and changed-file ESLint passed. No editor state, capabilities,
source packages or saved production projects were changed by this adapter work.

## Four distinct packages and capture cache capacity (2026-10-04)

Two additional projects in the isolated integration account combine four
different imported sources: `brag-vertical/composition`,
`brag-reference-recreation-v2/composition`,
`brag-reference-recreation/composition`, and `advanced-audio-test-final`.
Each source has a distinct fingerprint. The four portrait compositions appear
side by side for six seconds over a native blue image, with native text between
the lower and upper pairs and another native text layer above them. All source
files and 98 resources per project match the earlier imports byte for byte.
The second project adds a ten-degree OpenCut perspective transform to the final
composition. At this checkpoint that required capture for the occurrence while
the other three remained live. The later Live OpenCut Perspective checkpoint
above removes this restriction. Original HyperFrames source files are unchanged.

### Capture cache fix

The previous client retained two unpinned sessions. Four different captured
sources therefore evicted each other within every frame and repeatedly launched
Chrome. Actual playback completed only one or two frames during a six-second
run. The client now retains up to four captured sources, within the existing
four-browser host bound. Four pinned live deliveries can still retain one spare
capture source. Before an uncached audio request, the client evicts unpinned
sessions to leave room for both source preparation and a disposable audio probe.
Live occurrence leases remain intact. Captured copies of live sources continue
to rotate one warm browser through the existing promotion path.

This changes derived rendering resources in Classic only. Canonical state,
capabilities, saved document data and rendering output are unchanged. The memory
tradeoff is up to four warm capture browsers instead of two. The host's six
entry, four-browser and eight-origin limits, and the client's 64 MiB frame cache,
are unchanged. Projects exceeding four simultaneous captured packages can
still churn this bounded cache.

### Actual editor measurements

Same development server/browser conditions as the earlier measurements:
1280x720 viewport, DPR 1, hidden browser panel with a visible document, 640x360
scene, 451x253 compositor output, 30 fps transport. Preparation before playback
is excluded. Each run lasts approximately six seconds. All runs below report
zero render errors.

| Scenario | Completed frames/s, successive runs | Distinct completed frames | Median render time, successive runs |
| --- | --- | --- | --- |
| Four different live packages | 24.00 / 28.89 | 144 / 173 | 10.5 / 4.4 ms |
| Same project, capture override before fix | 0.17 / 0.33 | 1 / 2 | 4358.4 / 3.1 ms |
| Same project, capture override after fix | 0.67 / 0.67 / 1.67 | 4 / 4 / 10 | 1172.9 / 792.9 / 567.7 ms |
| Three live packages plus one perspective capture | 2.50 / 5.34 | 15 / 32 | 187.5 / 177.7 ms |

The second pre-fix run completed only two cached early frames; its 3.1 ms
median excludes the unfinished capture and does not indicate fast playback.
The final post-fix capture run made 48 HyperFrames API posts with **zero Chrome
launches or capture-page preparations** in the corresponding server log.
This confirms reuse across frames. Capturing four sources and the mixed path
remain too slow for real-time playback on this setup. The live path is the
stronger result; production builds, full-screen output, longer runs and other
devices still require measurement.

Later reloads also exposed an initialization failure: one, then two of the
eligible live surfaces did not send a ready message within 30 seconds and
fell back to capture. A nominally all-live run then reached only 3.51 fps.
Diagnostics now report readiness timeout, frame-acknowledgement timeout and
runtime failure separately; they previously collapsed to a generic capture
fallback message. The time limits and fallback behavior are unchanged. The
underlying readiness failure was investigated in the next checkpoint below;
the original 28.89 fps result required all four surfaces to initialize. Evidence:
`.local/hf-four-packages-live-readiness-failure.json`.

Verification includes 18 targeted cache/audio/render-tree tests, product
TypeScript and changed-file ESLint. Tests exercise distinct captures at changing
times, fifth-source eviction, audio misses and hits with one through four live
sources, independent leases, source/account/project invalidation and disposal.
The transport fixture models capture browsers separately from retained live
deliveries and checks the four-browser bound, including audio's temporary probe.
The complete web regression run after these changes passes **981 tests in 215
suites, zero failures and zero skips**, with all browser tests and the local
Brag GSAP fixture enabled, in 104.9 seconds. Report:
`.local/hf-four-packages-regression-20261004/summary.json`.

Evidence: `.local/hf-four-packages-fixtures.json`,
`.local/hf-four-packages-source-audit.json`,
`.local/hf-four-packages-live-playback.json`,
`.local/hf-four-packages-capture-before.json`,
`.local/hf-four-packages-capture-after.json`,
`.local/hf-four-capture-warm-server.log`, and
`.local/hf-four-packages-mixed-playback.json`. Screenshots:
`.local/hf-four-packages-live.jpg` and `.local/hf-four-packages-mixed.jpg`.
Projects: `286360fa-97fd-480e-8a80-2643311705b6` (live/capture comparison) and
`3e993c3a-d148-48c5-bdd2-88921f104a2c` (mixed).

## Live image preparation and document cleanup (2026-10-04)

Loading-stage messages now distinguish shell, document, runtime, fonts and
images. Three observed timeouts in the actual editor stopped at `images`, after
the runtime and fonts were ready. An isolated four-package Chrome probe passed
with both `visibility:hidden` and opacity zero, so that smaller probe alone did
not reproduce the failure. In the editor, loading images observed through the
opaque frame had completed network loading and valid intrinsic dimensions.

Preparing live frames and their mount now use opacity zero while remaining
renderable. The compositor reveals the mount only after readiness, the initial
seek and the native layers are complete. Each occurrence still applies its
canonical clip opacity. This avoids holding the entire live path on image
decoding in a visibility-hidden frame. The 30-second readiness limit, capture
fallback, sandbox, package CSP and silent audio contract are unchanged.

A separate reload issue exposed stale server sessions. Known session handles
now start their keepalive close requests directly inside `pagehide`, instead of
waiting for Promise callbacks. Late open responses close their own handles;
failed heartbeats release forgotten handles. Back/forward-cache preservation
and the existing bounded server expiry remain in place. Development hot reload
also retained old server bridge code: the diagnostic run required restarting
the owned test server before the new loading stages appeared. Temporary server
session logging was removed after collecting evidence.

Verification on the same four-package project and preview dimensions:

- Three consecutive clean loads/reloads presented **four live surfaces**, with
  no preparation indicator or new fallback messages. These are short local
  development runs, not a long-duration or cross-device stability guarantee.
- Two six-second playback runs completed **155 / 169 frames**, at **25.84 /
  28.22 fps**, with median render times **6.4 / 4.1 ms** and zero render errors.
  All four surfaces remained live. The full suite had finished before playback.
- The pagehide regression first failed because no close request had started
  when the event returned; it passes with immediate dispatch. A new late-open
  test verifies exactly one scoped, keepalive close after disposal. Existing
  capture budgets, audio, account scope, independent leases and bitmap cleanup
  tests pass. Live tests verify preparation stays transparent, stage forwarding,
  seek pixels, audio muting and blocked navigation.
- **982 tests in 215 isolated suites pass, zero failures and zero skips**, in
  **117.5 seconds**, with Chrome, FFmpeg and the local Brag GSAP fixture enabled.
  Product TypeScript and changed-file ESLint pass. The previously recorded test
  fixture typing gaps remain outside this checkpoint.

Evidence: `.local/hf-readiness-reloads-20261004.json`,
`.local/hf-readiness-playback-20261004.json`,
`.local/hf-readiness-four-live-20261004.jpg`,
`.local/hf-live-images-loading.json`,
`.local/hf-readiness-session-evidence.log`,
`.local/hf-live-visibility-throttled-probe.json`, and
`.local/hf-readiness-full-regression-20261004/summary.json`.
The image-load observation was collected while trying the transparent
preparation path; it does not prove that every earlier timeout had completed
the same network requests. Mixed capture throughput and broader stability,
fidelity and UI work remain open.

## Complete Brag folder import and timeline navigation (2026-10-04)

The seven remaining references were selected with the actual browser folder
picker in an isolated Classic project. The first was imported into an empty
timeline; the following six used **After existing clips**. Together they form a
179.9667-second sequence. All seven reopened and rendered at a sample two seconds
into their own source; the separately verified `advanced-audio-test-final` brings
actual Brag UI import coverage to all eight references.

| Brag folder | Start (s) | Duration (s) | Source files | Copied resources | Runtime layers |
| --- | ---: | ---: | ---: | ---: | ---: |
| `brag-vertical/composition` | 0 | 20 | 9 | 27 | 18 |
| `brag-reference-recreation-v2/composition` | 20 | 15.5333 | 10 | 25 | 27 |
| `brag-reference-recreation/composition` | 35.5333 | 15.5333 | 8 | 42 | 17 |
| `brag-output/composition` | 51.0667 | 20 | 11 | 36 | 20 |
| `brag-reconstruction-2026-10-03/advanced-audio-test-v2` | 71.0667 | 6 | 9 | 2 | 4 |
| `brag-reconstruction-2026-10-03/composition` | 77.0667 | 96.9 | 16 | 131 | 82 |
| `brag-reconstruction-2026-10-03/advanced-audio-test` | 173.9667 | 6 | 9 | 2 | 4 |

The persisted 72 source files and all 265 resources match the reference bytes by
SHA-256, with no remaining upload tokens. Fonts, narration, images and binary
resources resolve from project storage after reload. The importer preserves
package members, including generated thumbnails and preview files. It does not
filter those outputs yet; they can clutter the Media panel. Generic folder names
also produce several clips called `composition`, which needs a naming control.
No reference file was edited. This check establishes import, persistence and
sampled preview coverage, not full export or audio playback parity for all eight.

The UI exercise exposed two navigation issues, now addressed:

- **Fit timeline to view** uses the existing zoom controller to display the full
  duration in 90% of the current track viewport. It starts at zero, keeps the
  playhead time, and persists through the existing timeline view-state setter.
  It includes displayed caption/AI timing when that extends beyond ordinary
  clips. It also resets a manually scrolled view when its zoom is already fitted.
  Zoom buttons now have explicit accessible names. This is a Classic viewport
  improvement; no document content model or second timeline was introduced.
- Scroll measurement previously retained a canceled animation-frame ID across
  React Strict Mode's effect cleanup/setup. Updates then stayed disabled, so the
  ruler and virtualized viewport could remain at zero width. Each observer
  setup now owns and cleans up its own scheduled frame. Browser verification
  showed labels through the full three-minute sequence and working scrolling.

Evidence: project `c2402764-34c5-44fc-a700-c57dfc1a3479` in the isolated integration
account, `.local/hf-brag-folder-audit.json`, `.local/hf-brag-reopen-1.png` through
`-7.png`, and `.local/hf-brag-timeline-fit-final.png`. The audit script rereads saved
project state and hashes imported source/resources against the original folders.
Controller tests cover fitted geometry, unchanged playhead, scroll reset,
viewport resizing, empty/short timelines and limits. The observer lifecycle test
covers cleanup/setup, coalesced scroll events, resize and listener removal.
Nine focused timeline tests passed (31 assertions), scoped TypeScript passed,
and changed-file ESLint reported no errors, with one pre-existing event-target
assertion warning in the zoom controller. Browser checks also confirmed that
the fitted view survives reload and the saved playhead near 176 seconds renders
the final generated composition once resource preparation finishes.

## Next implementation sequence

1. All eight Brag UI imports, durable resources and interrupted import continuation
   are verified. Verify downloaded exports across the remaining references.
   Improve imported clip naming and generated-resource visibility.
2. The synthetic folder flow now covers import, Undo/Redo and reopen. Source sharing, compact persistence, history adoption,
   media callbacks and canonical view projection are implemented and covered by
   real-WASM tests. The native MCP process still reaches the live editor through
   the existing Classic bridge; forwarding newly registered capabilities to that
   browser runtime needs a transport contract and tests.
3. The measured two-occurrence bottleneck is resolved for eligible live content.
   Four distinct packages and mixed live/captured occurrences are now measured;
   capture still limits throughput. Transparent live preparation passes three
   consecutive reloads; extend stability coverage beyond that local run.
   Extend video/canvas and dynamic resource
   support after fidelity tests. Broaden
   playback measurements to the remaining projects and large timelines.
   Keep transport and edits canonical and local
   control endpoints authenticated and loopback-only.
4. Extend the implemented expandable timeline rows with child selection and canonical edits;
   resolve anonymous/generated source identity before offering source edits.
5. The frame capture adapter is connected to the existing compositor. Resolve
   the 3D repeatability case, video injection,
   author timers, remaining audio windows and multi-composition cache behavior. Verify Brag references and
   mixed compositions against actual exports.
6. Implement measured UI/performance improvements; run the full preservation and
   completion audit above. Do not equate green source-import tests with completion.

## Validation commands

```powershell
cargo test -p opencut-editor-api --test hyperframes
cargo test -p opencut-editor-api --test hyperframes_package
cargo test -p opencut-editor-api --test classic_hyperframes
cargo test -p opencut-editor-api --test classic_history
cargo test -p opencut-editor-api --test classic_archive --test classic_atomic
cargo test -p opencut-editor-api
cargo run -p opencut-editor-api --example inspect_hyperframes -- <project-directory>
cd classic
wasm-pack test --node rust/editor-runtime-wasm
bun run build:wasm
```

The example is a read-only static source probe; it skips generated output, hidden
directories, dependencies and symlinks, and reports binary references as unbound.

### Current verification and outstanding baseline failures

- Runtime manifest: 20 Rust HyperFrames/import/manifest tests passed. Four cover
  validation limits, stale sources, repeated host identity, Classic/native state
  reads, revision checks, dry run, cancellation, idempotency and history. Nine
  real-WASM CommandManager tests passed (129 assertions); ten folder orchestrator
  tests passed (180 assertions). Six capture/host tests passed (64 assertions),
  including real Chrome generated DOM, repeated nested audio, authored mute,
  offsets/rate, package paths and capture regression coverage. Ten cache/client/
  graphic-frame tests passed (272 assertions), including page lifecycle cleanup,
  reuse for inspection and project/account/cancellation boundaries. Scoped TypeScript, changed-file ESLint
  and Editor API Clippy passed. Full web baseline failures below remain open.

- Preview caching: 26 tests passed with 538 assertions across rendering/cache,
  real-WASM CommandManager and folder-import orchestration. Scoped TypeScript and
  changed-file ESLint passed. Actual editor transforms/Undo and authenticated
  capture measurements are recorded above. The complete playback and export
  performance audit remains outstanding.

- Folder UI/orchestration: 16 Rust source/Classic import tests passed, including
  atomic resource binding and invalid-import rollback. Seven real-WASM command
  tests passed with 85 assertions; ten import orchestration tests passed with
  167 assertions; six storage/request tests passed with 42 assertions. The render
  client readiness/cache test passed with 54 assertions. Scoped TypeScript,
  including the changed local-drive routes, passed. Changed-file ESLint has no
  errors; existing assertion warnings remain in storage/server/route files.
  Browser folder selection, generated duration, placement, Undo/Redo, reopen,
  byte preservation and failed-import cleanup are described above. The saved
  mixed preview is `.local/hyperframes-folder-import-preview.webp`.

- Compositor/host additions: eight capture/host tests passed with 80 assertions,
  including three real Chrome tests; client lifecycle/account tests passed with
  50 assertions and frame/GPU invalidation tests with 12 assertions. Twelve Rust
  Classic import/history/archive/atomic tests passed, including intrinsic size
  validation and older clips. The browser and decoded MP4 evidence is above.
  Scoped TypeScript passed. ESLint passed for the new adapter and changed render
  paths, with two existing assertion warnings in the AI catalog file. Six
  real-WASM CommandManager tests (73 assertions) and the two folder tests also
  passed after the integration.

- Capture additions: nine folder/preview/capture tests passed with 72 assertions,
  including two real Chrome tests; six browser-binding WASM tests, scoped web
  TypeScript and capture ESLint passed. WASM binding Clippy passed with
  `-D warnings`. The export-table check now covers 13 canonical and 37 existing
  Classic exports. The actual Brag probe captured all eight compositions, with
  the 3D repeatability limitation recorded above.

- Folder/runtime additions: four native package-planning tests, five real-WASM
  folder/preview tests (38 assertions) and four local-drive tests (20 assertions)
  passed. The browser check above also covered nested HTML and dynamic JSON.

- Editor API: 20 existing tests, 8 HyperFrames source tests, 5 Classic import
  tests, 3 Classic history tests, 2 compact archive tests and 1 atomic transaction
  test passed.
- MCP: all 13 tests passed, including registry projection, atomic rollback and
  Classic attachment through the generated tools.
- Editor API and MCP Clippy with `-D warnings` passed after the session adoption
  and history target changes.
- Canonical browser binding: all six WASM integration tests passed, including
  synchronous Classic edits, adoption of existing history and retry behavior
  after restoration and grouped host transactions.
- Both release WASM packages built successfully; 37 existing Classic exports
  and 11 canonical runtime exports passed the binary contract check. Clippy with
  `-D warnings` passed for the native Editor API and the WASM binding, including
  tests. The loader passed ESLint.
- The lazy runtime binary after compact archives and transaction APIs is about 6.7 MB;
  the original Classic WASM remains 3,919,268 bytes. Earlier load timings above
  predate the Classic bridge.
- Six real-WASM CommandManager/ScenesManager tests (73 assertions), three session adapter
  tests (16 assertions), the two legacy CommandManager tests and the separate
  storage round-trip test passed. The existing preview-overlay test also passed.
  They check complete project/scene preservation, including source text and
  undo/redo. ESLint and a scoped TypeScript check passed for the changed Classic
  code and its integration tests. The full web TypeScript
  check reports errors in other test files (fetch mocks, branded time values and
  test fixtures); it reported none in the files changed for this bridge. A full
  web type-check pass remains outstanding.
- Classic: 36 tests passed for timeline components, playhead geometry and audio
  silence defaults. Two stale audio assertions were corrected to the intentional
  0.3-second default from commit `b2b7d03e`; product behavior was preserved.
- The broader Classic timeline invocation reports 62 passes, 4 failures and
  2 module errors. `cut-silence.test.ts` also fails in isolation: its
  `mock.module("opencut-wasm")` omits `resolveAudioSyncRetrim`, now imported by
  the audio timing code. The real WASM was rebuilt and all 37 required exports,
  including this one, passed `verify-wasm-exports.mjs`. This is an outstanding
  test-harness issue, not evidence of successful full regression coverage.
- All eight Brag folder imports are now verified through the UI, persistence and
  sampled previews. Full playback/performance and broader Brag export parity
  remain outstanding. The audio connection section records the completed mixed
  Brag/native MP4 check; multiple-live export equality is recorded above.
