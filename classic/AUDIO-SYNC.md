# Per-clip audio synchronization

Status: classic-only. Uses the existing serializable element `params` model,
parameter edit transactions and undoable Timeline Source v2 transactions; no
parallel project store or rewrite implementation is introduced.

Select a video or audio clip and open Audio → Audio Sync Offset. Values are
timeline seconds, from -5 to +5: -0.30 advances sound by 300 ms, +0.30 delays it.
The default is zero. This is a per-element setting, not a global export offset.
Video parameter edits now slip the video source window by the offset delta:
-0.10 extends the head by 0.10 seconds and removes 0.10 from the tail. Timeline
position, duration, captions and other elements are unchanged. The existing
audio offset compensates this slip, preserving the intended speech boundaries.
`audioSyncRetrimOffset` records the slip already applied, so repeated edits are
idempotent and resetting to zero restores the source window. Legacy documents
without this marker have not been retrimmed. Source handles limit the requested
offset and slip together. This is one existing undoable parameter transaction.
Raw Timeline Source edits must include the corresponding trims and marker.

Rust `resolve_clip_audio_timing` resolves the source window for both live audio
playback and export. Constant playback speed is included in the calculation.
Unavailable source before zero is silence; the audio never extends beyond the
clip's timeline window. Parameter edits invalidate the existing playback cache.

Validation: Rust tests cover advance, delay at the source boundary, playback
speed, zero/invalid offsets and a completely silent window. The WASM export is
included in the required-export check. The Short1 trial sets -0.30 on each of
its 15 video clips through one undoable source transaction, then reads it back
after reload; no other source fields change. The trial is now -0.10 per clip.
Sync-adjusted short sources (up to 5 minutes and 1 GiB) use a shared full-source
decode in prepared preview playback, matching export, instead of independent
AAC seeks at every cut. The shifted source range keeps the complete clip duration,
even for clips shorter than the offset. Sample tests verify reads beyond the
original cut with both 0.10 and 0.30 second advances. At the actual end of the
source file, further sound is unavailable and the remainder is silent.
Final lip-sync suitability remains
a listening/viewing check of the user's trial export.
