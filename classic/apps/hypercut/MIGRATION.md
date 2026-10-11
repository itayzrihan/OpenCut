# HyperCut — migration contract and feature inventory

New product based on HyperFrames Studio 0.8.146. New projects only; old OpenCut projects are explicitly outside this migration. OpenCut remains available until validated parity.

## Architecture

- The product entry renders the complete original `StudioApp` from pinned `@hyperframes/studio` 0.8.146, with its own styles, panels, tools and player. The former custom shell is retired.
- The native timeline label column is always visible, including projects without keyframes. `studio-customizations.ts` applies this presentation-only change at build/dev time, with a guarded upstream hook match; installations do not modify dependency files. Position/Scale lanes still reflect actual authored animations.
- `OpenCutRuntime` owns the typed `hypercutStudio` source extension inside `EditorDocument.project.extensions`. `project.studio.source.commit` validates and accepts edits atomically, with project/revision fencing, history, dry-run and registry idempotency.
- The official Studio server prepares candidate file edits in a private materialization. A serialized host gate commits the resulting source and asset bindings through Rust, persists them, and only then acknowledges the write. Rejected writes restore the materialization; readers cannot observe candidates during this process.
- The canonical runtime runs in the local host process, outside the browser UI thread. The old OpenCut Canvas renderer and all-media audio preparation are not mounted.
- Original Studio Undo/Redo controls invoke canonical history. Optional bounded history serialization preserves the stack across host restarts; the old document-only serializer remains the default for other hosts.
- Media bytes live in immutable host blobs; only paths, SHA-256 and sizes enter history. `.data/workspace` is a disposable private cache, not another editable project store.
- No writes to existing OpenCut projects, the user's running HyperFrames project, or the npx cache.
- Full frontend parity is pending. Current history claims do not yet coalesce multi-file gestures, and the shared source representation still needs semantic adapters for Classic Smart Takes/Full Auto. Those capabilities are not silently applied to an independent Classic timeline.
- Catalog browsing is connected to the official HyperFrames registry (blocks and components), with concurrent metadata loading, a persistent 24-hour cache and stale-cache fallback. Registry requests run outside the document queue. Catalog installation into a project remains pending; browsing does not imply installation parity.

## Inventory

### Remote-vs-official source audit (2026-10-11)

The [searchable comparison](audit/comparison.html) and [machine-readable evidence](audit/comparison.json) compare fetched `itayzrihan/OpenCut` main (`92bb6765d015`) plus the editor branch (`d05f933b6e79`) against official Classic (`cf5e79e91914`) and the official rewrite (`e66801077856`). Classic paths are normalized against our `classic/` subtree. Local HyperCut (`9606bdacafae`) and subsequent uncommitted UI/catalog changes are assessed separately; they are not presented as remote features.

The audit identifies 90 migration requirements: 72 custom additions and 18 extensions of existing behavior, with 217 verified source references. These are work items, including subfeatures, not an exact count of independent product features. The audit also records native baseline functions, the 11 added asset tabs (20 vs 9), explicit preset ID literals, performance requirements, and local-only commits. `Adjustment` remains a placeholder in our Classic UI; the color-correction effect is distinct from that unfinished tab.

This supplements the 75-family inventory below rather than replacing it or claiming parity. Every requirement has a strategy and acceptance criterion. Private assets stored outside Git require a separate manifest audit; the repository alone cannot establish that all user-created SFX/font/preset bytes are available. No 90-workflow end-to-end acceptance run was performed during this source audit. Reproduce with `python3 classic/apps/hypercut/audit/build_report.py` after explicitly fetching the intended refs.

75 rows cover feature families and the 20 existing asset panels. These are not 75 missing features: several have native HyperFrames equivalents. Native availability is distinct from a working HyperCut integration. A row marked bridged is not a full parity claim.

| # | Feature | HyperFrames baseline | HyperCut status |
|---|---|---|---|
| 1 | Insert clips | Native analogue | classic-only |
| 2 | Duplicate clips | Native analogue | classic-only |
| 3 | Remove clips/tracks | Native analogue | classic-only |
| 4 | Move clips | Native analogue | classic-only |
| 5 | Split / retain left / retain right | Native analogue | bridged |
| 6 | Clip trim, retime, parameters and visibility | Native analogue | bridged |
| 7 | Clip mute and visibility | Native analogue | classic-only |
| 8 | Copy and paste clips | Native analogue | classic-only |
| 9 | Merge text clips | Custom workflow / audit required | classic-only |
| 10 | Clip transitions | Native analogue | classic-only |
| 11 | Text transitions/reveal with SFX | Custom workflow / audit required | classic-only |
| 12 | Background removal | Custom workflow / audit required | classic-only |
| 13 | Ripple editing | Native analogue | classic-only |
| 14 | Create, order, mute and show tracks | Native analogue | classic-only |
| 15 | Separate/recover source audio | Custom workflow / audit required | classic-only |
| 16 | Clip effects | Custom workflow / audit required | classic-only |
| 17 | Masks and freeform points | Custom workflow / audit required | classic-only |
| 18 | Animation/keyframe editing | Native analogue | classic-only |
| 19 | Copy/paste keyframes | Native analogue | classic-only |
| 20 | Scene create/rename/switch/delete | Native analogue | classic-only |
| 21 | Bookmark edits | Custom workflow / audit required | classic-only |
| 22 | Project FPS/canvas/background | Native analogue | classic-only |
| 23 | Caption words/layout and generated/manual ownership | Native analogue | classic-only |
| 24 | Silence removal/recovery | Custom workflow / audit required | classic-only |
| 25 | Parallax marker and canvas stories | Custom workflow / audit required | classic-only |
| 26 | Import/delete media | Native analogue | bridged |
| 27 | Undo/Redo | Native analogue | bridged |
| 28 | Playback and timeline navigation | Native analogue | bridged |
| 29 | Selection/snapping/cancel interaction and scoped UI presentation | Native analogue | classic-only |
| 30 | HyperFrames import/source/variables/layer movement | Native analogue | classic-only |
| 31 | Native preview/export | Native analogue | classic-only |
| 32 | Agent conversation/run/media recovery | Custom workflow / audit required | classic-only |
| 33 | Subscription image generation/editing | Custom workflow / audit required | classic-only |
| 34 | Owned project inspection and media transfer | Custom workflow / audit required | classic-only |
| 35 | Semantic take assembly and alternatives | Custom workflow / audit required | classic-only |
| 36 | Full Automatic Edit + resume + cancellation | Custom workflow / audit required | classic-only |
| 37 | Batch Full Auto Edit | Custom workflow / audit required | classic-only |
| 38 | Smart silence detection and word-safe cuts | Custom workflow / audit required | classic-only |
| 39 | Restore silence only BETWEEN selected clips | Custom workflow / audit required | classic-only |
| 40 | Delete and close gap | Native analogue | classic-only |
| 41 | Leading trim preview and deferred ripple | Native analogue | classic-only |
| 42 | Playhead drag scrolls only near viewport edges | Native analogue | classic-only |
| 43 | Automatic zoom and subject framing | Custom workflow / audit required | classic-only |
| 44 | Automatic text transitions | Custom workflow / audit required | classic-only |
| 45 | Automatic semantic word animation | Custom workflow / audit required | classic-only |
| 46 | Automatic music placement and mixing | Custom workflow / audit required | classic-only |
| 47 | Local subject tracking / reframe | Custom workflow / audit required | classic-only |
| 48 | Podcast extracts, speaker sync and multicam | Custom workflow / audit required | classic-only |
| 49 | Internal accounts, login, isolation | Custom workflow / audit required | classic-only |
| 50 | Global music/SFX + commercial license review tags | Custom workflow / audit required | classic-only |
| 51 | Project ownership, autosave, recovery and storage errors | Custom workflow / audit required | bridged |
| 52 | Fast opening, bounded caches, background preparation | Custom workflow / audit required | classic-only |
| 53 | Export video/audio with fonts, effects and A/V sync | Native analogue | classic-only |
| 54 | New HyperCut project backup / restore ZIP | Custom workflow / audit required | classic-only |
| 55 | Desktop launch, production start/stop, Electron | Custom workflow / audit required | classic-only |
| 56 | Panel: media | Native analogue | bridged |
| 57 | Panel: ai | Custom workflow / audit required | classic-only |
| 58 | Panel: timeline-code | Custom workflow / audit required | classic-only |
| 59 | Panel: sounds | Native analogue | classic-only |
| 60 | Panel: text | Native analogue | bridged |
| 61 | Panel: stickers | Custom workflow / audit required | classic-only |
| 62 | Panel: templates | Native analogue | classic-only |
| 63 | Panel: ui-elements | Custom workflow / audit required | classic-only |
| 64 | Panel: simple-advanced-layers | Custom workflow / audit required | classic-only |
| 65 | Panel: backgrounds | Custom workflow / audit required | classic-only |
| 66 | Panel: effects | Custom workflow / audit required | classic-only |
| 67 | Panel: overlays | Custom workflow / audit required | classic-only |
| 68 | Panel: overlay-movement | Custom workflow / audit required | classic-only |
| 69 | Panel: parallax-story-teller | Custom workflow / audit required | classic-only |
| 70 | Panel: loops | Custom workflow / audit required | classic-only |
| 71 | Panel: transitions | Native analogue | classic-only |
| 72 | Panel: captions | Native analogue | classic-only |
| 73 | Panel: see-captions | Custom workflow / audit required | classic-only |
| 74 | Panel: adjustment | Custom workflow / audit required | classic-only |
| 75 | Panel: settings | Native analogue | classic-only |

## Acceptance and rollout

1. Baseline: new project, media import, HF preview/timeline, canonical edits, persistence and recovery.
2. Smart editing: smart silence, bounded restoration, Smart Takes and alternatives; Full Auto/Edit resume after interruption.
3. Typography/audio automation and all authored effect/panel families.
4. Accounts/global resources, export, batch and desktop production.
5. Compare identical new-project media and edits in upstream HF, HyperCut and OpenCut: load, first Play, repeated Play, sustained playback, seek, edit latency, memory, save/exit. Record actual results; do not infer improvement from a successful build.

Production replacement requires every intended feature to pass. Incomplete controls must not pretend to work.
