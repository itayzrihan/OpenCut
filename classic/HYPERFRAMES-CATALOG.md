# Unified catalog in Classic OpenCut

The Classic editor's **Catalog** tab (`?view=catalog`; `?view=examples` remains
compatible) contains 454 unique identities: the original 394 pinned OpenCut
references and 60 additions from official HyperFrames commit
`83b6419e975548f54cbe4a771f3ac00b04915757`. Existing prepared packages, reviewed
prompts and original file hashes are preserved. Each item's source URL identifies
its own revision; the API's `upstreamCommit` token identifies the latest unified
catalog generation, not a claim that the older entries were rewritten.

Hover or keyboard focus starts one debounced, silent source preview in the preview
pane. Click retains the preview and opens prompts, source inspection and existing
prepared-package import. No preview MP4, encoder, FFmpeg, render job or project
mutation is needed. Leaving a transient preview or closing the tab releases its
isolated host lease. Prompt copy preserves original/reconstructed provenance;
items without authored prompts get a clearly labelled metadata-based usage prompt.

## Architecture and migration contract

Classic-only UI; shared canonical discovery/read/preview-plan capabilities in
`crates/editor-api`. `hyperframes.examples.preview.plan` selects immutable source,
entry, hashes, bounds and dimensions. Authenticated host IO verifies every file,
uses package-only loopback origins and sandboxed iframes, and bounds active leases
and concurrent preparations. There is no additional editable document or library
store. Tests read canonical state before and after catalog operations.

Catalog previews use the verbatim MIT HyperFrames 0.8.146 runtime, with its artifact
hash recorded under `src/hyperframes/vendor`. The existing editing/rendering
runtime stays at 0.8.115. This is a catalog adapter, not a migration of the entire
editor or a claim of full compatibility for every effect.

The original upstream Studio card design uses poster/video previews. OpenCut uses
the requested live HTML instead. Optional poster thumbnails are only idle card
art; rendered preview videos and old sampled-render strips are not played.

## Source limitations

All 454 identities have an HTML/demo entry. This does not certify all 454 sources:
150 retained OpenCut packages have previous offline/import verification. 28 older
upstream entries declare missing media (including carousel photos and avatar
videos). Such entries remain discoverable and carry a partial-preview warning;
unavailable dependencies/runtime failures are reported, not replaced by rendered
video. Unprepared sources can request HTTPS assets and need network availability.
GPU effects need browser GPU support. Full visual certification of every source is
separate from catalog coverage and this feature's interaction tests.

## Reproducibility and validation

- `scripts/hyperframes/supplement.py <official archive> <exact commit>` captures
  only missing identities, including source assets and license attribution.
- `node scripts/hyperframes/audit-supplement.mjs` verifies all 218 new source
  files and complete official identity coverage. The existing source audit still
  validates the original 394 entries and 150 reviewed packages.
- Production reference preparation runs both audits and packages both snapshots.
- Rust registry tests cover union coverage, preserved prompts/packages, invalid
  identities/generations and unchanged canonical state.
- Browser tests cover page/dialog search, source inspection, live clock advance,
  no video element, unchanged project and preview release on close.
- IO tests cover source tampering, bounded reads and path confinement.

Do not confuse the isolated read-only QA host with a production deployment.
