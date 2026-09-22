# Local subject framing

Classic-only; uses the existing canonical EditorCore / CommandManager source transaction. OpenCV + MediaPipe Pose run locally in an isolated Python environment. No LLM, OAuth, cloud inference or upload to an AI provider is used for framing. Python only runs the fixed face classifier and CPU pose model; Rust owns score gates, temporal consistency, subject ambiguity, crop math and document changes.

Both Full Auto Edit's framing stage and the standalone **Center Subject Horizontally** button call `runLocalSubjectFraming`. Full Auto first sets vertical cover; the standalone button centers existing 1080x1920 cover video without changing other transforms, cuts, captions, zooms, sounds or settings. Unsupported rotated/scaled/retimed/keyframed main clips stop without applying.

Five uncropped frames are sampled across each source media's used interval. Silence-cut fragments of the same source share one crop so they do not jump horizontally at cuts. The local Haar classifier produces rectangles and stage weights (not probabilities). Rust requires one consistent face in at least three frames and a strict majority; isolated false detections are ignored. Multiple persistent face tracks, inadequate evidence or excessive observed movement stop for review. MediaPipe Pose Lite supplies nose, shoulder and hip landmarks. Rust requires visible/present nose and shoulders (>=0.7), face/nose association, plausible shoulder geometry and bounded face/torso distance. Visible hips refine shoulder center; hidden hips do not prevent seated-person framing. A confidently associated upper body contributes 20% to the horizontal center; without reliable torso evidence, the observed face alone is used. A body detection is never fabricated. The median crop is clamped to cover bounds.

This is a stable sampled crop, not continuous subject tracking or an identity recognizer. It can miss people/motion between samples. The classic detector is conservative and may reject profiles or obscured faces; such cases require review, not a silent cloud fallback.

## Runtime

Installed once with `python classic/scripts/local-subject-framing/setup.py`, using pinned OpenCV 4.12.0.88 NumPy 2.2.6 and MediaPipe 0.10.35 inside ignored `classic/.local/subject-framing`. Setup downloads the official version-1 Pose Lite task once and verifies SHA-256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`. The local backend serves a bounded same-origin loopback-only inference endpoint accepting image data, not caller-chosen filesystem paths or commands. The worker is fixed, cancellable, timeout-limited and cleans temporary inputs/outputs. Other deployments must run the setup before using this feature; no dependencies are silently downloaded during editing.

References: [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/python), [OpenCV CascadeClassifier](https://docs.opencv.org/4.5.5/d1/de5/classcv_1_1CascadeClassifier.html).

## Validation

99 native timeline tests passed, including overlapping-face rectangle suppression, temporal false-positive rejection, persistent multiple subjects, insufficient evidence, movement, optional torso association, and preserving every document field except horizontal position in standalone mode. Scoped ESLint passed; existing workspace TypeScript failures are unrelated to these files. WASM export verification and live application results are recorded below.


## Application verification — 2026-09-22

All eight original SHIRASHEMI projects were processed through the visible Center Subject Horizontally button and saved by the editor. The local worker reported matched body evidence in every accepted face sample:

| Short | Clips | Accepted face/body samples | Applied X (1080x1920 canvas pixels) |
| --- | ---: | ---: | ---: |
| 1 | 15 | 5 / 5 | +19.341 |
| 2 | 14 | 4 / 4 | +9.193 |
| 3 | 14 | 5 / 5 | +23.791 |
| 4 | 15 | 5 / 5 | +76.326 |
| 5 | 11 | 4 / 4 | +20.828 |
| 6 | 10 | 5 / 5 | +21.240 |
| 7 | 7 | 5 / 5 | -36.313 |
| 8 | 14 | 3 / 3 | -80.896 |

A recursive read-only comparison with pre-operation project snapshots found only main-video `params.transform.positionX` and save metadata changes: all 100 clips changed, no caption, sound, cut, zoom, other transform or project setting changed. Preview checks included frontal and angled-camera projects. WASM build verified all 27 required exports. Full Auto Edit calls this exact shared function with the vertical-cover framing mode before silence removal; the entire transcription pipeline was not rerun on these already-edited projects.
