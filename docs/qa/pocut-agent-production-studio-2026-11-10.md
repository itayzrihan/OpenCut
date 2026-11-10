# Agent production studio release QA — 2026-11-10

## Scope

Production worktree: `/private/tmp/pocut-client-review-ai`, canonical `itayzrihan/OpenCut`.
The initial integrated release is `77bf8fd6e`; a follow-up completes native image
artifact import and corrects React external-store snapshot stability found in browser QA.

## Automated evidence

- Configured integrated check: `.local/agent-production-studio/configured/summary.json`.
- Canonical editor/projector suite: 82 passing tests,
  `.local/agent-production-studio/projector/summary.json`.
- Artifact import, host, production and storyboard: 17 passing Rust tests.
- Follow-up actual compiled WASM: two production tests, 16 assertions,
  `.local/agent-production-studio/artifact-import-wasm/summary.json`.
- Handoff external-store regression: five tests including snapshot stability across
  repeatedly decoded saved handoffs, Undo, project and reference changes.
- TypeScript build, runtime export verification and production Next build are required
  before packaging; candidate Linux release is verified before atomic cutover.

## Browser walkthrough

Disposable local account `pocut-feature-qa`; dedicated project
`cd114147-9f74-4b9a-91b7-848a036aaba7`. No customer project was modified.

Verified:
- Collapsed settings, shared Connect in Agent navigation and one outer settings
  scroll container without an independently scrolling Skills panel.
- Hebrew two-row SRT import retaining exact 0–4s and 4–8s timestamps.
- Separate Latin transliteration and planned visual fields, append-only row versions,
  old version preview, restore-as-new-version and Undo.
- Two image reference slots, local file upload, per-version approval, replacement
  of Presenter only while Studio remains approved and unchanged.

The walkthrough caught a reproducible React185 crash immediately after handoff,
including reload of the saved project. The cause was fresh nested handoff objects
inside a shallow external-store snapshot. A related saved-audio-draft selector was
found during the follow-up audit. Both were fixed with stable snapshot regressions. The rebuilt production bundle
passed the repeat walkthrough: the existing project reopens; a second handoff
shows its success notification, exact Hebrew/Latin text, two timed shot descriptions
and the two selected approved reference IDs. The Audio tab saves a sound-effect
draft, prepares an exact review without contacting ElevenLabs, cancels it, then
reloads the project with the saved draft and cancelled job intact.

The final Next production build, TypeScript build configuration, runtime export
verification and compiled HTTP smoke checks passed. The HTTP smoke covers
anonymous isolation, CSRF, exact audio prepare/replay, PIN gate, cancellation,
authenticated MCP adapter and downloadable companion hash.

## Provider verification limits

No real provider login, paid inference or customer media generation was performed.
Native Codex/Claude connections need the user-installed paired localhost companion
and the provider's official login. Video, image and audio provider responses are
covered with controlled fixtures; provider quota, output quality and real account
entitlement remain manual verification limits.
