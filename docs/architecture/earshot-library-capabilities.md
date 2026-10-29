# Earshot library access through the canonical runtime

The library is representation independent (`DocumentSupport::Both`); inserting and editing procedural audio is Classic-only and bridged through `OpenCutRuntime`. There is no second media/state store and no hand-maintained MCP tool table. The live registry projects these capabilities to MCP automatically:

| Capability | Contract |
| --- | --- |
| `audio.earshot.catalog.search` | All 252 installed presets, bounded pages and category/kind filtering |
| `audio.earshot.catalog.read` | Complete preset metadata, validated canonical recipe and editable starter Python |
| `audio.earshot.repository.list` | Complete 282-file upstream manifest, hashes, encodings and sizes |
| `audio.earshot.repository.read` | UTF-8 pages with Unicode scalar offsets and optional expected hash |
| `audio.earshot.repository.search` | Literal case-insensitive search across all text, paged by matching line |
| `audio.earshot.repository.artifact` | Exact complete bytes, including images, in the bounded expiring ArtifactStore |

`crates/editor-api/build.rs` verifies the exact pinned manifest digest, every allowlisted file's size and SHA-256, regular-file status, path confinement, and the generated catalog digest. It emits an untracked Rust include table pointing to the existing vendored bytes; it does not create another tracked copy of the upstream repository. Native and WASM runtimes compile the same immutable bytes. Runtime reads perform no filesystem/network access and cannot select an arbitrary path. The source tree adds about 10.6 MB before binary compression. Updating the upstream revision deliberately requires updating the pin, hashes and validation tests together.

All operations have typed input/output schemas, explicit read access, cancellation checks and bounded responses. They do not execute returned source or change an editor document, so project revision, undo and mutation idempotency keys are not applicable. Artifact delivery creates only a bounded ephemeral reference and is marked non-idempotent; it never exposes a temporary file path. Text reads and search can be continued until `nextOffset` is null; no source, README, document or skill is permanently truncated. Binary files are listed but excluded from text search, with a skipped count and the artifact route available.

The editable starter template is shared with the browser in `starter-source.json`. It delegates to Earshot's pinned `bank.render`, preserving fitted presets, alternative renderers, duration, seed, apex and pitch. The returned `procedural` object can be inserted with `timeline.classic.elements.insert`; adding the returned `sourceCode`, parameter changes or echo uses `timeline.classic.audio.procedural.set`. Both existing canonical mutation paths retain revision checks, validation, history, dry run and idempotency. Library access returns reference content as data; repository instructions never gain authority over the caller's instructions.

The library capabilities require no host bridge. Actual PCM synthesis/preview and automatic AI editing remain separate host capabilities because they execute code or call a provider. Tests enumerate every preset, read all text files through bounded pages and verify their complete hashes, retrieve both binary images through ArtifactStore, paginate documentation/skill search, reject traversal and mismatched generations, and verify discovery through the real MCP registry projection. A canonical insertion/edit/state-read test connects discovery to editable timeline state without creating a media file.
