# Delivery

Deployed release `2026-10-28T03-52-36-600Z-6ad1ae26` (canonical runtime and production UI).

Export now offers **Add to Render Queue** and an adjacent header queue icon. Direct export is retained. The account-scoped queue displays project/scene, frozen revision/time, recipe, pending/rendering/completed/failed/cancelled status, progress, cancellation, retry, pending recipe edits and authenticated downloads. Each renderer window is opener-free and uses the existing compositor/audio pipeline. Keep a renderer window open or minimized; closing all renderer windows interrupts encoding and retains retryable snapshots.

Verification:
- Five native registry tests: scene/recipe snapshot isolation after an editor crop, app.state.read visibility, serialized restore, dry run, idempotency, revision conflicts, atomic validation/undo, FIFO claims, monotonic progress, fencing, cancellation, retry and disconnection.
- Two real-WASM host suites: concurrent submissions/claims under the durable file lock, deduplication, original binding survives source relink, changed media rejection, pending recipe configuration and stale revision rejection.
- Production TypeScript and optimized build passed. Existing Start End regression passed.
- Three real 1920×1080 HEVC/AAC exports: 12s, 72s and 68s snapshots, with sharpen/text/opacity animation and separate processed audio. AAC container durations differ by about 0.075s of priming; video duration follows the snapshot.
- At `after-live-edit.json` timestamp, 72s job was rendering at 70.8% while source had been cropped to 68s and played to 6.12s (`playback.json`). That job produced the original 72s output.
- Enqueued the 68s scene with medium quality, then undid both the crop and long fixture in the editor. Source returned exactly to its original 12s JSON. The queued job still produced 68s with its own recipe.
- Matched frame: original job at5s vs cropped job at1s (same source5s), RGB RMS difference0.994/255 across distinct HEVC bitrates. Audio RMS roughly−46.1dB, non-silent in each file.
- Refreshed queue, all three completed results remained. Downloaded the last job via its UI link successfully.

Only the disposable Start End test project was edited for live verification. Existing user podcast tabs, media cards and footage were untouched by these checks. The source test project was restored and saved. Queue window remains open with the completed test results.

No long multi-hour stress test or exhaustive codec/platform matrix is claimed. The queue is Classic-only; external media must remain present at its frozen path, and rendering shares machine CPU/GPU/disk resources with editing. History is bounded to200 retained jobs.
