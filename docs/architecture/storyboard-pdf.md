# Client storyboard PDF

The Director exports a client proposal in the active browser or Electron editor.
No PDF rendering, image generation, cropping, or model inference runs on the server.
The host downloads only existing, authenticated image references belonging to the
active project; those files can already reside on the account server.

## Canonical contract

The optional `project.extensions.generative.storyboard` document contains the
proposal title, summary, sheet reference IDs, and ordered scenes. A scene has a
stable ID, title, client-facing description, optional paired start/end seconds,
and an optional explicitly owned image reference ID. Project validation rejects
unknown image bindings, invalid timing, duplicate IDs, and oversized copy.

- `project.generative.edit`, change `storyboard`: the existing typed mutation
  path supplies project/revision checks, registry idempotency, dry-run, atomic
  validation, and Undo/Redo. Setting `storyboard` to `null` restores the automatic
  projection from the directing brief.
- `project.generative.storyboard.plan`: a read-only canonical projection with a
  digest, project ID, and revision. If no explicit proposal exists, it includes
  existing storyboard sheets and every `direction.shots` description. It accepts
  JSON direction inside a Markdown code fence. It never exports the storyboard
  generation prompt, spoken script, credentials, provider IDs, cost, or debug
  fields. Unstructured direction text is not copied wholesale into a proposal.
- `project.generative.storyboard.export`: a cancellable, non-transactional
  host operation. Its only input is project ID and expected revision. Rust
  constructs the plan, sends it to `storyboardPdf`, and validates the resulting
  `application/pdf` ArtifactStore object, scope, digest, MIME, size, and signature
  before returning it. It is correctly marked Write/open-world because the host
  reads authenticated image bytes. Inspect the plan instead of using dry-run.

The UI, internal editing agent, and authenticated Classic MCP bridge all invoke
this same registry capability. There is no independent proposal store or custom
MCP tool. The editor agent can prepare proposal copy using the typed mutation,
inspect the plan, and export the same bounded artifact displayed as a download.

## Rendering and host support

| Host | Support |
| --- | --- |
| Active web editor | Local Canvas rendering, JPEG/PDF assembly, and download |
| Electron Classic editor | Same browser implementation and runtime contract |
| Internal editing agent | Same host adapter; returned PDF is attached to chat |
| Authenticated Classic MCP bridge | Same capability and bounded artifact transfer |
| Headless runtime without an editor host | Plan/edit supported; PDF execution needs a host |

The PDF has an A4 cover, one full page for each existing storyboard sheet, and
ordered scene pages. Explicit scene images use contain sizing and retain their
full frame. Long descriptions continue on additional pages. Missing per-scene
images do not require generation or manual crops: the full sheet remains in the
proposal. Browser text shaping provides Hebrew/Arabic RTL and mixed-language
paragraphs using the bundled Assistant typeface. Pages are rasterized at
1600 x 2263 pixels (about 194 dpi); PDF text is therefore not selectable/searchable.
This is an intentional visual-compatibility limit, not an accessibility-tagged PDF.

Limits: 8 sheets, 96 scenes, 120 pages, 15 MiB final PDF (below the existing MCP
16 MiB transfer budget), 16 MiB per downloaded image, and 24 million decoded image
pixels. Images load one at a time and are closed after use. Cancellation and
account/project/revision checks run around IO and page encoding; stale exports
are not published. No arbitrary image URL or output filesystem path is accepted.
UI and MCP downloads retain the normal ArtifactStore TTL and are evictable;
internal-agent chat exports are explicitly pinned for conversation persistence.

## Verification, 2026-11-10

- `cargo test -p opencut-editor-api --test generative_storyboard --test generative_host`:
  7 tests pass (also included in the 12-test Notes/review/Director combined run).
  Coverage includes legacy sheets/shots, no prompt leakage, canonical readback,
  Undo, dry-run, image ownership, timing, duplicate scenes, scope, cancellation,
  and rejection of mismatched artifacts/digests.
- `bun test src/generative/storyboard-pdf.test.ts src/generative/storyboard-pdf-browser.test.ts`:
  4 tests pass, 43 assertions. The browser suite uses the production host adapter
  and renderer, synthetic references, the bundled font, and a real Chromium
  browser. It checks long Hebrew descriptions/continuation pages, mixed-language
  paragraphs, full sheets, optional images, account/revision/cancellation rejection,
  and that the only API traffic is existing-image GETs.
- `bun test src/generative/storyboard-pdf-wasm.test.ts`: one passing real-WASM
  integration test (9 assertions, about 8 seconds) confirms typed proposal edits,
  canonical plan projection, registered host execution, exact ArtifactStore byte
  readback, temporary versus chat-pinned retention, and no document revision change while exporting.
- Synthetic QA document: `/private/tmp/pocut-storyboard-qa/client-proposal-hebrew.pdf`.
  Poppler reports 5 A4 pages, no JavaScript, no encryption, and approximately
  1.1 MiB. Strict pypdf parsing confirms one embedded image per page and no
  annotations or open action. All five rendered pages were visually inspected;
  no clipping, lost images, or reversed Hebrew. Mixed-paragraph punctuation was
  corrected after the first visual pass.

To regenerate the visual fixture without paid calls or customer project data:

```sh
cd classic/apps/web
POCUT_STORYBOARD_QA_DIR=/private/tmp/pocut-storyboard-qa bun test src/generative/storyboard-pdf-browser.test.ts
pdftoppm -scale-to 1200 -png /private/tmp/pocut-storyboard-qa/client-proposal-hebrew.pdf /private/tmp/pocut-storyboard-qa/page
```

The standalone browser fixture is exported from
`src/generative/storyboard-pdf-browser-fixture.ts` as `runPdfFixture`. The fixture
does not depend on a real account, project, provider, paid generation, or production
deployment. Production deployment and manual editor-shell QA are separate checks.
