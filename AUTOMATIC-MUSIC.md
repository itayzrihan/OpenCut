# Automatic Music

Status: **classic-only**. Uses the existing Classic EditorCore/CommandManager and Timeline Source v2 transaction. No separate project store or rewrite feature was introduced. Rewrite migration requires typed capability contracts and parity tests.

The AI tab has a standalone Automatic Music button. Full Auto Edit has an independent Music checkbox, off by default; Rust orders music after the other selected finishing steps and before save. All 16 combinations of the four options are tested. The future Projects Batch should pass the same `FullAutoOptions.music` field for each independent project; Batch itself remains deferred pending user approval.

The browser reads the complete Sounds > Music catalog and its Music categories. The model sees names, categories, durations, eligibility and the complete timeline/transcript. Selection is based on that metadata and the video's content, not a claim to have listened to every song. Only an existing Music asset ID and a short editorial reason are accepted.

Rust determines the end of the visible main video, excluding unrelated audio tails. Music must cover that full duration. The chosen clip starts at zero, ends at the video end, trims the remaining source and has volume −28 dB. No looping, stretching or short-song padding. A source of exactly the video length is allowed. Missing/invalid duration is ineligible. Unknown catalog durations are measured when possible, and the selected file is measured again before compilation/application. If it is missing or shorter than its catalog metadata, the host asks once for a replacement. If no eligible song exists, music is skipped with a visible message and Full Auto continues to save.

Re-running replaces only clips owned by Automatic Music. Other music, original speech and SFX are preserved. The final folder membership, project, scene, revision and cancellation state are checked before a single undoable transaction. No music file, URL or volume can be invented by the model. Catalog/timeline content is untrusted input. Cancelling or validation failure before the transaction leaves the timeline unchanged.

## Validation

- 92 native timeline tests passed, including six music tests covering short/unknown/non-Music rejection, exact-length acceptance, long-song trimming, −28 dB, ignoring sound tails, duplicate/empty inputs, actual-duration revalidation, replacement and preservation of manual audio.
- Full Auto stage test covers all 16 option combinations and music immediately before save.
- WASM built and 26 required exports verified.
- Scoped ESLint passed. Workspace TypeScript has pre-existing errors; none in the new music or updated Full Auto files.
- Live UI verified the fourth independent checkbox and the standalone button. Final live result follows below.

### Live result

On `Full Auto Edit - QA - Short6` (`9f68a966-d752-42bc-81c1-63f7bcb0df81`), the AI selected `sunsides-percussion-beat-203860` (asset `81816895-9e38-4005-8c19-c76fe0cdc1cb`) for the short's preparation/confidence message and pace. The actual source measured 3,473,238 ticks; the inserted clip starts at zero, lasts exactly the main video's 2,039,265 ticks (16.993875 seconds), trims 1,433,973 ticks and has volume −28 dB. The three prior sound elements remained unchanged. UI Undo removed the music and restored every previous track exactly; Redo restored the complete music transaction exactly. The QA project is left open with the music for listening/review. The Full Auto dialog visibly includes the fourth independent checkbox. The full transcription pipeline was not rerun for this additive feature; the tested native recipe routes the same live-tested music adapter before save.
