# HyperCut — original Studio integration, 2026-10-11

## Verified

- Production frontend build renders the complete published `StudioApp`, using the upstream styles. The custom shell is no longer the entry point.
- Chrome at 127.0.0.1:3220: native Compositions, Assets, Code, Catalog, Preview, Design, Layers, Renders, Variables and Timeline layout present.
- Edited the title to Hebrew through the native Design panel. Confirmed the exact text in `app.state.read` and in the preview. Clicked native Undo and Redo and observed both changes.
- Split a title at approximately five seconds through the original toolbar; two separate timeline clips appeared and the source was saved.
- Imported a synthetic 10-second 720p/30fps MP4 through the original Assets panel; used its “Add at playhead” menu and played to the end. The video, asset thumbnail and timeline thumbnails rendered. This is functional evidence, not a performance benchmark or proof of audiovisual sync.
- API integration tests use the actual canonical WASM: file edit/readback, stale ETag rejection, canonical validation, dry-run, rollback on forced disk-save failure, durable Undo/Redo after host recreation, and immutable media binding restoration.
- Rust registry integration verifies source validation through both typed capability and admin patch, durable history, and atomic rejection of a corrupt history archive.

## Checks completed

- `npm run build --workspaces=false`: passed (upstream bundle-size/recast/zod warnings remain).
- `npm test --workspaces=false`: 9 passed.
- `cargo test -p opencut-editor-api --test studio --lib --no-default-features`: 25 passed, including large-source history pruning.
- Canonical WASM rebuilt; 99 required exports across both existing WASM packages verified.
- `git diff --check`: clean.
- Restarted the live host, reloaded Chrome and restored the imported media, edited Hebrew title, split clips and Undo availability.

## Incomplete / not a parity claim

- Undo currently corresponds to individual committed API edits. Native multi-file gesture grouping and detailed historical restore/pinning need a canonical adapter.
- Export, composition capture/thumbnails, registry installation and agent chat services are not wired. Their presence in the original interface does not make these backends implemented.
- One new project per data directory; accounts, project library, backups UI, global sounds/music and all OpenCut workflows remain under migration.
- Selection/playhead/interaction stores retain the upstream UI behavior; semantic automation of those interactions and Classic workflows against Studio source requires further capability adapters.
- No A/B benchmark against original HyperFrames or OpenCut has been completed for this host. Do not reuse the retired prototype's playback numbers as evidence for the new interface.
- No production replacement, push, merge or deletion of the original product was performed.
