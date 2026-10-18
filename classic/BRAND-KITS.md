# Brand Kits

Account-owned Brand Kits are available at `/brand-kits`, from Projects, account settings, and the workspace navigation. Users can create, edit, duplicate and delete multiple client kits. Kits contain a logo from the account sticker library, primary/secondary/background colors, style notes, phrases, heading/body fonts, and music/SFX selections. Uploads reuse the account's existing asset and font storage. Kit deletion retains shared files and already-created videos.

Brand selection is optional in single-project and batch **Full Auto Edit**. Extraction/Smart Takes do not apply a kit. The authenticated queue host resolves the chosen ID, discards caller-supplied kit snapshots and stores the full recipe. Resume retains that snapshot even if the saved kit changes or is deleted. A changed account or missing required file stops the worker before branding.

The final undoable edit changes text palette/fonts, the shared project canvas background, adds an editable logo overlay and the first brand phrase as a closing overlay for up to 2.5 seconds, and replaces generated transition/word SFX with measured selected sounds. It keeps speech, captions' transcript, and source cut timing. Automatic Music uses only the kit's selected music when choices are present; a too-short track is skipped according to the existing music policy. Music/SFX are only used by enabled finishing steps. Brand style notes and phrases are quoted as untrusted creative reference in optional planning requests, not as system instructions or spoken transcript.

The canvas background is a project setting shared by its scenes. Text/logo/phrase and SFX changes target the selected scene. Reapplying replaces owned Brand Kit overlays instead of duplicating them. Brand fonts are copied into project font storage for reopening/export; logo/sound references use existing archive dependency support.

## Architecture / migration contract

- **Bridged:** shared account BrandKit model/validation in `crates/account-core`, serialized at `EditorDocument.account.brandKits`; canonical `account.brand_kits.edit` and destructive `account.brand_kits.remove` capabilities in `crates/editor-api`. Typed schemas, optimistic revisions, cancellation checks, dry run, idempotency, transactions and undo use the existing registry/runtime. MCP projection is automatic; no duplicate MCP tool or independent UI state store.
- **Classic-only:** `/brand-kits` management UI and Full Auto host orchestration. `timeline.classic.brand_kit.apply` declares Classic document support and applies the frozen snapshot through the canonical command manager. No rewrite UI parity is claimed or removed.
- Host I/O adapter: authenticated, account-scoped `brand-kits/library.json` contains serialized canonical runtime/history. Per-account queues, cross-process file locks, private atomic writes and a durable last-request receipt prevent lost-response duplication and stale-tab overwrites. No external path is exposed to the editor agent.

Validation: `node .dip/tools/verify-brand-kits.mjs` after `cd classic && bun run build:wasm`. The check runs registry/read-back, account-isolation/persistence, frozen-queue, Full Auto workflow regressions and TypeScript checks. Full paid transcription/music generation is not part of local verification.
