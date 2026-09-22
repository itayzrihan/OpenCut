# SHIRASHEMI eight-short edit

Requested 2026-09-21. Verified source folder: `G:\Copied_SHIRASHEMI\SHORTS`.
Files: Short1.mp4, Short 2.mp4, Short3.mp4 through Short8.mp4.

## Required workflow for each separate project

1. Vertical 9:16 and native Fill frame (crop), with no black letterboxing.
2. Native Remove Silences with default minimum pause 0.3 seconds.
3. Native Auto Texts: transcript, correction, row rearrangement, text transition arrangement. Verify successful completion of every stage.
4. Video below all text layers; verify visible text in preview.
5. Existing custom Assistant Bold font.
6. Existing black top/bottom cloud/feather effect from Effects, covering the whole final timeline.
7. Save and ask the user to review all eight before any export.

## Explicit future gates and reminders

- At the end of this task, remind the user to add face-based horizontal centering to both automation modes: after setting vertical framing and BEFORE Remove Silences, detect the approximate position of the person's face and shift the video/crop left or right so the face is horizontally centered. This is a requested future automation step, not a completed edit or a request to implement it immediately.
- Only after the user says the edit succeeded ("הצלחת"), implement `AUTO BASIC EDIT` for the accepted workflow.
- At review, remind the user to evaluate `AUTO TEXT IN OUT BY AI` and `AUTO ZOOMS ACCORDING TO SUBJECTS`.
- After both features work to the user's satisfaction, add the alternative `AUTO ZOOM AND TEXT TRANSITIONS EDIT` beside `AUTO BASIC EDIT`.
- Once this works, remind the user about Projects-page BATCH import: select multiple videos, choose either edit mode, create one project per source, process in the background, lock editing of processing projects while allowing live read-only viewing, and keep the rest of the app usable.
- Do not export or implement the gated buttons prematurely.

## Work log

- Model requirement clarified: use ivrit.ai Whisper large-v3. Original local ggml-large-v3.bin did NOT match the official ivrit.ai artifact; stopped its transcription before accepting any captions. Downloaded https://huggingface.co/ivrit-ai/whisper-large-v3-ggml/resolve/main/ggml-model.bin to `D:\dev\textcut-ai\whisper\models\ivrit-ai-large-v3\ggml-large-v3.bin`. Verified SHA256 `09e66ec67b2e00c6933afab6684cbf78fe023e8ad153c1848f62000e4335a07f` matches official Hugging Face LFS SHA256. Updated local .env.local model, whisper executable, and FFmpeg paths. AI login now works.
- Existing bridge was unavailable. Started the canonical Classic app on localhost:3001 (port 3000 belongs to another server); MCP bridge reports connected.
- First project: `6469738a-83af-4c4f-8a94-8371605139e8`, `SHIRASHEMI - Short1 - Basic Edit`.
- Native server-side file picker stalled. Imported Short1 via existing local-drive media.registerPaths and media.put API, using FFprobe metadata: 3840x2160, 30000/1001 fps (Classic rounds to 30), 41.508133 seconds, audio present. Original source preserved.
- Added clip through UI; applied 9:16 and Fill frame; ran 0.3-second Cut silences. UI reports final duration 00:00:34:02.
- Auto Texts redirected to OpenAI/Codex account selection. User approval requested for displayed account. Transcript, custom font, layering, effect, and visual QA are not yet complete.
- All eight projects created and media registered. No exports produced. No automation buttons implemented.
- Short2: `a4d201d8-b0d2-4a7d-993d-dd2a717a8c9c`; 9:16 Fill and 0.3s silence removal completed, duration 00:00:37:12.
- Short3: `90f95891-0692-47cd-bcae-2031d3f4c549`.
- Short4: `ff449d91-b998-4c65-9fd7-37879b3abb93`.
- Short5: `5fc52a35-1ac7-4ad4-8825-de3919f714e1`.
- Short6: `e6cc5ffc-75e6-47e0-a734-df0509dfe44d`.
- Short7: `ff79303a-b598-4c61-b290-587c04464b04`.
- Short8: `6ab51da9-67ec-42b7-978b-7d84c06ea15b`.

All eight now have native 9:16 Fill and completed native 0.3s silence removal. Persisted project reads confirm all canvases are 1080x1920. Timeline UI durations after cutting:

| Short | Timecode | FPS |
| --- | --- | --- |
| 1 | 00:00:34:02 | 30 |
| 2 | 00:00:37:12 | 30 |
| 3 | 00:00:34:08 | 30 |
| 4 | 00:00:31:22 | 30 |
| 5 | 00:00:33:00 | 30 |
| 6 | 00:00:16:29 | 30 |
| 7 | 00:00:30:07 | 50 |
| 8 | 00:00:35:08 | 50 |

Short8 screenshot verifies the portrait footage fills the vertical canvas at the start. Full visual/audio QA is still pending for all projects. All Auto Texts, text stacking, Assistant Bold, and black edge effect work remains pending. Resume after the user answers the account-selection question; do not equate these partially edited projects with completed deliverables.

Browser handoffs: Chrome tab 1698522180 is at OpenAI account selection; tab 1698522183 is Short8. Development launcher exec session 26707 runs Classic and the authenticated bridge. No scheduled reminder was created: the reminders above are gated on future review/acceptance events in this task.

## Current correction checkpoint (supersedes status above)

- User authenticated successfully. Official ivrit-ai/whisper-large-v3-ggml model installed and configured. SHA256: 09e66ec67b2e00c6933afab6684cbf78fe023e8ad153c1848f62000e4335a07f.
- User paused the edit series to fix excess caption tracks and explicitly requires **Rows = 1 before transcription**, including future automation.
- Root cause reproduced on Short1 after silence removal: whisper.cpp emits a zero-duration decoding attempt containing duplicate text and collapsed DTW times before its valid retry. The response excluded that segment but its word parser did not. The adapter now excludes it from words too. Valid zero-duration tokens inside a positive-duration segment remain supported.
- Classic-only maintenance fix; no rewrite capability or independent editor state added. The existing Whisper JSON transport parser was moved to a sibling module for regression testing. Caption allocation now reuses available overflow tracks; default caption rows is 1.
- Diagnostic on the real cut-audio JSON now gives 82 words in two caption tracks, one row, with distinct aligned word starts. Focused suites: 48 passing tests (transcription manager rerun with 30s hook timeout after a cold-import timeout).
- Short1 and Short2 had corrupted caption output; removed only their generated caption tracks through the editor's undoable Timeline Source transaction, preserving video/silence edits. Regeneration/verification in progress. Short3 transcription was stopped; Shorts4-8 have not been transcribed.
- Full Auto Texts correction/rearrangement/transitions, font, video stacking, edge effects and final review remain pending. No exports and no gated automation buttons created.

### Verified repair result

- Short1 and Short2 regenerated through native Generate transcript with the fixed official ivrit-ai large-v3 adapter. Both editor UIs show exactly Captions 1 and Captions 2 and Rows = 1. Short1 persisted 82 aligned words. The full Auto Texts stages must still run on these clean transcripts; their previous corrupted AI output was removed undoably.
- All five focused suites together pass: 48 tests, 153 assertions. Targeted ESLint and git diff whitespace checks pass.
- Editing remains paused at the user's correction checkpoint. Tabs: 1698522180 Short1; 1698522183 Short2; 1698522186 Short3. Keep the future automation/reminder requirements above.

## Completed edit / awaiting user review

- User resumed and asked to complete all eight. All eight are now saved and ready for review, without export.
- User clarified: use native Auto Texts including correction, row rearrangement and Apply & Arrange All Text; do not redundantly run those stages again after Auto Texts. Shorts3-8 used the full native Auto Texts button. Shorts1-2 already had clean transcripts and their remaining stages were completed separately. Short1's final transition arrangement control was disabled because its rebuilt captions have no overlaps (the native action is an overlap-only operation).
- All eight verified from persisted projects: 1080x1920; every video clip uses cover; Rows=1; exactly two caption tracks; all actual caption content is single-line; text above the full-duration black Editorial Edge Feather and video below both.
- Used the existing Custom Fonts entry **Assistant ExtraBold**, fontWeight bold. No exact Assistant Bold entry was present; this is the actual font name, not a claim that a separate Bold font exists.
- Checked rendered preview frames in all eight, including restored Short1 speech at 27s and Short4 CTA at 31.3s. Original-source ivrit-ai large-v3 diagnostic transcripts were compared against all eight edited transcripts.
- Corrected real transcript omissions: Short1 restored to 97 words; Short4 closing CTA restored (91 words total); Short8 rebuilt from the complete original-source transcript and mapped to the existing silence-cut timeline (90 words). These post-Auto Texts quality repairs use the editor's undoable Timeline Source transactions. Short8 semantic row boundaries were set during the repair and native Apply caption layout generated the two text tracks. No redundant AI correction was run on Shorts3-8.
- Fixed the Mameenet brand spelling in Shorts2/4, the open-legislation wording in Short4, and small spelling/linking-word errors. Split Short5's one automatic two-line wrap into two one-line captions.
- Word counts: 97,100,85,91,86,37,81,90. Final machine audit is in the temporary diagnostic directory; review handoff is SHIRASHEMI-EDIT-REVIEW.md.
- Actual native transcription dropouts on compressed/cut speech remain a reliability issue to address before making the future one-click automation trustworthy. The eight current projects were repaired; the earlier zero-duration-word adapter bug was fixed in code. Do not claim the general dropout issue is fixed.
- Future button and feature gates above remain unchanged; wait for explicit user success before implementing AUTO BASIC EDIT.
# Latest styling checkpoint — 2026-09-21

All 218 caption elements in all eight projects were updated through the undoable Timeline Source UI: centered x=0/y=0, bottomFadeOut=0.7, bottomFadeOutEndOpacity=0.2; punctuation hidden in displayed content and word runs while captionSource words remain intact. Source settings now hide punctuation and use the center grid cell. Persisted project audit found zero mismatches across all eight projects. Classic caption defaults and builder match these settings; active last-used caption controls were updated too. Future workflow and lessons: SHIRASHEMI-EDIT-WORKFLOW.md. No export or gated automation-button implementation.
