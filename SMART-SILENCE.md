# Smart silence removal and restored captions

## Migration contract

This capability is **bridged**: the complete product UI remains in `classic/`,
the shared Classic Rust timeline crate prepares the analysis and caption edits,
and `OpenCutRuntime` in `crates/editor-api` owns their canonical project state,
validation, revisions and undo history. The rewrite UI does not independently
implement this feature. The existing audio, fast and transcript removal routes
remain available with their established behavior.

The new Smart audio cut route calls `analyzeSmartAudioSilence`. It uses the
independent duration setting (0.3 seconds initially), with a separate toolbar
action so users can compare it with the existing audio action. Analysis uses
10 ms frames over each entire selected clip's source-audio span, accounting for
trim, playback rate and the same audio sync offset used by playback/export. It requires non-overlapping video clips on one unlocked
track and available, enabled audio for every selected clip. It rejects cuts that
would shorten or remove an unselected audible companion or change a locked track.
Decoded source timestamps remain intact; missing decode spans are unknown
samples, never manufactured silence. Channel activity is preserved even when
stereo channels have opposite polarity. The older decoder's default average
channel mix remains unchanged.

## Speech protection

The analyzer computes the duration-weighted mean RMS over the whole input span,
then compares it with weighted noise and upper-energy percentiles. The average
caps the silence threshold; loud words cannot simply raise the gate over quiet
words. Unsmoothened peaks, zero-crossing differences and changing quiet-sound
envelopes preserve possible consonants and whispered phrases. There is no fixed
absolute-amplitude floor.

Existing transcript word intervals are unconditional keep regions and are never
shortened. Adjacent activity is bridged across brief word-internal dropouts;
speech edges retain 120 ms by default, increasing to at least 250 ms beside
quiet activity. The minimum duration qualifies the
original pause before this padding: a 300 ms pause may remove only its middle
60 ms. Invalid/coarse/incomplete frame coverage and insufficient noise
separation retain the audio instead of manufacturing a cut.

These measures intentionally favor keeping uncertain audio. Acoustic features
alone cannot guarantee that a whisper identical to background noise is detected
as speech, and incomplete transcripts cannot protect words absent from their
timing data. This implementation does not claim a universal “never lose a word”
guarantee. Real speech review remains useful alongside the synthetic regression
coverage, especially for steady whispers, music and changing background noise.

## Restored caption gaps

Restoration emits exact inserted timeline/source intervals, including playback
rate. After restoring audio, the UI offers optional caption completion when an
editable caption source/style is available. The browser adapter decodes source
audio, transcribes the missing spans with a short context window and submits
timed words to the shared Rust caption compiler. Only words belonging to the
restored intervals are eligible; surrounding context and existing words are
deduplicated. The compiler reuses neighboring caption appearance, layout,
animation and transition data without regenerating existing captions.

Declining the offer leaves the audio restored. Transcription failure,
cancellation or a changed timeline leaves the existing captions intact.
Caption completion is a separate undo entry after restoration so it can be
reverted without removing restored audio.

## Canonical transaction contract

`timeline.silence.commit` is the typed `Write`, Classic-document capability for
`smart-remove`, `restore` and `repair-captions`. It requires `projectId`,
`sceneId`, `expectedRevision`, `operation` and a lossless `classic` draft.
Invocation context supports `dryRun` and `opencut/idempotencyKey` through the
shared registry. The immediate commit is transaction-safe and undoable; all
media decoding and transcription finish before it begins.

The contract validates the complete existing Classic document and limits edits
to target-scene tracks, derived project duration and modification timestamps.
Removal/restoration may also ripple target-scene bookmarks. Caption repair
cannot move bookmarks. Other scenes, media bindings, sources, project settings
and unknown feature fields are preserved. `app.state.read` exposes the exact
same resulting document; there is no separate MCP state or hand-written MCP
tool. The registry projects this capability automatically.

The UI uses `CommandManager.executeSilenceTransaction`, after canonical runtime
initialization. Every project view update goes through the scoped Rust
capability before publication. The existing canonical transaction creates one
undo boundary and rolls back failed commits. Browser audio buffers and temporary
transcription context remain host resources; only the existing serialized
timeline/caption state enters `EditorDocument.project.classic`.

## Regression coverage

- `classic/rust/crates/timeline/src/smart_silence.rs`: average-energy behavior,
  gain scaling, whispers/tails, protected word intervals, consonants, ambiguous
  noise, short dropouts, configurable duration and invalid coverage.
- `classic/rust/crates/timeline/src/restore_silence_captions.rs`: exact restored
  interval mapping and caption reconstruction with existing styling.
- `crates/editor-api/tests/classic_silence.rs`: each operation through registry
  invocation and `app.state.read`, dry run, idempotent retry, stale/project/scene
  rejection, bookmark scope and exact undo/redo.
- `classic/apps/web/src/core/managers/__tests__/canonical-command-manager.test.ts`:
  publication against canonical state, one undo boundary and failed-scope rollback.
- `classic/apps/web/src/timeline/__tests__/smart-silence.test.ts`: transcript
  overlap, cancellation, stale results, real Rust audio-sync mapping and companion
  audio/locked-track protection.
- `classic/apps/web/src/media/__tests__/decode-audio.test.ts`: stereo phase
  cancellation, preserved source timestamps, unknown samples and changing rates.

The checked-in `transcription-check.wav` is also exercised at original gain,
at one-millionth gain, with its middle phrase attenuated by 333 times, and with
that quiet phrase plus deterministic noise. The fixtures assert that no original
nonzero PCM sample overlaps a removed interval. This is regression evidence for
those recordings, not a recognition guarantee for arbitrary audio.

Changes to Rust require rebuilding both Classic WASM and the canonical editor
runtime WASM before the browser can use the new export and capability.
`bun run build:wasm` uses `--no-pack` plus the checked-in manifest writer to avoid
the wasm-pack 0.15 repeat-build package parsing bug; export verification still
runs for both binaries.

Validation on 2026-10-05: 144 timeline Rust tests, two canonical registry tests,
39 focused web tests, 18 canonical command-manager tests and three manifest
tests passed. The normal `build:wasm` command and production TypeScript check
(`tsc --noEmit -p tsconfig.build.json`) also passed. The command-manager suite needed a 15-second per-test timeout
while compilation was running (one unrelated existing test exceeded Bun's
default five seconds). Manual editor verification reached the local account
sign-in screen; no user project was opened or modified for GUI testing.
