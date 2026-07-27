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
