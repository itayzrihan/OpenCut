# Pinned HyperFrames reference library

The catalog captures 394 official upstream entries at commit
`4c4b8574406cc566d28778a13f22c072d727a871`. The prepared library contains
150 reviewed, offline-renderable packages: 50 blocks and 100 components.
Component packages include their upstream demonstration composition; they are
not silently treated as standalone snippets. Three visually rejected demos
remain available as raw references, with reasons in `review-exclusions.json`.

`certification.json` records the exact verification scope and limitations.
For each prepared package it binds the source, three sampled local frames,
deterministic seek/import/reopen evidence and a source-based reconstructed
prompt. Prompts are explicitly labelled **שוחזר על ידי OpenCut**. Four original
upstream prompts are preserved unchanged elsewhere in the captured catalog.
Popularity is unknown; the library does not invent a popularity ranking.

Verification is for the pinned reference package. It is not a guarantee about
every frame, generated prompt output or subsequent remix. Nineteen packages
have transparency in the sampled frames; others include a background. The
shared compositor has separate actual video-export evidence covering a native
video underlay, a standalone interval and timed HyperFrames source audio.

## Architecture and migration status

- **Bridged:** search, metadata and bounded source reads live in the canonical
  Rust capability registry. UI, agent and MCP use the same contracts. Source
  pagination verifies the complete file digest and uses Unicode scalar offsets.
- **Classic host integration:** authenticated Next IO serves only pinned bundle
  files for an owned project. The dedicated project examples page and assets dialog use those capabilities,
  displays local preview frames, prepares a remix chat draft and imports via
  the existing canonical import journal. Account/project/scene changes cancel
  an in-progress import before commit.
- **Existing canonical editing:** imports, source edits, timeline layers, undo,
  persistence and reopen remain under `OpenCutRuntime`. The library introduces
  no separate project store or agent-only mutation implementation.
- **Semantic retrieval:** the optional authenticated embedding host loads the
  pinned CPU/q8 `Xenova/bge-small-en-v1.5` model and compares normalized vectors
  with the pinned local example index. Rust validates the model, dimensions and
  index digest and owns ranking. A live CPU/WASM retrieval run is recorded in
  `.local/hyperframes-semantic-live/report.json`. Weighted keyword search with
  Hebrew aliases remains an explicit fallback; results report their search mode.
  Capability guidance asks the agent to interpret intent and translate visual
  concepts before embedding. The live run covers retrieval, not remix quality.
- **Release limits:** standalone server packaging/account tests do not prove
  the complete Electron shell or a deployed HTTPS SaaS installation.

## Reproduce or refresh

Run scripts from the repository root unless specified otherwise. Preserve
`upstream/` and `vendor/` byte-for-byte; `.gitattributes` disables line-ending
conversion for captured/prepared sources.

1. `node scripts/hyperframes/audit.mjs --acceptance` checks source, dependencies,
   licenses, prompts, local evidence and certification thresholds. The command
   fails when only raw captures or technical candidates exist.
2. In `classic/`, run `scripts/test-web.mjs` against
   `src/hyperframes/__tests__/examples-batch.test.ts` with
   `OPENCUT_HYPERFRAMES_BATCH_TEST=1` and
   `OPENCUT_HYPERFRAMES_BATCH_LIMIT=150`. To resume the same pinned generation,
   also set `OPENCUT_HYPERFRAMES_BATCH_RESUME=1`. The runner refuses changed
   evidence and excludes missing dependencies, external requests, bad seeks
   and explicit review rejections.
3. Generate contact sheets with `node scripts/hyperframes/review-sheets.mjs`.
   Review source and all three frames before authoring or changing an entry in
   `reconstructed-prompts.json`. Record unsuitable demos in the exclusions file.
4. Run `prepare-library.mjs` and `apply-reviewed-prompts.mjs` in
   `scripts/hyperframes/`. Regeneration clears prior verification labels.
5. Run `examples-export-browser.test.ts` with
   `OPENCUT_HYPERFRAMES_EXPORT_TEST=1`. Pass its successful evidence directory to
   `node scripts/hyperframes/certify-library.mjs <evidence-directory>`.
   This refuses fewer than 150 reviewed packages, fewer than 50 of either kind,
   missing technical evidence or missing mixed video/audio export evidence.
6. Rebuild canonical WASM after catalog changes. Run
   `classic/scripts/write-wasm-manifests.mjs` and verify exports, then prepare
   application resources with `classic/scripts/prepare-hyperframes-references.mjs`.
   Production builds include the pinned bundle and content-addressed previews.
7. `node scripts/hyperframes/check-packaged.mjs <Next-build-directory>` validates
   the assembled standalone bundle and previews, then exercises source access
   with two isolated local accounts. It never uses an existing user's account.

`node --test scripts/hyperframes/audit.test.mjs` checks that source, prompt and
certification corruption cannot keep a passing acceptance result.

Upstream and third-party license captures accompany each prepared package;
GSAP and Google Fonts retain their own terms.
