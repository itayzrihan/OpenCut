# Unified Angles and podcast coverage

Status: **bridged Classic**. The rewrite media model is unchanged. Classic durable media metadata is part of `EditorDocument.project.classic`; mutations and undo/redo run through `OpenCutRuntime`. Browser IO reads physical camera/microphone files in cancellable workers; shared Rust podcast kernels choose clocks, enforce source coverage and route cameras.

- New Unified Angles assets use the longest physical camera as their default video, duration and (when present) camera audio. Grouping does not imply synchronization.
- Podcast Sync expands virtual assets into their physical cameras before audio decoding, correlates all unique recordings on one clock, and commits the result through `media.classic.unified.sync`. The existing group solver rejects recordings it cannot confidently connect.
- `unifiedAngles.sync` records `method: audio`, the longest reference asset and each source's relative start in seconds, duration and binding revision. No sync record means **Not audio synced**. Changed/missing sources mean **Sync outdated**. Valid source bindings mean **Audio synced**. Undo/redo and saved canonical sessions preserve this record.
- The longest camera's full recording defines the episode, rather than the intersection of all cameras. Late cameras have `videoDelay`; early cameras have `videoOffset`. Their available windows constrain speaker cuts, preroll and reaction shots. The continuing camera covers a shorter camera's absent tail.
- `timeline.classic.multicam.create` verifies original cut coverage, quantizes shared cut boundaries to the project frame rate, and only creates camera clips within actual source bounds. Unified clips split at alternative cameras' availability boundaries so they can be switched independently. Microphones retain their own continuous offsets and delays.
- `timeline.classic.unified.switch` validates full source ranges for explicit selections. Cycling skips unavailable angles. The menu disables unavailable angles; renderer and blur-background playback translate the virtual clock into the selected physical file's clock. Sound stays on the chosen audio source when switching cameras.
- Both new write capabilities require explicit project and optimistic revision and support dry run, cancellation, idempotency, atomic transactions and undo/redo. They perform no file or network IO. MCP tools are projected from the capability registry.

Older v1 assets remain readable as unsynchronized. Synchronizing an older asset updates its base/duration; existing timeline edits are not automatically stretched. Unknown legacy compound-media metadata remains untouched.

Regression coverage includes a one-hour base with a 30-minute camera starting 30 seconds later, early/late coverage limits, audio offset persistence, physical decoder inputs, reaction-shot bounds, stale binding rejection, exact source timestamps, atomic invalid selection, idempotency, undo and retained compound-media dependencies.
