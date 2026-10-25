# Advanced Podcast — Classic capability contract

Implementation scope: Classic only. Shared microphone grouping, high-bleed routing and camera-name suggestions live in `classic/rust/crates/podcast`; canonical transactions and capability descriptors live in `crates/editor-api`. The rewrite does not have a duplicate editor implementation.

Hollyland LARK MAX 2 recordings are grouped by recorder token and recording date. Appended human labels are retained. Sequence numbers, exact media durations, missing/duplicate segments and mixed sessions are validated before a scene can be created. Four physical microphone streams are supported, each retaining source asset and sequence provenance. Segment boundaries accumulate exact durations; the observed full segments are 1800.15 seconds.

All logical microphones and physical cameras are aligned on a shared clock, with bounded waveform refinement. Each microphone can start at a different time. Camera-only pre-roll is excluded from the microphone program interval. Camera coverage remains explicit so short sources cannot produce frozen end frames.

Advanced routing uses recorder-relative level normalization and owner dominance/hysteresis because nearby speakers bleed into all lavaliers. Camera mapping is independent of microphone count. Related camera filenames suggest a physical angle group; generic camera counters and misspelled angle suffixes do not determine identity. A preferred Main camera provides the default, with brief alternate angles during longer turns. Users can override suggested groups and mappings directly in the Podcast dialog.

The UI imports absolute paths through the existing authenticated host media registration with `preserveLink=true`; the canonical media import and scene transaction persist the result. It does not create merged virtual camera assets or copy card recordings. Standard Podcast audio finishing and Sharpen remain the shared finishing operation.

Verification on 2026-10-25: configured `advanced-podcast` check passes 34 shared Rust tests, 4 Advanced API tests, 14 regular multicam API tests and 25 browser/runtime/linked-import tests, plus production type checking and changed Podcast lint (one existing dependency warning). Production build and deployment fingerprint are recorded in `.local/advanced-podcast/activation.json`.

Lighting analysis is separate from the reusable routing feature. All three actual sources show the same illumination event. First affected source frames: Avihay 1058.32s/frame26458, trio Main 1123.32s/frame28083, trio alternate 1136.08s/frame28402. Native frame rate is 25fps, limiting temporal precision to 40ms. `color-plan.json` contains editable native color-correction control points, including the subsequent automatic exposure/white-balance response. Missing light direction cannot be reconstructed by global correction.

Actual episode execution and saved scene verification are tracked separately from passing feature tests; consult the delivery receipt when available.
