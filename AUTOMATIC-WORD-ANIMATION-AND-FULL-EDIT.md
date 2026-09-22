# Automatic Word Animation and Reveal / Full Auto Edit

Capability status: **classic-only**. These features use the existing Classic EditorCore, CommandManager history and Timeline Source v2 transactions. Rust in `classic/rust/crates/timeline` owns the word-plan compiler, density limits, recipe stage ordering, framing math and finishing transformation. Browser adapters perform media decoding, authenticated AI transport and existing editor commands. No duplicate rewrite document or separate project-state store was introduced. Rewrite migration requires capability-registry contracts and parity tests before claiming runtime parity.

## Sparse word direction

The AI tab has Automatic Word Animation and Reveal after Automatic Transitions. Every request loads the checked-in `automatic-word-animation/SKILL.md`, the actual preset catalog, complete Timeline Source, timed words and representative previews. The model returns exact element/word IDs and semantic reasons. It cannot author source paths, executable code, sounds or arbitrary properties.

The native compiler enforces a 10% ceiling on the union of **whole affected caption spans**, including existing manual accents. This conservative accounting includes styles that remain on an idle or spoken word. Word animation is selected per word; other words retain their presentation. Empty plans are valid and the AI is instructed not to fill a quota.

Letter by Letter is exceptional and usually absent. It is limited to two caption elements and 2% of video in actual typed word time, within the overall 10% ceiling. The existing typing asset is attached only to the selected 0.2–3 second word spans, with its existing −5 dB preset. Adjacent spans merge; no full-caption typing bed is added. Sounds are deterministic, not model-selected.

Reruns restore only unchanged properties owned by this feature, preserve subsequent manual changes, and replace owned sound elements. Validation or cancellation before the apply step leaves the timeline unchanged. A successful apply is one undoable canonical transaction.

## Full Auto Edit

The per-project AI dialog has four independent optional checkboxes, all initially off: Automatic Zoom, Automatic Transition Edit, Automatic Word Animation and Reveal, Automatic Music. All sixteen combinations are supported. The native stage recipe is:

1. Check fresh imported main-track video, available custom Assistant Bold/ExtraBold and configured Hebrew ivrit-ai large-v3 model.
2. Inspect five **raw uncropped frames per source media** with the local OpenCV + MediaPipe Pose detector (no LLM/cloud request). Rust merges duplicate face rectangles, requires one temporally consistent subject, optionally associates a reliable upper body, uses a stable median crop and clamps displacement to the cover bounds. Silence-cut fragments share a crop. See LOCAL-SUBJECT-FRAMING.md. Set 1080×1920 cover, with no empty edges.
3. Existing audio-based Remove Silences with 0.3 second minimum.
4. Shared complete Auto Texts: Hebrew transcription, Codex correction, semantic row arrangement, Apply & Arrange All Text transitions. One row, four words, hidden punctuation and center placement. Correction and row stages run once each and failures now stop Auto Texts.
5. Use the real imported Assistant bold font file, center captions, set bottom fade 60% / end opacity 25%, and add the black Editorial Edge Feather for the final duration beneath captions and above the main video.
6. Run chosen enhancements in order: zoom, transitions, sparse word accents, music. Music uses the local Music catalog, must cover the complete video, is trimmed to its end and set to −28 dB. See AUTOMATIC-MUSIC.md.
7. Flush the save and ask for human review. Never export automatically.

Framing is a **stable talking-head crop based on sampled face/body detections**, not continuous tracking. Multiple people, low confidence, disagreeing face/torso centers or large sampled horizontal movement stop before changing the frame. It cannot prove that unsampled moments are framed correctly. A face near the source edge may be clamped off-center to keep the frame covered. Moving-subject tracking remains separate work.

The dialog blocks accidental timeline interaction while running, shows progress and supports cancellation. Each completed stage remains saved/undoable after failure or cancellation; it does not silently roll back successful work. Re-running Full Auto on a scene with captions/effects is refused to avoid duplicates; undo completed stages or start a fresh imported project. Existing standalone buttons remain available for individual finishing work.

No batch import, background project queue, export automation, or continuous subject tracking is claimed in this change. Projects-page Batch is explicitly deferred until the user approves the single-project workflow.

## Validation

- All 86 timeline Rust unit tests passed; native tests cover sparse word scope, combined coverage, empty plans, timed typing audio, replacement on rerun, manual edits, invalid IDs/times, all eight recipe combinations and cover-bound clamping.
- Auto Texts tests cover correct stage order and stopping after transcription/correction failure.
- Three transcription manager tests passed, including cancellation and rejecting stale results after timeline edits. Three subprocess tests passed for draining output, abort and timeout.
- WASM rebuilt and all 24 required exports verified. Scoped ESLint passed. Workspace TypeScript still reports pre-existing errors; none were in these feature files.
- Standalone AI button completed on a separate duplicate (`Word Animation - QA - Short6`, `4c8acdbc-4a19-4b54-9567-94544b05b980`), choosing a valid empty plan for the already accented short. A per-word Glow fixture rendered in the editor and Undo restored the exact original tracks. Glow uses the existing per-word Glower so the caption shadow does not hide it.
- Live test project: `Full Auto Edit - QA - Short6` (`9f68a966-d752-42bc-81c1-63f7bcb0df81`), separate from the eight delivered shorts. Final live results are recorded after the run below.

Build cache note: C: ran out of disk space during compilation. The Classic `target` cache was moved intact to `G:\OpenCut-classic-target-20260922`; its earlier incremental cache is at `G:\OpenCut-build-cache-backup-20260922`. Subsequent Rust/WASM commands used `CARGO_TARGET_DIR` pointing to the former. No media or saved projects were removed.

Transcription validation: the initial CUDA run timed out after 30 minutes without a result. The same ivrit-ai large-v3 model with DTW completed a two-second CPU diagnostic in 88 seconds. Added optional server setting `WHISPER_CPP_DEVICE=auto|cpu` (default auto), and set this machine’s ignored local configuration to `cpu` for the complete validation rerun. The model and word timing method are unchanged. Request cancellation now terminates its owned ffmpeg/Whisper child and drains both subprocess pipes.

The second live run completed transcription, correction and row arrangement, then the UI parser caught a missing `name` on the generated edge-feather element. Added that required field and a native regression assertion; the four Full Auto native tests passed after the correction. The complete app skill check is blocked by an unrelated stale paper-grid-editorial projection; the zoom, transitions and word-animation skill projections all pass their individual checks.

### Final live result

The complete rerun finished with the UI success message “Saved. Review captions, speech cuts and framing before export.” All three optional stages were enabled. Saved project `9f68a966-d752-42bc-81c1-63f7bcb0df81` contains 10 video clips over 16.993875 seconds, 11 captions in two text tracks, six automatic zoom elements, three caption transition accents, two zoom sounds at −35 dB and one matched transition sound. The word planner selected an empty plan, which is valid for this already accented short; no reveal was forced.

Read-only inspection of the saved document confirmed 1080×1920 cover, Assistant ExtraBold (the available custom font), all caption centers at (0,0), fade 0.6 / end opacity 0.25, one-row hidden-punctuation layout, and one edge-feather layer spanning the final video duration under the text. The final editor preview at 8.1 seconds showed centered visible Hebrew captions and a fully covered vertical frame. No export was performed. The QA project is left open for human playback and caption review; the original eight shorts were not modified in this feature validation.
