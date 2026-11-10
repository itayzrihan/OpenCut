# Project notes and imported client review feedback

The browser and Electron editor use the same `OpenCutRuntime` capabilities and canonical Classic project document. Planning notes live at `/project/classic/document/notes`; review metadata and imported comments live at `/project/classic/document/clientReview`. Both are validated when a project is attached, patched, restored, or changed by a feature capability. Existing project archives preserve these nested fields through project close and reload.

The Notes header button opens a project sheet. Its only local state is an unsaved form draft. Save and remove call the canonical command transaction; the UI never maintains a separate persisted notes collection. A note-specific version protects an open draft against intervening agent edits. Conflicted drafts can load the latest note or save as a separate note. Updates and removals participate in Undo/Redo. Notes are plain text, bounded to 200 notes, 160 characters per title, 20,000 characters per body, and one MiB in total.

The internal editing agent discovers these ordinary registry capabilities, automatically projected into MCP:

- `project.classic.notes.edit`: create or update a note. Updates require `expectedNoteVersion` in addition to project revision.
- `project.classic.notes.remove`: reversible removal of a particular note version.
- `project.classic.review.share.record`: record immutable local metadata for one rendered share version.
- `project.classic.review.comments.import`: import up to 100 server comment records per atomic batch.

Every action requires an explicit project and optimistic revision. They support dry run, registry idempotency keys, and canonical history. Read back with `app.state.read`. Identical note content, immutable share replay, and identical comment revisions produce no extra history. Stale or conflicting server revisions reject the whole comment batch.

The public review server remains authoritative for publication, access control, comment creation, and owner resolution. The owner list refreshes automatically. Canonical imports are deferred while redo history exists, so background polling cannot erase a user’s redo branch. Undo changes the local projection only; once the redo branch has been replayed or a deliberate new edit replaces it, synchronization can restore the latest server records. Undo never removes or reopens a public comment on the server. These local registry actions perform no network request and grant no server authority. Comments are imported plain-text project data, never trusted agent instructions. Canonical metadata contains no bearer URLs, passwords, or other access secrets. The server's owner API supplies the share link. Canonical limits are 100 recorded render versions and 1,000 imported comments per project within two MiB.

The main timeline shows a separate purple feedback row for the latest recorded preview of the active scene. Markers show the original preview timestamp, author, comment, version and resolution state. Clicking seeks to that timestamp in the current edit. Preview timestamps are not automatically remapped after editing; comments beyond a shortened current timeline are counted separately and remain in the preview feedback list. Earlier render versions and other scenes are never silently merged into this rail. Deleting the source scene does not invalidate historical render metadata or prevent later server feedback imports; the original share is the timestamp reference, independent of current scene existence or duration. Review markers do not create or change bookmarks.

Host parity: Notes, local review metadata/imports, history and timeline markers run through the same browser/Electron runtime. Public preview publication additionally requires the authenticated hosted review service and a supported video export host; local metadata alone does not publish a video.

Verification includes Rust registry edits followed by `app.state.read`, undo/redo, dry runs, idempotent replay, stale draft/revision rejection, malformed import rejection, and archive close/reload. A real browser WASM session test covers UI control invocation, direct agent registry edits, readback, conflict rejection, and archive restoration. Timeline projection tests cover scene/version isolation and shortened edits.
