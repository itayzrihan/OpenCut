# Smart Takes integrity and speech coverage

Capability status: classic-only, bridged through `project.classic.scene.takes.edit` in the canonical `OpenCutRuntime`. No independent editor store or duplicate MCP endpoint was added.

## Findings and changes

- The first Smart Takes attempt could exceed the native 20-stage metrics limit because every transcription progress update was recorded as a separate stage. Progress text now updates the UI without generating a new stage. A 400-update regression exercises the original failure; retries still reuse transcript and planning checkpoints.
- The assembly conflict digest included presentation parameters. Uniform framing/opacity/blend edits within a take group and caption position changes now rebase onto an alternative performance. Timing, source, caption text, audio synchronization and structural changes remain guarded. Repeated switches, reopening and Undo retain the visual edits.
- Default audio silence removal used the legacy path, including video source time for synchronized external audio. Audio and Smart modes now use the shared speech-protecting analyzer and canonical audio timing. Assemblies are cleaned from their archived source clock through the take capability, retaining alternatives, selection scope, captions, framing and undo history.
- Incomplete microphone coverage previously held an entire recording. Analysis now processes contiguous observed islands and retains unknown gaps. Noise calibration learns the distribution in sustained quiet windows; microphone noise fluctuation no longer implies continuous speech. Transcript word intervals, peaks and ambiguous quiet phrases retain protection.
- Smart Takes previously used audio evidence only to position the outer cut boundaries. New assemblies also split verified internal pauses. Existing assemblies retain their old timing until the user explicitly requests silence cleanup. Per-group cleanup thresholds are serialized and preserved across later switches.
- Independent offline transcription of the current recording's opening found two hook performances, whereas the saved transcript contained one. The planner therefore could not offer the missing performance. Fresh window transcription now checks sustained acoustic activity in uncovered transcript intervals, retries bounded windows before checkpoint publication, and merges words by time rather than deduplicating repeated text. Existing completed transcript checkpoints are preserved; this does not retroactively invent or overwrite words in an assembled project.

## Verification

- 175 shared timeline tests, including quiet speech, noise, gain invariance, incomplete coverage and repeated-hook recovery.
- 24 canonical take integration tests, including an optional private replay of the real saved project and synchronized audio; all caption words and the source archive are compared before/after cleanup.
- 65 browser-host tests cover task progress metrics, planning, canonical takes, silence adapters, audio sync, toolbar settings and bounded transcription recovery/checkpointing.
- Production TypeScript, clean diff validation, rebuilt WASM and production startup checks. Focused lint found no introduced errors; two existing `prefer-object-params` errors in `commands.ts` were independently reproduced from HEAD.
- Live browser verification and release identity are recorded in `verification.json` after deployment. Private source audio, transcript and project snapshots remain under ignored `.local/` storage.

## Deliberate limits

Acoustic features cannot prove that every quiet sound is non-speech. Uncertain audio is retained, and ASR recovery is an evidence-gathering retry rather than a guarantee of complete recognition. Structural edits still require Undo before replacing their underlying archived take. A missing alternative in an already assembled project needs a reviewed source transcript update/reanalysis; the application does not silently rewrite that project's source words.
