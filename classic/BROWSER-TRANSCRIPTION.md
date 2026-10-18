# Browser transcription (classic)

The classic editor's transcription manager, Auto Texts and Full Auto Edit use
the same browser transcription adapter. Audio extraction/16 kHz mono decoding,
model download and inference run on the client. They do not call the host
`/api/transcription/whisper-cpp` route. The Tailscale gateway blocks that legacy
route; the native/local route remains available to existing local integrations.

This capability is **classic-only**. It preserves the existing Rust task state
transitions and editor caption commands/undo. It introduces no second project
state store and makes no change to account data or asset migration.

## Model and runtime

Transformers.js 4.3.0 runs in a dedicated worker, installed under a pinned npm
alias so other model adapters keep their existing 3.x runtime. This includes
upstream's Whisper word-alignment fixes (PR #1594); the 3.8.1 runtime returned
collapsed, out-of-bounds word times on the synthetic browser fixture.
WebGPU with `shader-f16` uses
`instush/ivrit-whisper-large-v3-turbo-timestamped-onnx`, pinned to
`c71eadaca74c0923a06632bdaeb7413ff9cff4cf`, with q4 encoder and q4 decoder for windowed transcription.
Without that capability, single-thread WebAssembly uses
`krivlin/whisper-large-v3-turbo-ivrit-ai-timestamped-onnx`, pinned to
`af7e6de7bb1210105c8176f79236bd7c69e73002`, with the q8 filename variants.
Both are community format conversions of ivrit-ai Large v3 Turbo, **not official
ivrit-ai ONNX releases**. Attribution/license: Apache-2.0; ivrit.ai Hebrew
fine-tune, OpenAI base model, ONNX conversions by instush/krivlin. Model cards:

- https://huggingface.co/instush/ivrit-whisper-large-v3-turbo-timestamped-onnx
- https://huggingface.co/krivlin/whisper-large-v3-turbo-ivrit-ai-timestamped-onnx

The official ivrit-ai ONNX export lacks cross-attention outputs needed for word
alignment. The timestamped conversions expose them; the worker requests real
word timestamps, not estimated equal-length word intervals. Decoding uses
30-second windows with 5-second overlaps. `auto` retains the prior Hebrew
default because ivrit-ai's language autodetection is unreliable.

Windowed WebGPU transcription downloads approximately 760 MB of quantized weights, plus runtime/config files. The CPU conversion is larger. Public weights
use the browser cache; clearing site data, browser eviction or private browsing
can require another download. Sufficient RAM, storage and a supported browser
are necessary. WebGPU on macOS uses the browser's Metal backend; there is no
direct Metal API in the app. CPU execution is substantially slower.

Web Locks serialize transcription across same-origin tabs/batch frames. Workers
are terminated on completion, failure, cancellation, navigation or account
change, releasing model/audio memory. Only public weights are stored in the model cache. Timeline jobs separately cache completed text windows in an account-scoped checkpoint cache; no audio or credentials are persisted there.
Download/inference status flows through the existing task and batch progress UI.
If GPU loading or inference reports a memory allocation failure, the worker
transfers the audio back without copying it. The service terminates that worker
before retrying once in a fresh worker with the same pinned model's q4 encoder
(425 MB instead of 1.27 GB) and q4 timestamped decoder (334 MB). This reduces
weight size; it does not guarantee that every device or recording fits in memory.
Encoder quantization can affect recognition accuracy. The legacy single-buffer API retains the fp16 path. Timeline and Blob transcription use the q4 encoder from the start, and progress identifies the reduced-memory model.
The retry remains inside the browser lock and respects cancellation and account
changes. Network failures do not trigger this retry, and the WASM path never
loads the GPU conversion. A second memory failure stops with specific guidance.
An ONNX resource adapter also releases leftover GPU session outputs after each
generation window, after CPU token/timestamp extraction. This bounds the known
Transformers 4.3 encoder/attention/KV output retention between windows (upstream
issue #1739). It never disposes session weights or live generation inputs.

## Testing

`/transcription-check` uses the identical adapter without touching a project.
The bundled WAV is synthetic English speech authored for this check with Windows
SpeechSynthesizer: “Welcome to Open Cut. This is a browser transcription test.
The audio stays on your own computer.” A local Hebrew audio file can also be
selected. Run twice to check cached weights, and cancel during download or
inference to check worker termination.

Unit coverage includes worker failure/retry, cancellation during initialization,
queued cancellation, page departure, account isolation, pinned model/device
selection, word timing and the canonical transcription manager's stale-timeline
protection. GPU resource tests cover release between windows and after failure,
without disposing CPU outputs or session weights. Optional detector transport
tests distinguish uninstalled detection from authorization/inference errors.
Memory-recovery tests cover load/inference failure, audio ownership transfer,
termination before replacement, bounded retries, pinned q4 selection, and
cancellation/account changes during recovery. Real-device q4 recovery and
Hebrew accuracy still require browser QA.

On 2026-10-12, the existing packaged macOS Chrome release at localhost:3211
downloaded the fp16/q4 weights and transcribed the synthetic sample into 16
timed words. This confirms the baseline download/GPU path on that device; the
packaged release predates the recovery change, so it does not validate q4
recovery or reproduce the reported failure on the user's recording. The source
change passed all 29 focused worker, service, GPU lifetime and manager tests,
plus targeted ESLint. Full TypeScript checking still reports unrelated test
errors outside transcription.

Browser verification on 2026-09-29 used the ivrit-ai model with the synthetic
English fixture on Windows WebGPU. The 8-second fixture produced 16 words with
distinct, in-bounds timing. Repeating it across 40 seconds produced 80 words;
four minutes produced 480 words, all monotonic and within the audio duration.
The latter exercises overlapping windows and the GPU lifetime adapter. Both
ONNX weight files were present in the public model cache. This is execution and
alignment coverage, not a Hebrew accuracy benchmark. macOS/Metal, actual CPU
inference, natural Hebrew, longer recordings and low-memory devices still need
hardware/browser QA. Unit coverage verifies CPU fallback selection.

The deployed production webpack build was also exercised through the HTTPS
Tailscale URL: automatic model download, WebGPU inference and 16 correctly timed
words from the fixture succeeded. This check used the real production worker
and authenticated account gate, without changing a project. A second invocation
also completed with the same timing after the first download; the page reported
no console errors.

## macOS editor memory investigation (2026-10-12)

The 70.505-second, 935 MB 4K/60fps project reproduced an allocation failure at
`readResponse`'s initial `Uint8Array` allocation, during model loading, before
inference. A fresh worker and the q4 encoder retry did not resolve it: even the
cached 334,048,758-byte decoder allocation failed. Cached file lengths were
correct. The worker now reports the phase, device, retry mode and loading file
names with its terminal diagnostic. Loading failures recommend reopening the
editor; shortening audio does not shrink the fixed model allocation.

A new browser tab loaded the full fp16/q4 model and successfully transcribed the
same complete project into 105 timed words. The old tab subsequently failed
loading the model even on the short sample check, after leaving the editor and
reloading the page. This localizes a remaining problem to that browser
renderer/environment; it does **not** establish a specific application leak or
prove that the smaller model repairs renderer allocation failures. The user
also closed other applications during this investigation, so this was not a
controlled system-memory benchmark.

macOS `vmmap` physical-footprint snapshots showed 9.5 GB for the debugging
Next.js server, 2.9 GB for a second unused development server, and a historical
16.9 GB peak for the old Chrome renderer. The fresh renderer peaked at 6.6 GB
and returned to approximately 1.3 GB after the successful real-clip run.
RSS alone understated process usage under compression. System swap was about
9 GB initially and later grew during compilation and testing. These process
peaks are not necessarily simultaneous and must not be summed as current usage.
The unused port-3000 server was stopped. Port 3211 now runs development with a
4096 MiB V8 old-space limit (not a total-process RAM cap); its measured footprint
after recompilation was 5.2 GB. Local production remains stopped.

Smart takes requires a selected main-track video and caption source. Its
disabled label/tooltip now states the missing prerequisite, and the tooltip can
be hovered even when the button is disabled. The successful transcript removed
that prerequisite failure. ChatGPT authentication is independent of local
transcription; the reconnected account was available during this investigation.

## Scope of server use

This change moves speech recognition to the browser. Account/project storage,
the authenticated OpenAI relay and the existing subject-framing endpoint remain
server components. Full Auto Edit can still use those services; it is not an
entirely offline recipe. No OpenAI login is needed for transcription alone.

When the optional host subject detector is uninstalled (503), Full Auto Edit
uses its existing Rust centered-cover fallback and reports a warning. The
explicit Center Subject action still requires detection; authentication, busy,
network and inference failures are not silently treated as missing detection.

## Smart takes preparation

The classic Smart takes host workflow now accepts selected main-track videos
without an existing transcript. It runs the canonical transcription manager,
then the shared Codex correction adapter, and only then captures the canonical
Smart takes source/revision. Existing transcript sources skip this preparation.
The same task powers the editor button and `smart_takes.start`; no second
project store or MCP endpoint is introduced. This orchestration is classic-only.

Progress and cancellation cover preparation as well as analysis. A failed or
cancelled preparation never starts take planning. Generated/corrected captions
remain normal undoable editor edits. A retry within the same task after a
correction failure reuses the generated words and retries correction before
planning. Correction checks project/scene/account identity and unchanged tracks;
take application retains canonical revision validation. Auto Texts reuses the
same preparation implementation and still adds row rearrangement and text
transitions; Smart takes preparation does neither.

## Long recordings (2026-10-12)

The timeline manager now uses `transcription/timeline-stream.ts` and the shared
`transcription/windows.ts` adapter. It never calls whole-timeline WAV extraction.
The common single-source, normal-speed podcast path seeks the compressed media
with an 8 MiB source cache and resamples bounded windows to 16 kHz mono. Each
minute owns a disjoint timestamp interval with five seconds of neighboring
context. The largest inference input is 70 seconds / 4,480,000 bytes, independent
of episode length. Original-rate decode scratch is also bounded to that window.
Edited mixes with effects, retiming or multiple audible sources reuse the disk-
backed export mixer and its canonical timing/gain/DSP adapters. This path needs
available temporary disk space and is slower than the single-source path.

One worker and quantized model are reused under a single browser GPU lock;
inference is sequential. Allocation/device/worker failure retries only the
current section once with a fresh worker. Five minutes without worker progress
terminates a stalled worker. Completed timeline sections can resume on retry,
including after refresh, while browser storage remains available. Checkpoints
are keyed by account, full timeline, media identity/relink revision, language and
pinned model revisions. Entries expire for reuse after seven days, are bounded
in number, and are never a canonical transcript: final insertion still checks
scene/revision and uses Rust normalization and the canonical caption command (superseded by the incremental checkpoint contract below).
Browser cache eviction/quota can prevent resume but cannot fail transcription.

Smart-take acoustic evidence now decodes 30-second windows and retains only
compact features, with gaps represented as missing coverage. Podcast text
window requests run with concurrency two and deterministic source-order assembly;
canonical review and atomic application are unchanged. No second model is loaded
for parallel inference.

The 3-hour scheduling/resume simulation and cancellation tests pass. A real Chrome
48 kHz PCM decoding check processed all 180 windows of a synthetic three-hour
recording in 22 seconds: largest inference PCM allocation 4.48 MB; observed JS
heap peak about 245 MB (excludes native audio buffers and model memory). This is
a decoding benchmark, not a 3-hour model-inference or Hebrew-accuracy benchmark.

The current reduced-memory model also transcribed a 125-second Hebrew excerpt
from the linked Yomano4 recording across three windows on macOS Chrome: 308 timed
words, no invalid/out-of-bounds times and no backwards starts. This validates
real repeated model use and Hebrew audio; a full three-hour inference run has
not been completed. The full focused suite covers 48 tests plus production-source
TypeScript and targeted lint checks.


## Incremental canonical checkpoints (2026-10-12)

Migration status: **classic-only**, registered in the shared `OpenCutRuntime` as
`transcription.classic.edit`. No separate UI transcript document is maintained.
The host owns audio decoding, inference and disk IO; Rust owns checkpoint
validation, source-clock mapping, caption insertion, revision and history.

Each completed 60-second ownership section is appended atomically to
`document.transcriptionJobs` and published as caption cues before decoding the
next section. The host awaits the fenced atomic editing-session save. Raw
provider CacheStorage entries remain an additional recovery layer, not the
source of truth. Project/archive persistence retains the immutable source
snapshot and completed sections even if that disposable cache is evicted.

Each append uses the latest canonical revision and original target scene. Words
are mapped through source media time into surviving moved, trimmed, split or
retimed clips. Prior caption IDs, manual text/style/timing and unrelated edits
are preserved. Deleted scenes/clips or relinked bindings keep the original words
in the job without placing captions over unrelated media. Identical section
replay never adds duplicate cues. If Undo removes checkpoints during an active
run, the host reconciles completed sections using its original source snapshot.

Opening a writable project automatically resumes a running job. Explicit Cancel
persists `paused`; it resumes only on another user request. Concurrent transcript
consumers share the active promise. Smart takes, podcast excerpts and Auto Texts
wait for incomplete jobs instead of treating a partial transcript as complete.
A crashed worker retries the current section with a fresh worker; persistent
failures remain visible and retain completed work for a later retry/reopen.
Storage or unavailable media can still prevent continued processing; this is
not a guarantee against operating-system/browser failures.

Verification includes canonical Rust registry tests and the actual browser WASM
through its TypeScript session adapter: incremental visibility, duplicate replay,
source removal, movement/scene switching, retiming, manual edits, Undo recovery,
partial archive/reopen and continuation after splitting/moving a clip. Host tests
cover save-before-next-section, concurrent consumers, cancel/pause, replay after
interruption, and replacing only a failed inference worker. A fresh three-hour
model-inference run has not been performed for this checkpoint change.

## SRT and external engines (2026-10-12)

The Captions panel now exposes **Import SRT instead of transcribing** and
**Transcription engine → Local / External API**. SRT import is canonical Rust
(`transcription.classic.edit`, `importSrt`): strict bounded parsing of UTF-8
BOM/CRLF, comma/dot timestamps and multiline cues; invalid input is atomic.
Original cue times are preserved. Word times are evenly estimated within each
cue, explicitly marked in source metadata and explained in the UI. Import
replaces caption-source tracks in the target scene, preserves ordinary text
tracks, supersedes unfinished transcription jobs, and is undoable. Imported
source words feed Smart takes, podcast excerpts and Auto Texts without inference.

Migration status remains **classic-only**. Engine preference is canonical
`document.transcriptionEngine`; jobs retain their engine and external endpoint/
model identity. External execution bypasses browser model initialization and
reuses the same bounded window, checkpoint and publication pipeline. Changing
API credentials for the same endpoint/model preserves resume identity; changing
the endpoint/model starts a new job on explicit generation rather than mixing
cached provider output. Automatic recovery keeps the old job and asks the user
to restore its settings or generate again from the intended scene.

The external adapter implements OpenAI-compatible multipart transcriptions with
`verbose_json` and word timestamps (default `whisper-1`), per the
[official file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).
Text-only model responses fail explicitly; timing is never fabricated for API
results. Configure the full HTTPS endpoint, model and API key in **API settings**.
ChatGPT OAuth is unrelated. Keys stay in account-scoped host credential files
(mode 0600) outside project/account-data exports, never in the canonical document
or browser persistence. Changing endpoints requires entering a key explicitly.
Requests bind the account and configuration identity, reject redirects, cap
request/response buffers, respect cancellation, and retry temporary network/
rate/service failures. No provider is contacted unless External API is selected
and transcription starts; the UI explains audio upload and possible charges.

Verification: canonical Rust and actual WASM import/engine/archive tests, mocked
provider requests including timestamps/auth/bounds, account-isolated credential
storage, cancellation before upload, and external windows retaining checkpoints.
A Chrome UI import of a two-cue Hebrew/English SRT verified original cue times,
transcript word controls, enabled correction actions and Undo cleanup.
A live paid provider request is not verified without a configured API key.

## Smart Shorts recovery and bridge memory

This recovery path is **classic-only host IO**. The canonical Rust podcast
capabilities still validate the source, apply all output scenes atomically and
preserve the original episode. The host caches computed proposals and audio
features; it does not maintain another editable project document.

Each reviewed five-minute model window and the final selection are checkpointed
against the account, project, scene, options and exact canonical word inventory.
Provider transport uses the shared Rust retry policy for bounded temporary
failures. Authentication, malformed output and source changes stop recovery.

Audio analysis checkpoints each completed 30-second window in account-scoped
IndexedDB. Keys include source/word identity, media binding revision, file
metadata, timing, rate and frame size. Float64 features preserve timing and
numeric precision. Only committed windows advance progress; interruption resumes
by decoding missing windows. Missing coverage stays unknown. No full recording
PCM is stored. The cache is bounded to 64 MiB and 2,048 window artifacts, with an
8 MiB per-window limit. Final selection is retained until project/history saving
confirms success.

The authenticated loopback Classic bridge accepts bounded full snapshots up to
32 MiB. After a full snapshot is acknowledged, unchanged document heartbeats
contain only UI/liveness metadata and the expected snapshot revision, at most
512 KiB. They preserve the cached timeline and tool contracts without cloning
those values. Restart, stale revision or project mismatch requires a fresh full
snapshot. Version 2 peers advertise optional `supportsHeartbeat`; legacy small
snapshots are replayed by a bounded account/session-scoped server cache rather
than repeatedly copying a large document in the browser.
