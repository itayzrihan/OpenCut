# Audio noise reduction and Sharpen

Status: Classic rendering features, bridged to OpenCutRuntime. No rewrite-only UI or duplicate project store.

- Audio/video `params.noiseReduction`: optional 0..100 dry/wet percentage, absent/zero bypasses. Canonical validator also applies to generic patches and session load. Typed `timeline.classic.audio.noise-reduction` capability and existing inspector update transaction share the same mutation/Undo machinery.
- RNNoise (`nnnoiseless` 0.5.2, BSD-3-Clause) speech suppression lives in Classic Rust podcast crate. Host decodes/resamples bounded two-second windows with 250ms preceding context. Processing happens in a reusable worker; preview and export call the same window renderer. One-frame delay is compensated and tail is flushed. 0% keeps existing audio path. Offline local processing, no uploads.
- Sharpen is a native GPU unsharp-mask effect, default intensity15 (0..100). Standard effect serialization/parameters/animation and renderer are reused. Plus sends effect-only `fullScene=true` to canonical insertion; runtime resolves zero start and scene end atomically. Stored state contains only ordinary effect timing.
- Coverage is scene duration at insertion, as with Editorial Edge Feather; subsequent timeline extensions do not automatically extend existing effect layers.

## Podcast finishing / Gain / Hard Limiter

Status: **bridged Classic-only rendering**, canonical policy/state/capabilities in
`crates/editor-api`; no duplicate rewrite state. The browser invokes canonical
`timeline.classic.multicam.create` with `finishPodcast=true`. Older direct clients
retain the existing creation behavior unless they opt in. Existing edits use
`timeline.classic.podcast.finish` with explicit camera and microphone track IDs;
the Podcast Multicam dialog exposes the same action as “Finish current timeline”.

Preset: microphone Volume +15 dB, **Adjust Gain by −1 dB once**, RNNoise 25%,
linked-channel Hard Limiter enabled at −1 dB sample peak, lookahead 7 ms, release
100 ms. Camera source audio is muted; enabled/disabled routing and all clip/source
times are preserved. A full-scene Sharpen 15% effect is inserted if absent. Only
explicit microphone tracks receive audio changes; intro music stays untouched.
`podcastFinishingVersion=1` survives splits/persistence and avoids stacking the
gain adjustment or resetting subsequent manual changes on reapplication.

Gain is an independent −60..30 dB parameter (zero bypass). The inspector and
`timeline.classic.audio.dynamics` expose gain, limiter bypass, ceiling −60..0 dB,
lookahead 1..20 ms, release 10..250 ms. Generic canonical updates share validation.
Rust `hardLimitAudio` works on bounded interleaved PCM and links all channels,
anticipates transients with a backwards gain ramp and recovers 12 dB over the
release interval. It preserves sample positions and the tail. This is our DSP,
not a claim of sample-identical Adobe processing or true-peak limiting.

Preview and export share the worker/window path: denoise, gain plus volume/fades,
then limiter. Limiting windows decode 1.5 seconds of preceding context and a
lookahead suffix, then crop to the requested interval. Automation is sampled by
the existing host gain envelope and interpolated in the worker; steady podcast
gain has no per-sample work on the UI thread. Processed windows use bounded caching.
Gain is not applied a second time at playback/mixing. The limiter ceiling is per
clip, like an inserted Premiere effect; the existing final mix mastering stage
remains separate. Simultaneous clips can sum above an individual clip's ceiling.

Adobe reference inspected 2026-10-11:
https://helpx.adobe.com/au/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html
(Maximum Amplitude, Input Boost, Look-Ahead Time, Release Time and Link Channels.)
Premiere's actual Audio Gain dialog in the user's project selected Adjust Gain by,
so entering −1 there is a fixed adjustment, not Normalize Max Peak to −1.

Verification: Rust ceiling/link/tail/context DSP tests; canonical creation and
existing-edit finishing readback, invalid-input atomicity, dry run, retries,
repeat-application preservation, Undo/Redo; browser fixture uses actual Web Audio
and production worker/WASM for gain, ceiling, stereo and ranged/full PCM agreement.
