# POCUT production studio release — 10 November 2026

## Architecture and migration

This feature is bridged: canonical state, validation, revisions, undo and typed capabilities live in `crates/editor-api`; Classic's browser UI and authenticated provider adapters present and execute those contracts. The rewrite does not get a duplicate UI/state store. Production scripts, reference-slot versions and evidence reports use `project.extensions.productionStudio`; Director handoffs and chapter plans use the existing `generative` extension; ElevenLabs drafts use `audioProduction`. Classic archive version 6 preserves current and historical extensions. Versions 1–5 remain readable. Full, base-delta and chained-delta restoration validate all boundaries before adoption.

Agent settings use one scroll surface. Provider/MCP/knowledge sections start collapsed and can expand independently. Connect in Agent targets the same shared settings navigation. Native provider connections and their actual support/limitations are documented in [the connection research](../../docs/qa/pocut-native-connections-2026-11-10.md).

The production panel displays stable timed script rows and immutable revisions, original-language text plus parallel Latin pronunciation, image slots with replace-one/version/creative-approval semantics, and evidence-led video analyses. Plain-text imports mark estimated timing; SRT preserves explicit timing. The agent edits the same typed transactions that the UI uses. Handoff freezes source contents and approved image versions into Director instructions, preserving original dialogue and pronunciation separately. Presentation-only cards animate toward Director, respecting reduced motion. Preparing a request never starts paid work.

Chapter collections and batch/Seamless behavior are documented in [the Director contract](director-chapters-2026-11-10.md). Source timing and supported generated duration are displayed separately. Reference-mode generation preserves shared visual guidance, but only review of actual model output can establish visual continuity or speech accuracy.

## ElevenLabs

The Director has Video and Audio tabs. Audio supports speech, multi-speaker dialogue, sound effects and music. Its canonical draft contract validates limits, selected voice/model identifiers and source text. The agent can create/read drafts and prepare an immutable review request; there is no agent PIN, unlock or paid-approval capability. The user approves the exact frozen request with a PIN in the normal UI.

Keys remain encrypted in an account vault. The server only submits to fixed official ElevenLabs endpoints, streams a bounded MP3 response into account-owned storage, and serves authenticated results. Browser decoding and media import use existing editor paths. Generation claims and active worker leases are durable, scoped and bounded; concurrent approval cannot submit twice. Interrupted ambiguous submissions remain uncertain rather than retrying paid work. Limits reserve room for active output before dispatch. No automatic voice cloning is added.

Official endpoint references:

- [Text to speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Text to dialogue](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert)
- [Sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
- [Music composition](https://elevenlabs.io/docs/api-reference/music/compose)

## Verification boundaries

Automated provider tests use synthetic HTTP/process responses. No paid provider inference, user quota consumption, credential copying or automatic customer-device installation is included in verification. Native Codex's installed CLI was probed in a new empty profile without inference; authenticated customer login, entitlement and actual generation output remain device/provider checks. Source-video frames were decoded in real Chromium locally and compared at requested timestamps. Canonical tests exercise source/version conflicts, archive/reopen, undo/redo, exact source and transliteration preservation, batching and atomic cut insertion.

The release QA report is completed after production build and deployment below; this design document alone is not proof of deployment.
