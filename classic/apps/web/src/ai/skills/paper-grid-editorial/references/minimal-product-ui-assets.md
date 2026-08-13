# Minimal product-UI motion asset system

Use this reference for compact interface overlays, proof objects, metric cards,
messages, alerts, search fields, files, toggles, progress, and social proof.
The twelve source images are screenshots of a style-library showcase, not
redistributable source assets. Recreate the visual grammar as editable OpenCut
components; never crop or ship the screenshots themselves.

## What the reference library contains

The showcase organizes assets by All, Zooms, Transitions, Text Animations,
Overlays, Backgrounds, Templates, AE Templates, and Motion Essences. Each tile
is a reusable contract with a preview, name, type, duration/aspect metadata,
category, short description, and a “when to use” decision.

Visible specimens include:

- Notes and planning: Note Minimal, Note Open, Planner, Previous Chapter,
  Start-End, and Time.
- Communication and social proof: Packed DMs, Avatar Message Left, Avatar
  Message Right, Avatars, Blue Bubble Left, Blue Bubble Right, Fire Message,
  Fire Spam, Hello/What Reveal, Follower Count, and Team.
- Search and commerce: Search Bar Basic, Search Bar 1 Result, Search Bar 3
  Results, Search Bar Send, Quick Checkout, Shop Notification, Receive Money,
  Earnings, and Balance.
- Status and controls: Goal, Progress Bar, Basic Increase, Basic Decrease,
  1 Text Toggle, 3 Text Toggle, 3 Levels, Fire Slider, App Notification, Green
  Unlock, Red Lock, Restricted, File Download, Folder Contents, Folder Roll,
  and Switch.
- Direction and emphasis: Pin, Pointer Check, Pointer Cross, Reveal, Hook,
  Focus, Hire, Flash Frame, Slow Push Hold, Posterize Edges, Beginner-Pro
  Horizontal, Beginner-Pro Vertical, and Sneaker.

The enlarged Goal specimen is the clearest style anchor: a compact black
rounded card, one blue target label, a horizontal blue-to-gray progress track,
a blue knob, and a quiet secondary value. It communicates one claim at a
glance and animates the evidence rather than decorating it.

## Design grammar

- Prefer a small card, chip, field, or pill over a miniature full application
  screen.
- Use high contrast: near-black with white, or warm off-white with near-black.
- Use one semantic accent per asset. Blue means active/information, green means
  success/growth, and red means blocked/destructive.
- Use generous corner radii, restrained shadows, compact spacing, and one
  dominant hierarchy.
- Keep copy short and editable. The object should remain understandable when
  paused on its resting frame.
- Show proof through state: a number changes, a bar fills, a result appears, a
  message arrives, a lock changes, or a file moves.
- Integrate the object with the footage’s negative space. Do not default every
  asset to the exact center or cover a face.

Avoid ornamental gradients, excessive glass, multiple accent colors, tiny
dashboard detail, generic icon clouds, and motion that does not alter meaning.

## Native template vocabulary

Prefer these editable OpenCut UI-element templates:

| Template               | Meaning                       | Required state change                |
| ---------------------- | ----------------------------- | ------------------------------------ |
| `minimal-note`         | agenda, topic, steps          | container reveals, then rows resolve |
| `search-bar`           | question, research, discovery | field opens, query resolves          |
| `goal-slider`          | target, funding, completion   | track and knob progress              |
| `metric-pill`          | revenue, followers, views     | number counts to its result          |
| `avatar-message-left`  | first speaker/testimonial     | message enters from left             |
| `avatar-message-right` | reply/comparison              | reply enters from right              |
| `folder-pill`          | file, download, handoff       | folder/status resolves               |
| `profile-stack`        | team, audience, community     | profiles assemble                    |
| `app-notification`     | alert, result, status         | notification drops and dismisses     |

Use `catalog.search` with domain `ui_elements` before creating anything.
Retrieve an exact candidate with `catalog.get` so its full editable parameters,
motion, default duration, category, and usage note are preserved.

## Motion contract

Every asset is a visual design plus a motion design. It must store:

- `animationIn` and `animationInEnd`;
- a stable readable hold;
- `eventAt` for the meaningful state change;
- `animationOut` and `animationOutStart`;
- `animationStrength`;
- a default duration long enough to understand the state;
- text reveal/transition behavior when copy is present.

The order is always:

`container entrance → semantic event → readable hold → clean exit`

Use soft motion for explanation, precise motion for evidence, and energetic
motion only for a real peak. The animation should still communicate correctly
when the element starts at an arbitrary timeline time and is seeked directly.

## Reuse and persistence contract

Treat these as four different concepts:

1. A template is renderer behavior such as `goal-slider`.
2. A preset is reusable content, styling, timing, and motion settings.
3. An instance is one preset placed on one timeline.
4. A screenshot is reference evidence only.

Before authoring a novel preset:

1. Search saved and built-in `ui_elements`.
2. Reuse an existing preset when its semantic function fits; change instance
   text or values only when needed.
3. If none fits, create one native UI element with complete content, color,
   state, duration, entrance, event, hold, and exit settings.
4. Include `saveAsUiElement` on the `insert_graphic_element` operation with
   description, category, at least three keywords, `whenToUse`, and the source
   prompt. This saves the approved novel preset into UI Elements.
5. On later edits, search the catalog again and reuse the saved preset ID.

No orphaned one-offs: a novel product-UI asset created by the skill must be
saved with its full settings and provenance. Do not save a built-in preset
again, and do not save ordinary captions or unrelated full-screen HyperFrames
as UI elements.

## Quality gate

Reject or revise an asset when:

- it has no meaningful state change;
- it appears or exits too quickly to understand;
- its animation settings are missing or use an incompatible template motion;
- text, counts, progress, colors, or duration are flattened into an image;
- it duplicates a catalog preset without adding a new semantic role;
- its resting frame is unclear;
- it covers the speaker’s eyes, mouth, or the proof it is meant to explain.
