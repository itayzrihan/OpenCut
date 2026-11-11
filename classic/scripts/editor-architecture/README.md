# Editor architecture inventory and migration gate

Run `bun run architecture:check` from `classic/`. It scans all production web
TypeScript/JavaScript, including commands added outside the command directory,
and writes `.local/editor-architecture/inventory.json` at the repository root.
`bun run architecture:inventory` also inspects the **actual compiled WASM**
registry (build canonical WASM first), records its SHA-256, and rejects missing
or rewrite-only literal capabilities in the Classic session adapter.

The report includes legacy command classes, manager methods, action definitions
and bindings, JSX event handlers, canonical call sites and statically reachable
capability candidates. It resolves imported aliases and inherited commands with
the TypeScript checker. Nested callback bodies are included as possible paths;
their wrappers may not actually execute them. Generic Classic persistence/commit operations appear
separately from feature-specific candidates. No row is marked as parity verified:
reaching a capability does not prove that every branch uses it, that its effects
work, or that it is available to an agent in a loaded project.

## Enforced now

`legacy-commands.json` is the initial reviewed boundary, not a registry of agent
tools. CI rejects new legacy Command classes and changes to an existing class or
its imports. Comments and formatting do not change the fingerprint. Deleting
legacy commands as their features migrate is allowed. The Command base is also
guarded. The workflow uses an isolated, locked TypeScript dependency so it does
not require generated WASM or an application dependency install.

`legacy-mutation-sites.json` also freezes existing invocations of the generic
project/scene/track projection APIs, CommandManager's legacy execute entry, and
construction of legacy commands (including import aliases). New features cannot
reuse an existing snapshot/command entry point to evade the class-definition
gate. Call-site IDs use named lexical owners, call fingerprints and occurrence indices for identical calls, not line
numbers; comments and formatting are stable. Bracket calls with literal names
are included. Production imports/re-exports of tests and test-support are rejected,
including literal dynamic imports and CommonJS requires, so moving a legacy
command to a fixture cannot hide production usage. Canonical feature invocations
remain available without an agent-specific allowlist or a mutation-baseline edit.
This baseline was captured once during the reviewed migration increment; it must
never be regenerated in CI. Removal and duplication's retired class entries have
been removed so reintroducing those commands is rejected.

New editing behavior belongs in the canonical Rust capability registry. UI code
then invokes that contract; the agent and MCP discover it automatically. Preserve
existing feature behavior and test state readback, rollback and history before
removing its legacy command. A necessary legacy bug fix may require a reviewed
baseline hash change with a documented migration exception and regression test.
Do not automatically regenerate this baseline in CI or update hashes just to
silence a failure. Removing a command should also remove its baseline entry so
that its later reintroduction fails.

### Reviewed legacy exceptions for the production source at `f1d31bf57`

The baseline records these specific changes already present on main:

- Media import switched to localized error notifications. The media mutation and
  rollback remain the existing command.
- Caption clip movement uses the active scene's canvas. Retimed splitting uses
  the clip's source trim and tick units. These keep the legacy caption bridge and
  source timing behavior until their full migration.
- Group resize passes the owning editor to the existing update command and
  commits its filtered updates, removals and ripple timing as a single edit.
- Brand Kit preparation attaches metadata for fonts already copied into the
  current project. Rust still owns the actual Brand Kit timeline edit.
- Transcript correction and Auto Texts share the existing caption snapshot
  transaction through `runCaptionRecipe`. The two former `runAutoTexts` entries
  are removed.

The scanner still rejects subsequent changes to these exact commands and call
sites. Relevant regression suites cover timeline preview and group resize,
retimed splits, caption source synchronization and Auto Texts, project session
font metadata, and canonical Brand Kits.

## Not enforced or proven yet

This is a bounded migration ratchet, not complete future-feature enforcement.
Imported helper bodies, arbitrary inline object mutations, dynamically constructed
handlers, JSX spreads, higher-order callback invocation and external host effects
are not covered by the legacy-class fingerprint. Static candidate reachability
can miss paths or include conditional branches. An unresolved handler is not
evidence of a read-only action. Full feature-family migration classifications,
UI/shortcut capability components and mutation lint enforcement still require
implementation and behavior tests. The optional registry join is a compiled
snapshot without a loaded project; `available` is not a live session guarantee.
