# Multicam reference benchmark and migration contract

Status: **in progress; AutoCut parity has not been achieved**. Passing functional tests is not a substitute for passing the reference benchmark. No production claim of 99% equivalence is justified.

## Ownership

This capability is **bridged**. The audio alignment, speech activity processing and camera routing kernel lives in `classic/rust/crates/podcast`, compiled for native callers and WASM. Browser code decodes media and coordinates transient analysis. Durable scenes, alignment metadata, source bindings, cuts, validation, frame quantization and history live in `OpenCutRuntime` through `timeline.classic.multicam.create`. The read-only `timeline.classic.multicam.analyze` registry capability uses the same Rust kernel on supplied, aligned RMS arrays. MCP projects these contracts automatically. Both target a project and revision; creation supports transaction history, dry run, idempotency and cancellation. Media binding revisions prevent committing a plan after a source was relinked.

The rewrite has no separate multicam implementation. The Classic UI is the current integration. `legacy-dsp.ts` is a frozen benchmark helper for measuring the previous implementation, with no product imports. Native decoding and equivalent rewrite UI are not migrated. Browser group synchronization runs in cancellable Workers; termination interrupts decoding and WASM computation. Native registry analysis checks cancellation before/after computation.

## Current behavior

The host decodes each unique source once to 10 ms RMS envelopes in a bounded pool of 2–4 Workers, independently of camera/microphone pairs. One shared Rust group solver chooses a non-silent reference and connects overlapping recordings on a common clock, using the strongest available correlation edges (a maximum-confidence spanning tree), including bridge recordings for sources that cannot hear the reference. Unconnected/low-confidence sources fail the whole operation before document mutation. Microphone envelopes are reused for camera routing. Up to 32 camera/microphone channels (64 unique sources) are supported; the group kernel bounds aggregate input to 32 million envelope samples. This is one group job, not unlimited simultaneous disk reads. The read-only `timeline.classic.multicam.align` capability exposes the same kernel through the canonical registry.

Rust applies activity gating, microphone gain normalization, optional bleed suppression, temporal confirmation and minimum shot duration. The camera clock is independent of the speaker clock: a sustained monologue can cut to another participant after the maximum shot duration and return after the configured reaction duration. Camera audio is muted by default, microphone audio stays continuous, and every camera retains all its cut segments on one track. Active segments have `enabled: true`; inactive segments have `enabled: false`. There are no separate leftover tracks. Clip enable/disable is a bridged canonical control (`timeline.classic.elements.controls`, `setEnabled`/`toggleEnabled`) with default-enabled legacy documents, validation, dry run, retry keys and undo/redo. Disabling bypasses image, effects and sound without overwriting visibility, mute, gain or source-audio settings. The web context menu exposes Enable/Disable for individual or selected clips; disabled segments are dimmed. Video boundaries are snapped once to the project frame rate; audio offsets retain subframe precision.

The default reaction length of 5 seconds is an implementation choice, **not an inferred AutoCut setting**. The engine is deterministic. Whether the reference AutoCut configuration is deterministic is unknown. Speaker activity and listener shots are different decisions; improving speaker detection alone does not establish edit parity.

## Reproduce with original media

Run from the repository root. Keep exported XML and all derived media/fixtures under ignored `.local/`; never commit private recordings. Requires `ffmpeg`, Python with NumPy, and Rust. Export the active sequence from Premiere using Final Cut Pro XML. Choose original camera tracks and external mic tracks in matching camera order (track numbers are zero-based).

```sh
python3 classic/scripts/multicam/extract-reference.py .local/multicam-reference/resist2-reference.xml --sequence 'resist 2 lior' --video-tracks 0 1 --audio-tracks 1 0 --output .local/multicam-reference/reproduced
cargo run --quiet --manifest-path classic/Cargo.toml -p podcast --example analyze < .local/multicam-reference/reproduced/analyze-input.json > .local/multicam-reference/reproduced/candidate-cuts.json
python3 classic/scripts/multicam/compare.py .local/multicam-reference/reproduced/reference-cuts.json .local/multicam-reference/reproduced/candidate-cuts.json --fps 25 --target .99 --require-target --output .local/multicam-reference/reproduced/metrics.json
```

The last command must currently exit **1**: the accuracy gate fails. It requires all of camera-frame agreement, boundary precision and boundary recall to reach the target. Boundaries must select the same destination camera at the same frame. `--target .999` tests 99.9%; `--tolerance-frames 1` explicitly relaxes timing, but is not the default. `identical` separately reports exact full agreement. Repeated same-camera splits never count as transitions. The two inputs must use the same camera IDs.

The extraction writes the XML hash, media path/size/mtime fingerprints, timing map, raw full-length envelopes and aligned analysis input. It rejects nested source tracks, non-unit time mappings and transition intervals. The fixture measures underlying camera layers; graphics/overlays are excluded. It decodes original source audio without applying Premiere clip/track effects, so it is not a rendered-audio equivalence test.

## Measurement on 2026-10-11

Reference: 25 fps, 66,462 underlying camera frames (2,658.48 seconds), 263 shots / 262 transitions, two original MP4s and two original external WAVs. The compared range starts at sequence frame 149 and ends at 66,611. Shots range from 1.32 to 20 seconds; nine are exactly 20 seconds. A short graphic intro overlaps the beginning of the evaluated camera range.

| Method | Camera agreement | Actual transitions | Exact matched boundaries | Matched within one frame |
| --- | ---: | ---: | ---: | ---: |
| Previous kernel + legacy DSP, 48 kHz source decode | 80.72% | 125 | 1 / 262 | 2 / 262 |
| Current kernel, 1–20 seconds, 5 second reactions | 76.46% | 289 | 1 / 262 | 3 / 262 |
| Current kernel, reactions disabled (diagnostic only) | 81.25% | 215 | 1 / 262 | 4 / 262 |

Thus the current reaction policy worsens camera agreement on this reference. It implements the requested broad behavior but does **not** reproduce AutoCut. The reaction-disabled result does not satisfy the requested maximum-shot behavior and must not be presented as the delivered accuracy.

With the current policy the first 70% of the sequence scores 76.13%, the final 30% 77.23%. These are descriptive splits, **not an independent holdout**: tuning examined this recording. A 27-combination integration/confirmation/pre-roll sweep did not approach the target. The reference contains many shots of the quieter microphone's participant before the previous shot reaches 20 seconds; fixed maximum-duration reactions do not explain all reference decisions.

Alignment is closer: native full-source RMS estimates differ from the Premiere offsets by 10 ms camera-to-camera and 20–30 ms camera-to-microphone. Direct mic-to-mic correlation is weak on this recording, so cameras supply the synchronization reference. These figures describe this fixture, not a general accuracy guarantee.

## Evidence still needed for parity

The saved Premiere project contains an AutoCut backup of the uncut tracks. That backup already contains Essential Sound restoration metadata and audio effect chains; the live XML exports only gain/level effects. It is unknown whether the original AutoCut run analyzed those rendered effects or original source audio. The exact AutoCut preset/version and whether the finished sequence contains manual changes have not been established.

The user subsequently ruled out running AutoCut. The workflow now uses only the existing edits and source media; reconnecting or restarting Premiere is no longer a prerequisite or a pending action. The saved research copy remains available and Premiere was left open.

## Offline inference experiments

`learn-reference.py` learns camera decisions from aligned audio and uses a duration-constrained global planner. Features contain microphone levels and ratios in past, centered and future windows (40 ms to 16 seconds). They contain no absolute timestamp, cut-table lookup, filenames, or reference camera history. Offline look-ahead is permitted because the complete recording is available before editing.

Validation uses five contiguous blocks with a 20 second exclusion zone around the held-out block during training. Each block is decoded independently so a model trained on another block's labels cannot influence the current block through the planner. Scores sum camera frames and within-block cut matches; artificial joins between validation blocks are excluded from boundary counts. Concatenated diagnostic timelines are mosaics of five models, not a deployable single-model edit. This recording has already informed manual experiments, so this is not an untouched-project evaluation.

The best shallow model reached **82.20% camera agreement**, with **4 / 262 exact cut matches** and **10 / 262 within one frame**. A more flexible model reached 98.73% mean training-frame agreement but only 80.61% in held-out blocks after planning. That training fit is not evidence of 99% replication.

Additional experiments tested a causal shot-history model, audio frequency-band energy/flatness, and 81 combinations of a simpler global audio planner. Shot history peaked at 76.01% camera agreement; spectral features peaked at 81.34%. The simple planner selected on the first 70% reached 81.47% overall and 79.24% in the final 30%. None passed the cut-identity gate. These experimental candidates have not replaced the product kernel.

`audit-reference.py` produces a CSV for every shot. Acoustic categories are proxies rather than verified speaker annotations:

| Reference shot category | Shots | Total seconds | Learned camera agreement |
| --- | ---: | ---: | ---: |
| On-camera microphone mean RMS > 3× the other | 138 | 1,777.40 | 94.06% |
| Other microphone mean RMS > 3× the on-camera mic | 63 | 280.92 | 10.59% |
| Mixed | 62 | 600.16 | 80.60% |

The second group has a median duration of 4.36 seconds and accounts for about 53% of mismatched camera time. It includes likely listener shots, but energy ratios alone do not prove editorial intent. A cleaner subset of 57 short shots had durations between roughly 2 and 6.3 seconds; nearby speech-energy minima did not consistently mark their entry or exit. This does **not** prove random selection: unknown signal processing, internal state, settings or manual edits remain possible explanations.

The optional research environment uses NumPy, SciPy, scikit-learn, and joblib. A frozen shallow model can be exported after training; inference then reads only the audio input and that locally generated bundle, without opening any reference-cut file. Its validation still fails the 99% gate. Models and private fixtures belong under ignored `.local/`.

```sh
python3 classic/scripts/multicam/learn-reference.py .local/multicam-reference/reproduced/analyze-input.json .local/multicam-reference/reproduced/reference-cuts.json --fps 25 --export-model --output .local/multicam-reference/learned-final
python3 classic/scripts/multicam/learn-reference.py .local/multicam-reference/reproduced/analyze-input.json --fps 25 --predict-with .local/multicam-reference/learned-final/experimental-model.joblib --output .local/multicam-reference/frozen-inference
python3 classic/scripts/multicam/audit-reference.py .local/multicam-reference/reproduced/analyze-input.json .local/multicam-reference/reproduced/reference-cuts.json --candidate .local/multicam-reference/learned-final/cuts-7-20.json --fps 25 --output .local/multicam-reference/audit
```

The `training-replay-metrics.json` file is explicitly labeled training replay. It must not replace the held-out-block results when reporting algorithm quality. A copied reference edit or lookup table of cut times cannot count as an audio-derived algorithm. Exact reproduction remains unresolved, including most reaction placements and many speaker-change boundaries.

## Verification

- `cargo test --manifest-path classic/Cargo.toml -p podcast`: 10 tests passed.
- `cargo test -p opencut-editor-api --test classic_multicam --test classic_scenes`: 10 tests passed, including registry readback, mute/mic behavior, dry run, idempotency, undo/redo, revision/binding conflicts, invalid plans, cancellation and frame snapping.
- `node classic/scripts/test-web.mjs src/core/__tests__/canonical-multicam.test.ts`: 1 real-WASM browser-runtime test passed.
- `python3 -m unittest discover -s classic/scripts/multicam -p 'test_*.py'`: 6 comparison tests passed; 3 additional learning/planner tests passed in the optional research environment. The planner is checked against exhaustive enumeration of legal camera plans.
- WASM build/export checks, application TypeScript build check and changed UI lint passed.
- Reference acceptance test: **FAILED**.
