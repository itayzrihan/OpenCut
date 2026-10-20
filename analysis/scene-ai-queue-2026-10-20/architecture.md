# Durable scene AI editing

## Failure and ownership

The previous background job locked the project that the user was viewing. Unlocking it triggered a full editor reload. The executor also loaded the saved current scene rather than the explicit scene recorded on the job. Unified media was sent to the subject detector as though the virtual asset were a physical video, producing the observed framing failure.

Scene jobs now capture immutable inputs through the canonical Rust capability `project.classic.automation.edit`. The host stores linked media and isolated working projects, and maintains the IO lease/progress journal. The original project remains editable. Each completed stage is saved in the canonical worker document before publication. Retrying uses that checkpoint; it does not intentionally repeat completed stages.

## Migration contract

- Canonical Rust runtime: typed queue recipes, captured scene state, stage checkpoints, validated publication, collision-safe identities, undo, optimistic revisions and idempotent publication.
- Classic web shell: Assets selection, context menus, recipe dialog, progress presentation, browser model/decoder execution and media IO adapters.
- Scene jobs execute serially in a separate local browser window. Reloading or switching the main editor does not destroy that execution context or rotate its live lease. Keep the worker window open; closing the browser or terminating its process pauses computation. Saved work can subsequently resume.
- Legacy raw-file batch import retains its existing iframe executor. It is not claimed to have migrated to the new scene-window lifecycle.
- Results are additional scenes with independent scene canvas settings. Raw project getters remain raw for persistence; rendering reads the effective scene settings. Export planning resolves the same settings in Rust.
- Automatic framing resolves Unified Angles to the physical camera and source timing. Unattended full editing can retain a valid centered cover when optional local detection cannot decode; explicit subject detection still reports failures.
- A sealed job-owned PCM file can refresh one invalidated Chromium OPFS snapshot after `NotReadableError`/`InvalidStateError`. A changed file length remains an error; this does not silently replace audio or replay completed editing stages.
- Temporary audio first uses browser disk storage. If opening it fails, a separate host adapter can stage short mixes in a per-job PCM pool capped at 128 MiB. The mix estimate is checked before decoding, every write enforces the shared budget, and cleanup releases only that job's buffers. Large edited mixes still require functioning browser disk storage; this is not an unbounded RAM replacement for episode-sized audio.
- Expiry cleanup snapshots directory names before removing entries and cannot abort new work if old-folder enumeration fails. Deployment retention protects current, rollback and candidate releases plus the newest three verified builds. Only generated release directories with matching manifests are eligible; account/media data and unknown directories are excluded.

## Verification

Configured check: `.dip/tools/verify-scene-ai-queue.mjs`. It runs 16 Rust tests, 84 host/WASM tests, two deployment-retention tests, TypeScript and whitespace checks, then independently compares the saved live project with the pre-test baseline. Live completion requires two finished jobs, two published outputs, unchanged original scenes/settings, caption sources and retained Unified external-audio routing.

The machine's data disk reached 100% usage. Removing verified generated deployment builds restored approximately 76 GiB, while retaining active/rollback/candidate builds. Browser temporary storage still rejected opening with `InvalidStateError` afterward, so freeing disk alone is not claimed to repair the browser's internal storage. The bounded fallback addresses the short-scene workflow without deleting browser storage or user projects. OPFS is a browser-owned storage API; see [StorageManager.getDirectory](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory).

The UI evidence records two selected sequences, shared options, one waiting job, switching to a third scene, and a main-editor reload during local transcription. Final live completion is recorded separately in `live-verification.json`; this document alone is not evidence of completion. No export or exhaustive listening review is included in this change.
