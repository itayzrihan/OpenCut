# Hebrew punctuation beside a year

The open project is `החזר 2020`, scene `חלון ההחזר לשנת 2020 · full-auto` (42.73 seconds). Its manual question is stored correctly as `למה דווקא 2020?`, with `captionWordDirection: auto` and three timed word runs. The source text and timings do not require rewriting.

The row was already detected as RTL. The renderer, however, resolved each word independently. The numeric token `2020?` has no strong letter, so its standalone canvas direction defaulted to LTR. Its neutral punctuation consequently appeared on the wrong side. Plain text drawing also inherited canvas direction, and the inspector textarea lacked `dir=auto`.

Direction policy now lives in shared Rust `timeline::resolve_text_direction`, using Unicode bidi character classes. First strong text selects RTL/LTR; weak or neutral tokens inherit the row's direction. Explicit caption/row/word directions remain respected. Canvas fill and outline for plain text resolve each line explicitly. The text inspector uses the browser's automatic direction. This applies to existing stored `auto` captions on reload; no project-wide caption migration or duplicate state store is introduced.

Migration status: bridged Classic text rendering with shared pure Rust policy, no new stored state or editor action. The rewrite can reuse the same Rust policy; no duplicate rewrite UI was added.

Regression checks include Hebrew/Arabic text, English-first mixed text, numeric punctuation, parentheses/ranges, direction marks, explicit overrides, canvas fill/outline, responsive wrapping and caption creation. Existing Full Auto routed-input, checkpoint/resume, batch queue, scene isolation, music metadata and canonical update/Undo tests are also run (95 total). Production types/build and deployed preview are checked. Three native automation intents in this project are published; two historical October 20 queue failures remain history rather than being silently re-enqueued or erased.

`verification.json` records the release, native preview artifact and final export. The original nine scenes, their captions/audio/timings and project settings are compared exactly with the saved baseline. Export retains the user's existing source-resolution/compact HEVC preferences; output is 1216×2160 at 25 fps with audio. The MP4 is decoded fully, its question frame reviewed, and its audio checked for a non-silent signal. This is bounded regression coverage, not a guarantee against every possible future crash.
