# Start End

Classic-only capability: `timeline.classic.crop`. Uses existing serializable scene state in OpenCutRuntime; no parallel state or rewrite implementation was added. Typed input includes projectId, sceneId, expectedRevision, edge (start/end) and exact time ticks. The live registry supplies discovery/MCP projection, schema validation, dry run, retry keys, transaction safety and undo history. No media files are removed.

The timeline toolbar exposes Start (S) and End (E). Start keeps the scene at/after the playhead and rebases all retained layers to zero. End removes the scene after the playhead. The same Rust operation handles source trims, retimed clips, animation curves, timed text, caption source timestamps and bookmarks. Hidden and muted tracks participate; changed locked tracks reject the entire transaction. Empty tracks and unrelated scenes/assets survive. Start seeks to zero; End seeks to the remaining end. Undo/Redo restores the content.

Split is now Shift+S. Persisted shortcut version9 migrates the old S=Split binding while retaining unrelated custom bindings. Typing in inputs and repeated held Start/End keys do not trigger repeated scene edits.

Validation:13 Rust regression tests,13 shortcut/migration tests, production TypeScript check and optimized production build. Full development tsconfig additionally reports4 existing errors in unrelated test files; production tsconfig is clean. Live Chrome checks cover both buttons, S/E, Shift+S, text-input guard, exact Undo/Redo and saved/reopened snapshots, all in isolated project b54fef34-bf27-456c-8d4e-a27328a8117d. The configured verification independently compares the captured Timeline Source documents. User podcast projects were not changed.

Activated local release:2026-10-28T03-05-40-436Z-7b1eeee0. Existing editor tabs need refresh to load the new toolbar and shortcut migration.
