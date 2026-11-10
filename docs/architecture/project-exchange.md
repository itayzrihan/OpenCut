# Portable POCUT projects

The editor project menu exports either a complete `.opencut.zip` package or a
`.pocut.xml` metadata document. The project library and editor menu import both,
and continue to recognize the previous ZIP format.

POCUT XML is an application-specific, lossless **editing metadata** format. It is
not Premiere XML, FCPXML, or an interchange promise to another editor. Its strict
XML envelope contains the canonical JSON archive. It preserves timeline edits,
source code, current project extensions, production scripts and reference
versions, public Agent conversation, and complete supported undo/redo history.
Original media, Director reference files, custom fonts, shared audio/stickers and
Agent artifact bytes are separate dependencies. XML contains their descriptors
and known SHA-256 hashes; ZIP contains those files as well. Derived thumbnails
are omitted from XML and may be regenerated. Historic raw binary tool arguments
are omitted from XML public activities and listed in `omittedBinaryFields`.

Public conversation is task history, not executable provider authority. Import
validates it with Rust's `conversationRestore`, which pauses an active round.
Provider checkpoints, credential/session state and pending external tool
authority are never restored. Existing unavailable-artifact markers are retained
and their count is displayed; a package cannot recover bytes already evicted
before export.

## Canonical ownership

`project.classic.exchange.prepare` is a registered read capability in
`crates/editor-api`. It validates an input archive and every history boundary in
an isolated `OpenCutRuntime`, then exposes a full normalized archive and the
union of current/history media and Director references. It does not change the
open editor or perform filesystem/network IO. UI export captures the atomic
editing session and media handles together before asynchronous file reads.

On import, the same capability forks current and historical documents to a fresh
project identity through the existing canonical session attachment validator.
It removes machine paths, URLs and old binding authority from every media
boundary. Shared asset ID mappings are applied only to typed shared audio/sticker
references across the full history. Director file IDs remain unchanged in a
separate project-scoped imported namespace. Existing source files and projects
are not overwritten.

A single media ID with conflicting size, original path, SHA, modification time
or binding revision across its history is rejected for portable export. The
current source must not silently replace a different historical original.
Unified-angle virtual assets retain their metadata and their underlying files
are carried through the ordinary media manifest.

The browser validates the full bundle and checksums before publishing files.
It commits an atomic `EditorSessionBundle` through the existing fenced session
client, including canonical archive, public conversation and bounded artifacts.
Definite pre-commit failures remove only the newly allocated project. An
uncertain commit is reconciled using the same request identity; an unresolved
outcome preserves its potentially durable data.

## Import review and local processing

XML import lists required files before creating a project. Unique filename and
size matches are suggestions; duplicate candidates require a row-specific user
choice. Recorded hashes are checked with streaming SHA-256. All required files
must be resolved before import. Generated references and artifacts are included
in this review, so missing generated assets cannot silently create a broken
project. File selection never grants access to a path embedded in the XML.

XML parsing, archive validation, hashing and ZIP construction run in the client.
The XML grammar does not use a general XML parser: DTDs, external/custom entities,
CDATA, extra markup and unsupported formats are rejected. The final escaped XML
has a 120 MB bound. ZIP32 size limits remain explicit. ZIP reads validate bounded
directory/header ranges, duplicate paths, overlaps, sizes and CRC; stored entries
use Blob slices, and decompression has a declared-size and aggregate bound.

Existing account-scoped storage adapters own selected media/font files. Director
reference imports use the authenticated, checksum-verified immutable file import
endpoint; shared imports allocate fresh IDs. Provider generation is never
triggered by importing a project.

## Verification

- Rust `classic_exchange`: complete current/history fork, source immutability,
  registry reads, source-language preservation, Undo/Redo, invalid history,
  stale revision/scope and conflicting media bindings.
- Actual compiled browser WASM `exchange-wasm.test.ts`: XML omission of bytes,
  required original selection before writes, atomic persisted reopen of script,
  history, paused conversation and artifact bytes; linked-media ZIP and malformed
  descriptor rejection; acquisition failure and cancellation cleanup.
- `exchange-format.test.ts`: multilingual escaping, unsupported XML/entity
  rejection, duplicate identities, explicit relink checksums, ambiguous filenames
  and streaming cancellation.
- ZIP, shared-assets and Director archive-reference suites cover bounded binary
  transport, exact scoped identity preservation, ownership and immutable retry
  checks.

Both browser and Electron use the same canonical capabilities and transport
format. Their file-storage adapters remain host-specific.
