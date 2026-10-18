# Disk-backed Classic video export

Status: **Classic-only host IO adapter**, 2026-10-11. This changes export buffering,
not the canonical document, capabilities, undo state, clip timing, or edit decisions.
`OpenCutRuntime` remains the source of editor state. The existing canonical audio
gain/timing functions, Rust denoiser/hard limiter, and compositor remain in use.
Agent exports continue through the existing registry adapter and bounded ArtifactStore.
No duplicate transport capability or persistent editor state was added.

## Related project and playback performance (2026-10-13)

Classic sequence opening now uses `project.classic.scene.open` and
`project.classic.scene.view`. The current viewer is canonical serializable
`workspace.classicScene`, with its own optimistic navigation revision. Opening
does not edit the project, create Undo, copy captions or serialize archives.
The existing `scenes.edit` select contract remains an undoable content action;
persisted `document.currentSceneId` remains its editing fallback. Rendering and
duration resolve the workspace viewer, and host content synchronization records
the actual editing scene. Scene notifications distinguish viewer changes from
content changes so autosave does not treat opening a sequence as an edit.
Timeline zoom/scroll/playhead presentation also uses the lightweight canonical
`project.classic.viewport.set` capability under `workspace.classicViewport`.
Auto-fit and seek controls cannot schedule a full archive save after navigation;
stable derived viewport objects keep React external-store snapshots coherent.
Hosts checkpoint viewer IDs as tiny account-scoped preferences, restoring them
through the validated capability. When an archive needs viewer hints, versions
4 (full/chained) and 5 (unchained deltas) preserve current and historical viewer
focus; versions 1–3 stay readable. Same-revision save checks ignore only the root
viewer hint, with all content, history and navigation targets still validated.

The shared Rust Classic document decoder reads unknown JSON fields directly,
avoiding serde's temporary flattened tree. Session restoration interns each
history boundary during its single import pass; every boundary is still
validated and Undo/Redo remain lossless. Save fingerprints stream into SHA-256
with exactly the previous canonical JSON ordering, so pending save replay keys
remain compatible. The save response serializes borrowed project data.
Large WASM snapshots cross into JavaScript as one JSON transfer, like bulk
capability responses, instead of constructing every word/caption property through
separate calls. The projection stays identical to `app.state.read`.

Classic host ownership inspection and asset fences use the existing small
renewal journal, anchored to the exact project file identity. They do not rewrite
the full immutable archive. Acquire, release and commit still replace the atomic
project record and invalidate old journals; the same Rust scope/lease/revision
policy authorizes every operation. Large validation uses the packaged native
session-policy process, keeping the HTTP event loop available for media reads.

Playback retains at most 64 MiB of decoded PCM and 64 MiB of prepared PCM, with
16 entries per cache. Oversized buffers bypass retention; these budgets do not
cap active decoder or Web Audio node memory. Compressed URL caching defaults to
8 MiB per audio source. Normal-speed clips with pitch preservation enabled stream
instead of decoding the complete episode. Private account/binding-scoped media
ranges can be reused for 60 seconds with `Vary: Cookie`; writes, errors, ordinary
JSON and unauthenticated requests remain uncached.

Regression command: `node .dip/tools/verify-smart-shorts-performance.mjs` from
the repository root. This covers canonical restoration, unknown fields, retry
fingerprint compatibility, ownership journals/fencing, authenticated cache
headers, PCM eviction, playback timing and actual browser audio/video export.

## Failure addressed

The previous MP4 path used Mediabunny `BufferTarget` with in-memory fast start. It
retained encoded media until finalization and prepared a complete decoded timeline
AudioBuffer beforehand. Long exports could accumulate gigabytes, swap heavily,
and throw `Array buffer allocation failed` in an asynchronous encoder callback
while the progress UI appeared to continue.

## Pipeline and budgets

- Chrome's Save dialog chooses the destination before rendering. Encoded output
  flows into a file writer through a backpressured StreamTarget with 1 MiB chunks.
  A completed result is a File, never a full-file arrayBuffer/Blob copy.
- MP4 uses fragmented fast start and a two-second keyframe/fragment cadence.
  WebM uses the same disk target. Container indexes, codec internals and source
  demuxer indexes still have their own overhead; this is not a universal process
  RAM ceiling.
- At most two source decoders run. Only merged selected source intervals are
  decoded to temporary PCM, with AAC priming and resampler handles. Removed gaps
  and the recording before a late trim are skipped; each PCM file uses a local
  origin so absolute episode timestamps do not create giant temporary files.
  URL cache budgets are 8 MiB per source. No Promise.all over every source.
- At most two clip processing jobs run, using two-second output windows plus
  bounded DSP/filter context. Temporary PCM writers buffer at most 512 KiB each
  and await writes; sealed writers release this buffer.
- SoundTouch pitch preservation retains one DSP instance per clip and a fixed
  input cache. Its existing startup latency is applied once per clip. Denoised
  and limited clips reuse the existing shared window/DSP path.
- The mix is spooled to disk, preserving the existing global peak decision for
  mastering. Mastering uses two seconds of preceding context plus a short tail.
  Resampling windows align both sample-rate clocks. Nonlinear noise processing
  and independent Web Audio resampling/mastering are not bit-identical to a
  single full-timeline render; tests bound the difference and boundary error.
- Audio and video encoding are interleaved. One next video snapshot may overlap
  the current encoder write; one next audio window may be prepared. A slow
  encoder/disk applies backpressure instead of growing a frame/packet queue.
- The short-fixture memory fallback is limited to 120 seconds and 64 MiB. Agent
  output is stopped at the existing 64 MiB artifact limit before reading bytes.

## Failure, cancellation, cleanup

The destination file is committed only after muxer finalization. Mediabunny's
stream-close during cancellation does not commit it. Errors/cancellation abort
its writer and remove that export's scratch files. An existing destination is
preserved when its writable transaction is aborted. A newly selected empty file
may still exist after cancellation.

Export scratch lives under OPFS `opencut-exports`. Active directories have Web
Locks leases so cleanup cannot delete another tab's running export. Successful
fallback downloads retain their disk file, avoiding deletion while the browser
is reading it. Direct-destination exports remove all scratch immediately.
Abandoned/fallback directories older than a day are reclaimed on the next export
only if no live export owns their lease. This is not crash resume/checkpointing.

The audio preflight checks estimated temporary storage; actual write/quota
errors also fail the export. Temporary disk usage scales with source/processed
PCM and the mix. Ten hours of stereo float PCM at 44.1 kHz is 12.7 GB per copy;
multiple sources need additional disk space. A bounded-RAM export is not a
low-disk-space export.

Progress reports audio reading, processing, mixing, video rendering and file
completion, throttled to avoid per-frame UI work. Closing the export popover
cannot cancel a running export; cancellation is explicit. An allocation error
or two minutes without video-stage progress fails visibly instead of leaving a
permanently moving-looking percentage. Very slow/unresponsive media may hit this
stall guard and require retrying after resolving the source or disk issue.

## Validation

Run from the repository root:

```
OPENCUT_STREAM_EXPORT_TEST=1 node classic/scripts/test-web.mjs \
  src/export/__tests__/streaming-browser.test.ts \
  src/export/__tests__/disk-target.test.ts \
  src/export/__tests__/pcm-file.test.ts \
  src/export/__tests__/audio-quality.test.ts \
  src/editor-agent/__tests__/render-effects.test.ts \
  src/ai/__tests__/timeline-tools.test.ts \
  --jobs=1 --timeout=300000 --test-timeout=240000
```

The isolated browser fixture exercises the actual compositor/encoder, OPFS and
muxer, decodes video and audio past a chunk boundary, verifies cancellation
preserves the destination, compares 44.1/48 kHz audio with overlaps and denoising/
limiting against the legacy path, and compares continuous pitch output at
0.75x/1.5x/5x. It also writes/reads the tail of a 12.7 GB sparse PCM file and muxes
36,000 real repeated encoded frames across ten hours of timestamps. The latter
is a container/IO test, **not** a ten-hour real-footage render or speed benchmark.

The already-running Production export cannot switch implementations in place.
No application reload or Production restart is part of this implementation.

Validation on 2026-10-11: 44 targeted tests across six suites passed;
changed production files passed ESLint (the repository emits its existing Pages
path advisory). The browser fixture additionally checks the frame immediately
before and after a cut using a native canvas producer to isolate encoder snapshot
ordering from GPU-compositor behavior.

Broader checks are not all green: full TypeScript checking reports existing
errors in generated `.next/dev` test-page declarations and the unchanged
`typekit-loading`, `noise-reduction`, and `video-lookahead` test files. The existing
HyperFrames mixed-export browser suite fails its native blue-background pixel
assertion, **also when supplied with the unmodified HEAD SceneExporter**. Its
headless GPU path logs shader/texture validation problems. Those unrelated
compositor/integration failures were not masked or represented as passes.

Container strategy reference: [Mediabunny output targets](https://mediabunny.dev/guide/writing-media-files#output-targets)
and [output formats](https://mediabunny.dev/guide/output-formats).
