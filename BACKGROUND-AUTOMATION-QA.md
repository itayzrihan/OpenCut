# Background automation QA — 22 September 2026

Restore point, committed and pushed before implementation: `d2f3c389` on `itayzrihan/OpenCut/main`.

Scope is Classic only. Single Full Auto Edit and Batch now use the persistent root host, isolated canonical EditorCore instances, existing Rust recipe/lifecycle, and the same editing implementation. No rewrite parity is claimed.

## Automated verification

- Broad browser-host unit sweep: 163 test files executed in separate Bun processes to avoid global mock leakage. 139 passed; 24 failed.
- Every one of those 24 failing files was run against the untouched restore-point checkout; all 24 also failed there. Common failures involve partial WASM mocks, Bun loading the bundler WASM artifact, old AI skill inventories, and old silence-default expectations. They remain unresolved; this is not an all-green application test suite.
- Rust: 124 tests passed across timeline (102), effects (4), time (10), storage (3), podcast (2), compositor (3), and masks (0).
- Focused final tests: host queue 6, worker 2, progress presentation 3, read-only ownership 3, save manager 4: 18 passed. Run the mocked test files in separate Bun processes.
- Scoped ESLint: zero errors; type-assertion and state-effect warnings remain. Whole-app TypeScript has existing errors; no diagnostics in the changed automation, API, editor route, or project-manager surfaces.
- Host regressions cover concurrent enqueues/FIFO selection, private token isolation, sibling failure, cancellation acknowledgement, expired leases, revision conflicts, in-flight write/handoff serialization, and reservation of queued project IDs.
- The stale-viewer regression checks that completing a job does not permit its old in-memory snapshot to overwrite the result, and that a load from an older ownership generation cannot unlock writes.

## Interactive verification

All actions used disposable QA projects and local eight-second Hebrew video fixtures. No original short was modified and no export was started.

- In-project Full Auto Edit handed off to the root worker and completed all ten stages after navigation to Projects.
- Batch containing an intentionally invalid MP4 and a valid source: invalid import failed independently; valid project `45588b06-4937-4307-864e-62fd25953857` completed all ten stages with Zoom, Transitions, Word Animation/Reveal, and Music enabled.
- While Batch ran, project `624371de-46f6-4155-ae47-e3733d686cb2` remained editable. Added a bookmark, undid and redid it, exited, reopened, and verified persistence.
- Submitted another single edit while Batch was active. Its worker remained queued; cancellation completed before editing and did not stop the executing batch.
- Floating activity and worker remained present on the editor, Projects, and Home. The active job advanced through AI stages while away from its project.
- Final saved batch assertions: 1080×1920, cover video, local horizontal subject offset, six captions in two tracks, one-row source settings, hidden punctuation, centered 60% / 25% captions, three classic zooms, nonzero snap-in/jump-cut release, and music exactly 6.288 seconds at -28 dB from a sufficiently long source. The existing custom-font resolver selected `Assistant ExtraBold` from the local library.

## Defect found during QA

An early single-edit result could be overwritten when opening another project after automation completed: navigation retained the old editor instance, and its forced save became writable when the server lock ended. This was caught by comparing saved documents rather than trusting the completion indicator. The fix retains a local stale-snapshot write barrier until a full reload acknowledges the current ownership generation. A dedicated regression test covers it.

The fixed scenario was rerun end-to-end on `f84ce02b-a082-4cb0-a26e-80449affdd1b`, with all four additions enabled and Projects left open until all ten stages completed. It saved five captions in two tracks, edge feather, three zooms, and three audio tracks. After opening and exiting an unrelated editor, its document remained byte-identical (SHA-256 `3b6fc1b669017f7387c2a6184b43a7a46d10e816d38f7fecdb2b5a104622cb46`). Reopening the result allowed adding and undoing a bookmark, confirming that the fresh load restores normal editability. Dragging the expanded floating control also moved the following panel during this run.

## Limits and reproduction

Keep the launching app tab open. Internal app navigation is supported; closing/reloading the browser is not an OS background service. After three minutes without a worker heartbeat, locks expire and jobs are marked interrupted. Work already saved remains available for review. Multiple host server processes sharing the same storage root are unsupported.

Long-film performance, every possible visual preset, and export encoding were not exhaustively exercised by this change. Broad unit coverage and real full-pipeline short-video runs do not establish universal absence of regressions.

Raw broad-sweep logs and baseline comparisons are in `%TEMP%\opencut-background-qa`; native output is `%TEMP%\opencut-background-rust-tests.txt`.
