# Virtual camera canvas

Use this contract when the composition should feel like a camera discovering a
larger designed world instead of unrelated objects sliding around the frame.

## Native OpenCut model

OpenCut's virtual world is built from existing serializable timeline state:

- `transform.positionX` and `transform.positionY` may place visual elements far
  beyond the visible frame;
- a camera movement effect transforms all visual layers below its effect layer
  as one world;
- `camera.depth` controls how strongly a layer responds to camera translation,
  zoom, and rotation;
- `camera.locked: true` keeps a layer in screen space, useful for a persistent
  caption rail, logo, or HUD;
- each world element keeps its own in/out transitions and keyframes;
- `create_speaker_tile` duplicates a source video into a silent visual layer,
  positions and scales it, and presents it as a rounded rectangle, ellipse,
  rectangle, or background-removed cutout.
- `create_speaker_frame_breakout` inserts one smart proof-stage layer whose
  internal cropped base and transparent foreground share the same source while
  the original video supplies dialogue.

This is the nesting contract: layers scoped beneath one camera effect share the
same camera transform while retaining their independent local motion. Do not
build a second group state store.

## Depth scale

Use a small number of intentional planes:

| Plane                 |          Suggested `camera.depth` | Behavior                                  |
| --------------------- | --------------------------------: | ----------------------------------------- |
| Distant background    |                         0.25-0.55 | Moves slowly; creates scale and calm      |
| Mid-background        |                         0.65-0.85 | Supports the destination                  |
| Subject/content plane |                               1.0 | Follows the authored camera route exactly |
| Near object           |                         1.25-1.65 | Crosses faster; useful for reveals        |
| Foreground occluder   |                           1.7-2.4 | Can overtake the lens during a dolly      |
| Screen-space rail/HUD | any depth + `camera.locked: true` | Does not move                             |

Depth is not decoration. Assign it from a spatial sketch and inspect the
relative displacement at the start, middle, and end of the move.

## Four camera grammars

### 1. Occlusion handoff

Use when a full card, large word, or UI object temporarily hides the speaker.

1. Let the current object fill or cross enough of the frame to motivate a cut.
2. Stage the destination one frame-width to the left or right on the same
   content plane.
3. Use `camera-canvas-pan-left` or `camera-canvas-pan-right`.
4. Keep the departing and arriving elements stationary in world coordinates.
   The shared camera route should create the movement.
5. Match the edge, baseline, and speed across the handoff so no gap reveals the
   trick.

If the old text moves left, content staged to the right normally enters from
the right. Reverse the route when the destination must enter from the left.
Decide from spatial continuity, not from the preset name alone.

### 2. Parallax scroll

Use `camera-parallax-scroll` when the background is larger than the frame and
the foreground should travel farther than the background.

- Overscan every moving plane at the route endpoints.
- Put the background around depth `0.35-0.55`.
- Put designed content around `0.9-1.1`.
- Put leaves, device edges, cards, or other near objects around `1.3-1.8`.
- Keep the speaker tile on the plane where the camera is meant to find them.
- Never expose the project clear color at an edge.

### 3. Dolly through an object

Use `camera-dolly-through` to make a foreground object grow past the lens and
reveal a deeper destination.

1. Place the occluder near the camera at depth `1.8-2.4`.
2. Give it enough source resolution and overscan to cover the entire frame at
   peak scale.
3. Put the destination at depth `0.8-1.1`.
4. Time the destination's local entrance during the occluded interval.
5. Inspect alpha, mask edges, motion blur expectations, and exact frames on
   both sides of full occlusion.

The object should feel passed-through, not merely scaled up. Its faster
parallax response and the synchronized destination reveal are essential.

### 4. Large world tour

Use `camera-world-canvas-tour` for maps, processes, timelines, product
ecosystems, spatial stories, or a sequence where the camera visits several
designed stations.

Create a world-coordinate table before editing:

| Station    | World X/Y | Depth | Arrival time | Local entrance | Exit/handoff |
| ---------- | --------- | ----: | ------------ | -------------- | ------------ |
| Hook       | ...       |   ... | ...          | ...            | ...          |
| Proof      | ...       |   ... | ...          | ...            | ...          |
| Speaker    | ...       |   ... | ...          | ...            | ...          |
| Resolution | ...       |   ... | ...          | ...            | ...          |

Keep related elements on the same plane unless the message benefits from
separation. Each station may animate locally while the camera travels, but do
not let local motion fight the route. Animate the destination into a readable
resting pose before or as the camera arrives.

## Speaker on the world canvas

Use `create_speaker_tile` with the source video element:

- `rounded-rectangle`: editable picture-in-world tile with adjustable
  `cornerRadius`, border color, and border width;
- `ellipse`: portrait bubble or person node;
- `rectangle`: hard editorial monitor/window;
- `cutout`: enables background removal and leaves the isolated speaker.

The operation duplicates the source timing, disables audio on the duplicate,
and applies world position, scale, and depth in one undoable edit. Keep the
opaque original when it is still part of the scene; hide or cover it only when
the composition requires it. For a cutout, inspect hair, hands, microphones,
held objects, edge chatter, and temporal consistency.

When the station participates in only one route, provide exact media-tick
`startTime` and `duration`. The duplicate is trimmed to that timeline interval
with retime-aware source sync instead of existing invisibly for the complete
clip.

The camera can arrive at the speaker as a destination station. Let the speaker
exist in the world before the arrival whenever possible; a late pop-in weakens
the feeling that the camera discovered a real location.

When a small speaker tile must preserve the body inside a frame while the head
breaks above it, choose `create_speaker_frame_breakout` instead of a plain
`cutout`. It adds one undoable smart layer whose renderer produces the opaque
stage, framed body, and breakout foreground with one shared transform. Apply
the layer after its interval and placement are final. The whole composite can
then live as one station under the shared virtual camera. Read
`kallaway-day1-full-analysis.md` before adjusting its crop or placement.

## Natural camera motion

All native virtual-camera routes use deterministic smooth interpolation plus a
small seek-safe handheld sway. The sway must feel like mass and breath:

- keep it subtle during reading;
- use lower amplitude on long world tours;
- preserve zero-offset endpoints for clean handoffs;
- do not add random per-frame noise;
- do not stack impact shake over handheld sway unless a semantic hit earns it;
- verify direct seeks and export match playback.

The route is primary. Sway should be felt before it is noticed.

## Preset selection

| Preset                     | Best use                                      |
| -------------------------- | --------------------------------------------- |
| `camera-canvas-pan-right`  | Reveal a station staged to the right          |
| `camera-canvas-pan-left`   | Reveal a station staged to the left           |
| `camera-parallax-scroll`   | Sideways travel with visibly separated planes |
| `camera-dolly-through`     | Forward travel through a foreground occluder  |
| `camera-world-canvas-tour` | Longer multi-station spatial narrative        |

The preset's `specJson` is serialized state. A reviewed plan may tune route
coordinates, start/end scale, parallax strength, and handheld amount by
creating explicit effect parameters, but it must preserve deterministic
frame-based evaluation.

## Planning and verification gates

Before apply:

- draw the world bounds and visible viewport at route start/end;
- map every world element to a depth and local transition;
- identify screen-locked elements;
- check source resolution at maximum effective scale;
- ensure an effect layer scopes exactly the intended world layers;
- search saved UI elements before creating a new proof asset.

After apply:

- inspect start, 25%, midpoint, 75%, and exact end;
- inspect every full occlusion boundary one frame before and after;
- confirm foreground travels farther than background;
- confirm locked captions do not drift;
- confirm no world edge or empty clear color enters the frame;
- confirm speaker duplicate audio is disabled;
- compare preview capture and export at the same frames.
