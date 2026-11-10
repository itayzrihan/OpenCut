# POCUT project exchange and track selection

These capabilities apply to the Classic POCUT editor in the browser and Electron.
Both hosts use `OpenCutRuntime`; no second project or selection store is added.
The rewrite timeline is not a separate target of this change.

## Project export and import

The Project menu opens an export dialog with two formats:

- **Full project ZIP:** the portable project metadata and original asset bytes.
- **POCUT project XML:** project metadata without original media. Import asks the
  user to select the required files before creating a new project.

POCUT XML is a lossless POCUT project format, not a Premiere or Final Cut interchange
format. Its bounded XML envelope contains canonical JSON so unknown supported
project fields can survive without an independently maintained XML model. DTDs,
external entities and executable XML features are rejected.

`project.classic.exchange.prepare` validates the canonical archive in an isolated
runtime. It validates and forks the current project and all undo/redo boundaries,
collects their media dependencies, and removes machine-specific media bindings.
Imported projects receive fresh identities. A file path or authenticated URL in
an imported document never grants permission to read that location. Original
files are selected explicitly, with recorded hashes checked before publication.
Ambiguous filename/size matches require an explicit choice.

The importer also retains support for the earlier POCUT ZIP format. The old
format cannot recover metadata that its exporter never included.

Account credentials, provider authorization, paid-generation approvals and live
agent checkpoints are not portable project data. Import must not resume a
provider job or authorize a tool call. Director reference bytes are copied into
an authenticated project-scoped namespace while preserving their immutable IDs
and hashes. Imported shared assets receive fresh IDs, and references throughout
history are rewritten by the canonical runtime.

## Select a track's clips

The track sidebar includes an accessible **Select all clips** button. It is
unavailable for empty or locked tracks. A normal click replaces the selection
with that track's clips. Modifier-assisted selection can add clips from another
track. Selecting a different clip returns to ordinary clip-selection behavior.

`timeline.classic.selection.read` and `timeline.classic.selection.set` expose the
same `EditorDocument.selection` used by the UI and agent. Selection is transient
presentation state with its own revision; selecting clips does not add Undo
entries or make content dirty. The UI caches a stable projection for React
subscriptions rather than owning independent project state.

An exact whole-row selection limits linked editing to that row. Move, split,
trim and retime paths preserve this scope; ordinary linked clip selection keeps
its established behavior. Bulk property editing and deletion consume the same
explicit selected references. Undo and Redo remain canonical content operations.

## Verification

The configured `project-exchange-track-selection` check covers the client archive
format, ZIP parsing, media import boundaries, canonical selection and existing
command-manager behavior. Rust registry tests separately cover revision and
scope fences, dry runs, retry keys, exact-row edits, linked-peer isolation,
Undo/Redo and complete archive forking. Release QA also exercises the built
browser UI and the matching native session policy used by production storage.
