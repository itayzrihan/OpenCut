# The Director — Generative

The current Classic OpenCut editor has a Generative tab immediately after AI. It combines a directing conversation, source reference uploads, original-audio transcription, structured explanatory JSON, a physical storyboard review, separate PIN-approved image/video requests, background provider monitoring and normal Media assets.

## Workflow

1. Open a project and select Generative. Its conversation and direction are saved with the canonical project. Chat uses the existing authenticated OpenAI/Codex AI connection, with image observations and three sampled frames per attached video. No editor/computer tools or paid OpenRouter tools are granted to that conversation.
2. Add PNG/JPEG/WebP references, MP3/WAV/M4A audio or MP4/MOV/WebM video. Originals remain unchanged in the account's private Generative artifact store, with bounded size, IDs and SHA256. Image observations in chat are smaller copies only. Audio/video duration is verified by the existing host ffprobe resolver. Original speech cannot be submitted to a shorter video.
3. Transcribe the original locally if needed, then review the provisional transcript against the recording. The Director prepares full spoken script, motivated anime beats, camera, timing, transitions, SFX and a physical storyboard prompt. Per-word timing is optional. The same Rust-owned instructions enforce unchanged speech, one instance per speaking character, visible lip sync and reference identity.
4. Upload an existing physical storyboard (the dedicated upload button marks it), or prepare an image-generation request and explicitly approve it with PIN. A completed storyboard is imported and attached. Video preparation is blocked until an actual storyboard image is present. Inspect it before proceeding.
5. Open OpenRouter settings inside Generative and privately enter the key/PIN. Each individual paid image/video request has a separate frozen review with references, playable source audio, exact prompt, settings and digest. The price is explicitly unknown unless verified; actual returned cost is displayed separately. Human-only approval is required every time, even during an active lease. Reject sends nothing. No automatic paid retry.
6. Accepted jobs run in the authenticated Node host. Free status/content reads use a fixed900second monotonic in-memory lease after PIN unlock, never extended by polling. Restart/expiry pauses existing-job checks; unlock resumes them without resubmitting. Ambiguous POST outcomes stay uncertain. No key, PIN or approve/unlock operation enters the canonical registry or MCP.
7. Completed video/image bytes enter the normal project's Media through its existing import manager, exactly once per job. No automatic timeline insertion. Right-click a Media asset for Download original or Add to timeline at the playhead. Removing an imported asset does not cause background reinsertion.

## Original audio and video HTTPS

OpenRouter provider ingestion needs reachable HTTPS links for these source types. When `OPENCUT_PUBLIC_ORIGIN` points to this host's publicly reachable HTTPS deployment, the adapter creates a random bearer link valid for1hour. It is readable by anyone holding the link until expiry; private account/project state is never exposed. The UI discloses this before approval. This does not create a tunnel or make a local-only host public by itself.

Without a public origin, supply the exact POCAST HTTPS download link alongside each uploaded audio/video reference. The adapter checks the remote bytes against the retained original SHA256 before freezing the request. Only POCAST or the configured OpenCut public host is accepted for this verification; redirects and arbitrary hosts are rejected. Old review requests expire after55minutes. The existing POCAST MCP workflow is not an embedded application credential and is not silently exported from Codex. There is no dummy silent-audio upload for scenes without narration.

## Architecture and scope

- `crates/editor-api/src/generative.rs` is the canonical serializable model, with bounded validation. `project.generative.read` and `project.generative.edit` are registered typed capabilities: project/revision scope, normal transactional history, dry run, idempotency, cancellation and live MCP discovery. Project extensions persist the conversation, references, transcript, direction and provider-result links. `app.state.read` reads the same state. The shared Director instructions are compiled into Rust.
- Classic UI and browser IO are in `classic/apps/web/src/generative`. Read-only polling uses a fixed read wrapper and never creates Undo frames. Reference upload, decryption, HTTP requests and file handles are authenticated Node host adapters. The bounded ID-only host artifact store is for provider IO; completed assets reuse the existing canonical Media manager and normal durable media storage.
- The visual feature is Classic-only. Its document/contracts are shared with the rewrite through OpenCutRuntime; no duplicate rewrite UI or alternate MCP implementation was added. Paid approval is deliberately a human-only HTTP boundary, not a tool capability.
- The API key is account-scoped AES256GCM ciphertext protected by scrypt/PIN, outside project state and Git. Credentials are not imported/read from the earlier standalone Studio. Same-user processes remain outside the isolation guarantee; short PINs are weaker against offline guessing. Account-authenticated requests retain the application's existing origin/session checks. Temporary sharing is restricted to a single artifact and expiry.

## Verification

Run `node scripts/verify-generative-director.mjs` from the repository root after the normal WASM build. It checks native Rust, real WASM serialization, exact route-envelope chat parsing, paid approval/races/uncertain outcomes, byte-matched HTTPS inputs, signed-link expiry, bounded requests, speech duration, idempotent media import, feature lint and production TypeScript.

A production Next.js build was also run with a separate build directory. Repository-wide architecture inventory currently reports four unrelated pre-existing legacy boundaries in MoveElementCommand, Brand Kits and caption recipes; the new Director files introduce none of those findings. Ordinary full-test TypeScript includes existing test-fixture errors outside this feature; production TypeScript is checked independently. Real OpenRouter billing is not exercised by offline tests, and generated output still needs human visual/audio/lip-sync QA. No actual key or PIN is used by the tests.

## External chat / MCP → OpenCut review

The current editor host registers `project.generative.request`. Live registry discovery projects it to MCP without a handwritten transport tool. In the connected Classic browser it is advertised as `opencut.classic.canonical.project.generative.request`; use `classic.session.read` to identify the exact browserSessionId/project/canonicalRevision, then describe the live contract. The native host name is `opencut.project.generative.request`; the headless runtime alone cannot execute browser-host IO. Keep the editor open and update its WASM/app build to advertise the new capability. Existing MCP configuration can be reused; reconnect a client with a stale inventory.

All calls carry projectId, expectedRevision, operationId and exactly one typed operation:

```json
{
  "projectId": "<open project ID>",
  "expectedRevision": 42,
  "operationId": "city-opening-v001",
  "operation": {
    "type": "prepare",
    "kind": "video",
    "model": "<supported Seedance model ID from live catalog>",
    "prompt": "<full explanatory JSON direction serialized as a string>",
    "duration": 8,
    "resolution": "480p",
    "aspectRatio": "9:16",
    "referenceIds": ["<imported physical storyboard ID>", "<imported character/location IDs>"],
    "httpsReferences": {"<imported original audio ID>": "<verified POCAST downloadUrl>"}
  }
}
```

The Classic projection adds browserSessionId at the outer tool envelope; follow its described schema rather than sending a native payload blindly. Read `project.generative.read` for the shared Director instructions. Save script/direction through undoable `project.generative.edit` and use the returned/current canonical revision. A video prompt is wrapped with the same immutable-dialogue/lip-sync/one-visible-instance instructions and original saved transcript; the resulting exact prompt appears in human review.

`operation.type=importReference` accepts name, MIME, dataBase64, original SHA256 and optional storyboard boolean. MCP imports are bounded to12MiB original bytes (16MiB canonical base64), checked for exact hash, saved privately and attached canonically. Larger files can use the existing100MiB UI upload. There are no filesystem paths or arbitrary URL-fetch operations. Audio/video still use the original-byte HTTPS verification and physical storyboard gate. `operation.type=status` returns bounded ID/digest/status links only and sends no provider request; the normal open-editor observer handles free monitoring/downloads within its human-unlocked lease.

Import and preparation open Generative. Preparing focuses the exact review with existing playable references, full prompt and settings; it does **not** submit anything paid. Only the human privately sets up/unlocks the vault and approves with PIN. No approve/unlock/setup/key operation exists in the MCP contract or narrow IO gateway. Unknown fields and operation variants are rejected.

A durable account/project/operation journal caches exact import/prepare results, including across lost replies; conflicting input is rejected. Revision is rechecked against the live project. Pending/interrupted operations require reconciliation in the same project; they are not automatically repeated. Use a new operationId/current revision for a fresh status observation. Host IO is explicitly open-world, Write, nontransactional, no dryRun; canonical reference/job-link changes use the normal editor transaction and Undo/Redo. No paid call is performed in tests.
