# POCUT provider connections, 10 November 2026

## What is implemented

The Agent, AI panels and Director use one account-scoped transport choice. OpenRouter keeps its existing encrypted account vault and explicit paid-session authorization. Native Codex and Claude use a downloadable, locally started companion bound only to `127.0.0.1:43127`. The companion accepts the exact paired HTTPS origin, POCUT account, and a random 256-bit capability. Its HTTP surface has only provider status/login/logout/model catalog, structured editing proposals and bounded native image generation; there is no generic RPC, shell, arbitrary path, proxy or MCP endpoint. Provider credentials remain in the provider CLI's own local profile. Local models, video analysis and rendering continue to run in the browser.

The browser pairing is tab-scoped. Reloading that tab retains it; a new browser session requires downloading its pairing file and restarting the companion with that file. The native sign-in profile is stable for the same origin/account, so reconnecting does not copy credentials or borrow the desktop app's login. The existing direct local/desktop Sign in with ChatGPT flow is preserved.

`AgentConnectionsSettings` exposes collapsed provider sections. `prepare-ai-companion.mjs`, included in web prebuild and dev verification, bundles a standalone Node module with environment substitution disabled. The deployable files are `/downloads/pocut-companion-v1.mjs` and its version/size/SHA-256 JSON metadata. Users install Node 22+ and the official provider CLI, download the script and pairing JSON, then run the displayed command. They must keep the companion running and permit the browser's local-network request. This release does not install or start software on a customer's device automatically.

## Supported official routes

| Route | Text and editor proposals | Image generation | Authentication |
| --- | --- | --- | --- |
| Hosted OpenRouter | Yes, using the selected live model and authorized usage session | Selected image-output catalog model; exact job/batch review plus PIN | Existing POCUT account vault |
| Native Codex companion | Official app-server JSONL; model catalog from CLI | Official native image tool when the CLI advertises support; explicit human review | Native app-server managed ChatGPT login in a dedicated local profile |
| Native Claude companion | Unmodified CLI, safe/restricted mode, structured output, no machine/MCP tools | Unavailable; shown explicitly | User runs official `claude auth login` through the companion's login mode |
| Existing direct local SIWC | Existing official OAuth Responses connection, including image input | Unavailable in the SIWC token-sharing preview | Existing local registration/PKCE flow |

Authentication and a catalog entry are not proof of remaining quota, paid-plan entitlement, or a successful generation. Account limits remain provider-controlled. No real inference was performed for this change.

OpenAI's [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes native managed authentication, the JSONL protocol and capability discovery. Its [native image documentation](https://learn.chatgpt.com/docs/image-generation) documents Codex image generation and subscription limits. The separate [SIWC app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) supports an app-owned OAuth Responses connection, but the [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) explicitly exclude image generation. The [open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) requires a loopback callback; [website SIWC](https://developers.openai.com/siwc/website) is a different integration, not a general hosted subscription credential exchange. The implementation does not invent a hosted client registration or transplant tokens.

Claude's [CLI reference](https://code.claude.com/docs/en/cli-reference) documents native login, `--restricted`, `--safe-mode`, tool/MCP exclusion and streamed JSON. The [headless guide](https://code.claude.com/docs/en/headless) explains why `--bare` is unsuitable for subscription sign-in. We use safe mode, a private config directory, no built-in or MCP tools, and strip inherited API-key/token/provider overrides. [Claude's usage terms guidance](https://code.claude.com/docs/en/legal-and-compliance) distinguishes user sign-in to the unmodified CLI from third-party collection or intermediation of Claude OAuth credentials.

## Image and edit integrity

Native text/vision calls return only structured proposals for the live canonical registry. Rust still validates and executes editor changes. A native subprocess cannot execute the proposed tools locally. Codex startup disables machine/browser/shell/extension features, uses a private ephemeral workspace and restricted read-only sandbox, and rejects permission-escalation requests. Claude uses the official restricted/safe flags with an empty tool list and strict empty MCP configuration. Models receive attached image bytes through their documented input format, not base64 pasted as prose.

The canonical `imagegen.generate` capability now routes to native Codex when selected and asks for human approval of its exact prompt/reference count. Output enters the bounded ArtifactStore and the existing undoable Rust media transaction. The browser normalizes supported output to PNG and checks dimensions/bytes. Stable media identity and completion timestamp permit recovery of the same operation.

Production-board generation can explicitly choose native Codex or an OpenRouter image model without changing the Agent's text provider. Reviewed batches contain at most ten frozen slot prompts. Stable account/project/slot/version/prompt/provider/model identities deduplicate transport submissions. A local dispatch journal claims the image operation before provider I/O; the same completed request recovers its bytes, changed content conflicts, and uncertain dispatches cannot retry automatically. Local image results are capped at 16 MB each; journals at 100 operations and image cache at 512 MB. No uncertain journal is automatically evicted. OpenRouter uses the existing durable job ledger and separate human PIN. Batch preparation never authorizes provider spending. Each returned image appends only to its intended canonical reference slot; creative approval is separate.

Provider/account changes abort requests and discard responses, including after response headers. Native text transport has no automatic retries. Cancellation terminates the subprocess or app-server connection; a provider may already have accepted work, so uncertainty remains visible and is never treated as authorization for another call.

## Verification and limitations

Focused isolated tests cover loopback Host/Origin/account/token restrictions and unsupported routes; native official-protocol fixtures and denied escalation; Claude restricted CLI and inline image input; invalid proposals; dispatch recovery/conflict/uncertain outcomes; shared Agent/Director transport; provider changes during streaming; explicit image-provider selection; frozen OpenRouter image batches and preservation of batch review focus. Tests use mocked provider processes and HTTP responses, with no paid requests.

A read-only smoke test against installed Codex CLI `0.167.0-alpha.3.2` in a newly created empty profile returned installed=true, connected=false, imageGenerationSupported=false, error=null. The temporary profile was removed. This verifies launch/protocol compatibility only. Claude CLI was not installed on the development host, so its invocation is fixture-tested rather than authenticated live-tested. Older Claude versions without restricted/safe flags fail closed; current official CLI is required.

Remaining customer-device verification: official provider login in the new profile, browser local-network permission/OS behavior, actual plan/model access, native generated-image delivery shape and end-to-end approved usage. The code accepts inline image bytes or a newly generated file inside the private companion profile; opaque file IDs alone produce an explicit update/error message rather than an undocumented download request. No claim is made that all customer plans or browsers were exercised. No production SSH changes or deployment were performed by this subtask.

### Final local evidence

- `/private/tmp/pocut-connections-final-tests/summary.json`: 8 suites, 20 tests, zero failures (native protocol/cancellation, bounded transport/image journal, image host adapter, existing host effects, audio ledger including an independent worker process).
- `/private/tmp/pocut-shared-native-planning-tests/summary.json`: 35 existing podcast, smart-takes and reorganize-takes tests passed after their raw provider fetches were moved to the shared selection.
- `/private/tmp/pocut-native-image-rehydration-targeted.log`: five real-WASM manager cases passed, including generated PNG bytes and fresh browser URLs after paired save/reopen plus undo/redo. The initial 82-case manager run passed 78; four old browser doubles lacked EventTarget methods required by the new transport. After repairing those doubles, all four affected tests and the image case passed together.
- Scoped connection lint: zero errors, four existing-style synthetic-test assertion warnings. A whole-project standalone `tsc` still reports missing Bun test declarations and test-only errors; it is not represented here as a clean full-project typecheck. Release build verification is owned by the parent task.
- Standalone connector final local artifact: 510068 bytes, SHA-256 `96a8ecf0f6380b0cb2dceb4afadcc811f0a5915d2d4b2f18d43f14147a0009e9` (prebuild regenerates the manifest if source changes).

The native image projector hydrates from the existing canonical pinned artifact. `conversationArtifacts` includes `runtime.referenced_artifact_ids(project)` independently of chat entries, so project media does not depend on keeping a chat message. Image bytes are already part of the paired persisted artifact archive; no second metadata store or server-side image processing was added. Cached File/blob handles are only browser IO views and use the existing cleanup lifecycle.

Independent audio review also replaced in-process-only concurrency with durable per-job worker leases and account-locked reservations. A second process cannot bypass the two-active-request or storage reservation limits; an orphaned submitted request remains uncertain and cannot become another paid attempt. Explicit image-batch cancellation has a separate bounded cancel request for queued work, while already accepted provider calls may finish.
