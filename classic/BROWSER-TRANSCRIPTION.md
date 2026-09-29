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
`c71eadaca74c0923a06632bdaeb7413ff9cff4cf`, with fp16 encoder and q4 decoder.
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

First download is approximately 1.6 GB, plus runtime/config files. Public weights
use the browser cache; clearing site data, browser eviction or private browsing
can require another download. Sufficient RAM, storage and a supported browser
are necessary. WebGPU on macOS uses the browser's Metal backend; there is no
direct Metal API in the app. CPU execution is substantially slower.

Web Locks serialize transcription across same-origin tabs/batch frames. Workers
are terminated on completion, failure, cancellation, navigation or account
change, releasing model/audio memory. Only public weights are cached. No
transcription audio, transcript or credentials are persisted in the model cache.
Download/inference status flows through the existing task and batch progress UI.

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
protection. Model download/inference still needs hardware/browser QA, especially
long recordings and low-memory devices.

## Scope of server use

This change moves speech recognition to the browser. Account/project storage,
the authenticated OpenAI relay and the existing subject-framing endpoint remain
server components. Full Auto Edit can still use those services; it is not an
entirely offline recipe. No OpenAI login is needed for transcription alone.
