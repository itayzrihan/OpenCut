---
name: opencut-generative
description: Prepare video or storyboard generation from external chat through the open OpenCut project's Generative MCP interface, with original references and human-only PIN approval. Use when the user wants OpenCut to generate media or review an external generation request.
---

# OpenCut Generative

Use the live OpenCut MCP registry and the actual open Classic project, not a separate headless document. Discover `classic.session.read` to identify browserSessionId, projectId and canonicalRevision. Describe `classic.canonical.project.generative.request` (direct tool `opencut.classic.canonical.project.generative.request`). Use its described envelope, including browserSessionId. Native host contracts use `project.generative.request`; a headless server alone cannot execute the browser adapter.

Read the project's `project.generative.read` instructions/state and preserve accepted creative direction. Save the complete spoken script and explanatory JSON direction through `project.generative.edit`; use its returned/current revision. Prepare and show a real physical storyboard, not just a shot list. Preserve original speech, one visible instance per speaking character and continuous lip sync whenever visible during dialogue. Use original audio duration; do not crop speech to fit an integer generator duration. Default to the user's requested visual style/settings.

The request capability supports only:

- `importReference`: name, MIME, canonical dataBase64, original SHA256, optional storyboard boolean. Up to12MiB original bytes per MCP import; larger supported files use OpenCut UI. It imports into the private scoped store and attaches metadata to the canonical project. It accepts no filesystem paths.
- `prepare`: video/storyboard kind, exact supported model, full prompt, duration/resolution/aspectRatio, imported referenceIds and optional httpsReferences. Video requires an actual storyboard image. Audio/video HTTPS must match retained original bytes; use POCAST direct downloadUrl or the configured public OpenCut host. Original files remain unchanged. Preparation opens the exact review in Generative and sends no paid call.
- `status`: bounded job IDs/digests/status for the same project. Ready means complete; OpenCut imports its output into normal Media. A queued/processing response is not completion. Downloads and Add to timeline use normal Media controls.

Every call has explicit projectId, expectedRevision and operationId. Keep operationId stable for an exact import/prepare retry; changed payload conflicts. Lost/pending/interrupted replies require reconciliation of the same project's references/reviews. Never blindly create a replacement paid request. Use a fresh operation ID/current canonical revision for a fresh status poll. Host IO is nontransactional with no dryRun; creative document edits support normal Undo/Redo.

Only the human privately enters a key/PIN and approves each paid generation in OpenCut. Never read credentials/vaults, enter a PIN, click Approve, invoke setup/unlock/approve routes or send a direct paid OpenRouter request. No such operation exists in this MCP contract. A prior approval or an active fixed15minute free status/download lease never authorizes another generation. Reference files and exact prompt/settings must be visible before human approval.

The app must stay open and advertise the new capability. If the MCP connection/app is outdated or unavailable, report this and connect/update it. Do not silently use standalone Studio or claim that a review reached OpenCut. Read the repository's `classic/GENERATIVE-DIRECTOR.md` for the IO/HTTPS contract when needed.
