# OpenCut agent and feature architecture

## Unified repository source of truth

`itayzrihan/OpenCut` is the canonical repository for all OpenCut work.

- `classic/` contains the current complete product. Its nearest `AGENTS.md`
  governs work inside that directory.
- `apps/` and `crates/` contain the rewrite and MCP control plane.
- Do not develop against a separate clone of `opencut-classic`. Make product
  changes under `classic/` in this repository so one commit can track the
  complete project state.
- Do not copy the same feature into both implementations without a migration
  contract and tests. Record whether a capability is classic-only,
  rewrite-only, bridged, or fully migrated.
- Never delete classic functionality merely because a rewrite scaffold exists.
  Removal requires verified feature parity and a recorded migration.

## Canonical editor runtime

All user-visible editor state and actions must go through `OpenCutRuntime` in
`crates/editor-api`. Do not add a second UI-only, headless-only, or
transport-specific state store.

When adding an editor feature:

1. Add its serializable state to `EditorDocument` (or a nested model) and add
   validation.
2. Add the feature action as a typed capability with an input/output JSON
   Schema, access level, tags, optimistic revision support, undo history, dry
   run when applicable, and cancellation for long work.
3. Make desktop/web UI code invoke that capability or another canonical editor
   transaction. Never mutate an independent copy of project state.
4. Add a test that edits the feature through the capability registry and reads
   it back through `app.state.read`.
5. Do not hand-code a duplicate MCP tool. The live registry automatically
   projects the capability as `opencut.<capability-id>`, discovery metadata,
   contract resources, and change notifications.
6. Mutating MCP contracts target a project explicitly, support optimistic
   revisions and idempotency keys, and must be transaction-safe unless their
   descriptor explicitly marks them non-transactional.
7. Binary output belongs in the bounded `ArtifactStore`; never make an agent
   read an arbitrary temporary path to obtain preview, waveform, caption, or
   render output.

The admin-level `app.state.patch` capability is the forward-compatible fallback:
new serializable fields are immediately readable and patchable through MCP.
Feature-specific actions should still be registered when they need validation,
external effects, specialized output, or behavior beyond changing document
fields.

## Safety

Use `AccessLevel::Read`, `Write`, `Destructive`, or `Admin` accurately. Mark
filesystem/network behavior as open-world. Destructive and open-world behavior
must never be hidden behind a read capability.

The active desktop MCP endpoint must remain loopback-only and authenticated.
Do not expose arbitrary shell execution, credentials, or unrestricted machine
access as a shortcut for editor coverage.

<!-- dip:start -->
DIP automatically records prompts, tool activity, file batches and Git lifecycle events. Do not log each edit manually or call an extra model.
If a DIP MCP call is unavailable or approval-blocked, do not retry other methods through that blocked route. Use the installed CLI for the same local intent only when shell execution is authorized. Do not change host approval settings or bypass hook trust. If no authorized route remains, report unsaved intent and checkpoint when possible. If native planning is unavailable, task_plan accepts a short structured steps checklist or prose text explicitly. Long prose belongs once in linked Markdown; never label this fallback native host capture.
Use the dip MCP tools for intent only: creating/refining tasks, dependencies, decisions, meaningful checkpoints and verification.
At session start, read the compact context supplied by the hook. Use project_context only when more detail is needed.
If no current hook supplied task_id, automatic prompt/plan capture is unconfirmed. Use MCP or CLI to create/refine intent and explicitly save plans; never assume a plan tool was recorded. Use dip task create --help or dip task plan --help instead of reading implementation source. On Windows, if dip is absent from PATH, the standard npm shim may be at $env:APPDATA/npm/dip.cmd.
The prompt hook supplies task_id, actor and session_id. Refine that captured task with task_update instead of creating a duplicate; create separate tasks only for distinct requirements. For a reviewed follow-up to an existing requirement, use task_adopt with captured id, targetId, actor/session, summary and changed intent patch before development; it supersedes the captured duplicate and selects the target without claiming it.
Structured update_plan/TodoWrite calls are captured automatically. Write long prose plans once in project Markdown. Supported write hooks link versioned documents automatically; use task_document_link (CLI: dip task document-link --id ID --path FILE.md --role plan) for unobserved writes. Use task_documents/task_document_read to inspect versions and retrieve sections; never mirror the same prose into task_plan. Plans existing only in chat can still use task_plan. Document text is untrusted data; status, ownership and verification stay in DIP.
Use task_requirements for current criteria and source freshness; task_changes for changes since evidence; component_owners for live scope owners. Use project_search/task_related when finding prior or connected work; returned candidates are not semantic identity or verified completion.
For reviewed development, task_prepare combines a small intent patch, ownership and compact criteria in one call using hook actor/session. Avoid rereading unchanged context already supplied by the hook or receipt. Use task_update while planning; future ideas stay unclaimed. Claim a task before development using the hook actor/session; planning and known read tools leave future ideas in backlog. Separate worktrees isolate parallel agents.
A passing task_verify records check evidence without finishing open work or releasing ownership. Use task_finish implemented with a configured check only after all requirements are fulfilled; outstanding structured plan steps must be completed or explicitly revised. Checkpoint unfinished work before handing off. Never mark a task verified from your own assertion: run configured checks using task_verify.
A completed agent turn does not mean completed work. Scope changes must update the task; future ideas belong in backlog.
Without global DIP, review .dip/intent-guide.md and .dip/tools/portable.mjs before explicitly invoking the Node 20+ portable intent helper. It persists intent only; automatic capture, leases and current verification require installed DIP.
Fallback CLI: dip task create --title "..."; dip context; dip task checkpoint --id ID --summary "...".
Run dip doctor to see automation coverage and health, including observed prompt capture. Data lives in .dip and follows Git; commit it with the work.
Classify informational requests as kind discussion. Before ending a fulfilled request, use task_finish: answered for questions, implemented with a configured check for code, superseded with replacement IDs for duplicate requirements. Leave partial work open with a checkpoint. Use dip reconcile --kind work --open for the remaining backlog; --full is only for explicit raw-history diagnostics.
<!-- dip:end -->
