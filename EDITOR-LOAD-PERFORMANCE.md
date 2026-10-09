# Editor loading and playback audit — 2026-10-09

## Official upstream comparison

The product lives under `classic/` in `itayzrihan/OpenCut`. Both official lines
were fetched and compared against our starting commit `de8233ba`:

| Official source | Latest fetched commit | Missing from this fork | Decision |
| --- | --- | --- | --- |
| `OpenCut-app/opencut-classic` | `cf5e79e9` | 0 commits (240 local commits ahead) | All official Classic changes are already ancestors of this fork. |
| `OpenCut-app/OpenCut` rewrite | `e6680107` | 2 commits (210 local commits ahead) | Evaluate separately; neither addresses the current web editor's loading or preview. |

The rewrite additions are `400f097b` (foundational GPUI desktop primitives) and
`e6680107` (FFmpeg binary CI builds). A non-mutating `git merge-tree` trial found
a conflict in `apps/desktop/src/main.rs`. No blanket merge was applied: adopting
the desktop shell requires reconciling our custom runtime, and FFmpeg packaging
needs a separate distribution integration. These are not web playback fixes.

Sources: [official OpenCut](https://github.com/OpenCut-app/OpenCut),
[official Classic](https://github.com/OpenCut-app/opencut-classic),
[desktop commit](https://github.com/OpenCut-app/OpenCut/commit/400f097b),
[FFmpeg build commit](https://github.com/OpenCut-app/OpenCut/commit/e6680107).

## Implemented changes

- **Lossless chained history encoding (schema 3).** Each history entry records
  its difference from the preceding boundary in that stack. Schema 2 repeatedly
  stored large differences against the current scene after major edits. All
  undo/redo boundaries remain present; schemas 1 and 2 remain readable. The
  canonical archive capability owns encoding and restoration. Existing projects
  upgrade through the normal fenced save queue after opening.
- **Metadata-only ownership checks.** Initial inspection avoids transferring the
  archive before acquisition transfers it. Rust ownership transitions preserve
  the immutable saved payload as raw JSON instead of allocating/cloning its
  complete history. Scope, lease, generation, quota, and monotonic clock checks
  remain on the existing path; commits still perform full validation.
- **Reuse validated Smart Takes evidence.** A bounded cache stores successful
  validation hashes of the complete take assembly and media membership. Changed
  evidence or missing media must validate again. No project state is stored in
  this cache. Restore also avoids validating the same Classic payload twice.
- **Lazy library playback audio.** Playback resolves range-readable URLs rather
  than downloading every entire music/SFX file before Play. Export retains its
  full-file path.
- **One audio demuxer per source.** Short Smart Takes clips and streaming audio
  share initialization, with independent range iterators. Project/source cleanup
  disposes pending and completed inputs; failed initialization can retry.

Migration status: canonical archive and validation changes are **bridged** through
`OpenCutRuntime` and the existing WASM adapter. Browser media decoding and host
storage I/O are **Classic-only platform adapters**. There is no second editor
state store, copied rewrite feature, or removed Classic feature.

## Measurements and preservation checks

The existing Smart Takes / Full Auto project has 39 main clips, 77 undo entries,
and 1 redo entry. The opt-in Rust benchmark independently restored both archive
formats and compared their entire expanded history for exact equality.

| Measurement | Before | After |
| --- | ---: | ---: |
| UTF-8 canonical archive | 103,338,435 bytes | 12,114,223 bytes (88.3% smaller) |
| Existing project file, including session payload | 120,333,525 bytes | 18,058,660 bytes (85.0% smaller) |
| Undo / redo entries | 77 / 1 | 77 / 1 |

The actual project was upgraded under its normal project-directory lock, after
backing up the original and checking that its archive had not changed since the
verified conversion. Only the archive encoding changed. Project content,
checkpoint, artifacts, thumbnail, and history boundaries were retained. Local
backups and performance traces are private, ignored files under
`.local/performance-audit/`.

On the old approximately 100 MB session record, the optimized WASM ownership
path measured 1,100 ms for read and 700 ms for renewal in an isolated Node run.
After compaction, a live renewal request measured 246 ms. Earlier development
server logs contained ownership requests lasting tens of seconds and timing out;
these runs are not a controlled before/after benchmark.

Chrome verification on the real project:

- A fresh reload showed the editor within 11.2 seconds, including development
  runtime loading and complete history restoration. This is an observed upper
  bound, not an instrumented first-paint timestamp.
- Play after that reload completed preparation and advanced through Smart Takes
  with the portrait preview, captions, zoom and audio tracks present. Cold Play
  still required several seconds; it is not instantaneous.
- Pause/resume reached the playing state in 368 ms in the measured warm run.
- A steady 60-frame sample measured preview render time at 8.95 ms mean / 23.7 ms
  p95. Frame intervals and cold source decoding still have occasional stalls;
  this is not a claim of universally smooth playback or a before/after FPS test.
- No application console errors appeared during the fresh playback check.
- After playback/reload, saved project content still matched the pre-upgrade
  project, with schema 3 and all 77/1 history entries retained.

## Validation

- 42 Rust tests passed across archive, Smart Takes, remove/ripple, and session
  storage suites; the opt-in real-project archive equality benchmark also passed.
- 122 web tests passed across canonical commands, session lifecycle/host storage,
  Full Auto Smart Takes/resume, audio loading/cache/synchronization, playback,
  camera angles, and exact-frame behavior.
- TypeScript, changed-file ESLint, architecture checks, runtime WASM build/export
  verification, and whitespace checks passed.

The tests cover corruption rejection without partial restore, both undo/redo
orders, old archive compatibility, same-revision encoding upgrades, stale fences,
account/project isolation, changed Smart Takes evidence, missing media, shared
audio initialization, disposal during pending initialization, and export loading.
They reduce regression risk; they do not prove every feature in every project.
