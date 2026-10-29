# DeepSeek Harness inside OpenCut

Migration status: **bridged**. Classic's existing chat now uses the actual
DeepSeek Harness agent loop and native tool executor. The shared Rust editing
runtime remains canonical. The rewrite's native shell has not been given a
second integration or a second document store.

Upstream: <https://github.com/deepseek-ai/deepseek-harness>, MIT.
The integration pins the published `@deepseek-ai/dsh-*` packages to
`0.2.2-alpha.2` and Cordis to `4.0.6-alpha.1`; package integrity hashes are in
`classic/bun.lock`. No upstream source tree, desktop app or CLI profile is
launched. Update these packages together and rerun the integration checks.

## Ownership

1. `EditorAgentClient` starts/resumes the existing Rust run and opens an
   authenticated streaming scheduling channel.
2. DSH's `AgentLoop` asks its OpenCut provider adapter for a completed response.
   The browser prepares that request through Rust and uses the existing
   `/api/editor-agent/respond` transport, including its streaming UI and safe
   provider retry policy. Codex model selection, subscription sign-in, OAuth
   scopes, token vault, refresh and disconnect are unchanged. No DeepSeek account
   or API key is used.
3. A single native `opencut_editor` model call is represented as that actual
   call in DSH, retaining its call ID and arguments. The native executor asks the
   active browser to apply the original full Responses envelope through Rust.
   Malformed, text-only and multi-call envelopes use an internal
   `opencut_dispatch` handoff, once, so Rust retains its existing feedback and
   rejection behavior. That handoff is never exposed to the model.
4. Rust validates the model action against the live capability registry and
   binds project, account, epoch, optimistic revision and idempotency. Existing
   host effects, artifact storage, atomic persistence, undo and visual review
   run through the same code paths. DSH proceeds only after that round settles.
5. A Rust `completed`, `failed` or `paused` phase stops the loop. The browser
   compares DSH's final phase with the canonical run. DSH cannot attest an edit
   or bypass a pending operation, unfinished plan or verification gate.

DSH's transient session is an orchestration journal, not a second editing
document or a recovery source. Rust still owns model context, learned
contracts, project state, receipts and durable checkpoints. A restart creates
a new DSH session around the recovered Rust run; it never replays a DSH log.

## Project boundary

The composition mounts only LLM runtime, session/projection registries, prompt
assembly, tool registry, native executor, agent registry and agent loop. It
does not mount plugin loaders, filesystem services, terminal, computer/browser
control, code execution, arbitrary MCP servers or upstream credential adapters.
The only registered tools are the two canonical dispatch adapters above.

Feature discovery and execution stay in OpenCut's live registry. Existing
account-owned project read/copy adapters remain available; cross-project
invocations are rejected by Rust. Editor screenshots and UI controls remain
bounded to the active editor. No OS-wide screenshot/control capability is added.

The new HTTP channel carries no credentials and performs no editor or machine
operation itself. `withAccount` authenticates both start and reply requests.
Replies bind the authenticated account, project, random 256-bit channel token
and one-use callback ID. There is one outstanding callback and serial tool
execution. The browser independently checks account/project identity and strict
provider/apply ordering before every callback.

## Interruptions and bounds

Provider transport may retry only before a completed response is applied, using
the existing Rust policy. Handoff acknowledgements are never retried. A lost
acknowledgement, cancellation, scope change, server restart or malformed event
pauses the canonical run; resume reconciles any pending host operation by its
existing receipt/idempotency identity.

Transport requests are bounded to 4 MB; scheduling events to 64 KB; callbacks
time out after 15 minutes. The host admits at most two channels per account and
32 overall. A session stops at 2,000 rounds or 32 MB of tool argument journal;
resume continues from the canonical checkpoint. Tokens, timers, pending promises
and the DSH context are released on shutdown.

## Verification

Run `node classic/scripts/verify-deepseek-harness.mjs` after installing Classic
dependencies and building WASM. The check runs the real DSH loop, a complete
HTTP handoff through the real Rust WASM runtime, native tool editing plus
`app.state.read` readback, scope/replay/cancellation cases, and existing
connection, provider stream, retry, checkpoint and host-effect suites. Provider
responses are scripted; this does not spend subscription usage or establish a
live authenticated model request. Type checking uses the generated WASM and
content-collections declarations, as the normal Next build does.
