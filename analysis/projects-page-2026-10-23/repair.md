# Projects page render loop

The existing account signed in successfully, but `/projects` repeatedly failed after displaying the loading screen. Browser logs recorded React error 185: [maximum update depth exceeded](https://react.dev/errors/185). The HTTP server continued returning 200.

`ProjectManager.getSavedProjects()` filtered out hidden automation working copies by allocating a fresh array on every read. The projects page includes this list inside its external-store selector tuple. Shallow snapshot comparison therefore reported a change even without any store update, triggering React's render-loop protection. This was a regression in the scene automation library filter.

The manager now retains the filtered UI projection until the source metadata array changes. All metadata write paths replace that array. Actual refreshes, renames, insertion and deletion invalidate the projection; the existing filter for metadata marked as a working copy is preserved. This cache is a presentation adapter, not an independent editor state store. Canonical project documents and automation recipes are unchanged.

The regression uses the real project manager and the projects page selector shape: empty library reads, visible project plus hidden worker, 100 repeated snapshots without updates, metadata replacement and removal. Existing session lifecycle, scene automation, source roundtrip and selector tests also run in the configured `projects-page` check. That check compares every existing account project document hash before/after library navigation and verifies the deployed source fingerprint.

Production TypeScript is checked with `tsconfig.build.json`. The broader test-inclusive TypeScript configuration has existing errors in `canonical-unified-audio.test.ts` (lines 121–123); no unrelated test changes are included.

Live verification and browser screenshots are recorded alongside this document after deploying the tested release. No credential changes, account recreation or project migration are required.

The live library currently returns 16 entries, including existing AI working projects because their library metadata does not carry the working-copy flag from their project document. This pre-existing metadata projection issue is outside the page-crash repair; this change does not delete or migrate those entries.
