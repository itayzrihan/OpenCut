# OpenCut MCP server

OpenCut's MCP server exposes the complete **authorized Editor API**, rather than
maintaining a second list of editor-specific tools.

## Why future features appear automatically

The dependency direction is:

```text
feature module -> Editor API capability registry -> MCP projection
                                              \-> plugins / scripts / headless
```

A feature registers one `CapabilityDescriptor` and handler with
`OpenCutRuntime`. The descriptor contains its stable ID, version, input/output
JSON Schemas, access level, side-effect hints, category, and search tags.

The MCP adapter reads the live registry every time a client lists tools:

- Every capability becomes a direct `opencut.<capability-id>` tool.
- `opencut.discover` searches all current capabilities and contracts.
- `opencut.describe` returns one complete capability contract.
- `opencut.invoke` invokes any capability by ID, including one registered after
  a client cached its tool inventory.
- `opencut.batch` runs atomic (default) or best-effort multi-operation
  workflows.
- `opencut://manifest` contains the live, versioned Editor API manifest.
- `opencut://capabilities/{capabilityId}` exposes individual contracts.
- `opencut://state` exposes the app state through the canonical state reader.
- `opencut://jobs` exposes asynchronous render/analysis work.
- `opencut://artifacts/{artifactId}` serves bounded generated images, audio,
  captions, and render results without granting arbitrary filesystem access.
- Registry changes emit MCP tool/resource list-change notifications.

No MCP adapter change is needed when a new editor capability is added.
New serializable document fields are also immediately addressable through
`app.state.read` and the validated RFC 6902 `app.state.patch` fallback.

## Current editor coverage

The canonical runtime currently exposes:

- complete state and manifest reads, JSON Pointer subtrees, and validated
  whole-document RFC 6902 patches;
- multiple open project sessions, active-tab switching, recents, dirty state,
  restart restoration, and atomic project persistence;
- schema-v2 exact integer media ticks, rational time bases/frame rates, and
  transparent schema-v1 migration;
- FFprobe media inspection plus media import/update/removal;
- track add/update/delete/reorder;
- timeline item add/update/delete/move/trim/split/duplicate, multi-item
  transforms/grouping/linking, and ripple range deletion;
- rich text, transforms, crop, opacity, blend, audio, shapes, arbitrary
  metadata, and extension fields;
- effect stacks, keyframes, transitions, masks, and duration-aware markers;
- SRT/WebVTT import/export and optional local Whisper transcription;
- missing-media dependency scans, relinking, thumbnails, and waveforms;
- selection, playback/playhead, workspace, snapping, and ripple-edit state;
- shared undo/redo across human and agent changes;
- direct MCP preview image content and bounded binary artifacts;
- asynchronous jobs, audit activity, state diffs, timeline queries, health,
  effective permissions, history inspection, and render capability reporting;
- FFmpeg-backed preview frames and video export.

The MCP server adds universal discovery, description, late-bound invocation,
transactional batching, idempotency keys, optimistic revisions, resources,
subscriptions, cancellation, authorization policy, and automatic direct-tool
projection around those capabilities. The headless server currently exposes
72 tools; the desktop host adds semantic UI and window-capture capabilities.

When the current Classic editor is open on localhost, it attaches to the stdio
MCP process through an authenticated loopback bridge. The bridge publishes the
open project, exact playhead, timeline source, selection, and semantic UI
snapshot. It also projects the editor's live AI tool inventory as
`opencut.classic.*` tools, so reads and edits operate on the browser's actual
project rather than on a separate headless document.

## Run

From the repository root:

```sh
moon run mcp:dev
```

or:

```sh
cargo run -p opencut-mcp-server
```

The server uses MCP stdio. Standard output is reserved for protocol messages;
diagnostics are written to standard error. Set `RUST_LOG` to change log detail.

The executable policy is configurable without rebuilding:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENCUT_MCP_MAX_ACCESS` | `read`, `write`, `destructive`, or `admin` | `admin` |
| `OPENCUT_MCP_ALLOW` | Comma-separated capability IDs or namespace wildcards | `*` |
| `OPENCUT_MCP_DENY` | Comma-separated capability IDs or namespace wildcards | empty |
| `OPENCUT_FFMPEG_PATH` | Optional absolute path to FFmpeg | `ffmpeg` from `PATH` |
| `OPENCUT_FFPROBE_PATH` | Optional absolute path to FFprobe | `ffprobe` from `PATH` |
| `OPENCUT_WHISPER_COMMAND` | Optional local OpenAI Whisper CLI executable | disabled |
| `OPENCUT_CLASSIC_BRIDGE_ADDR` | Classic browser bridge loopback address | `127.0.0.1:0` |
| `OPENCUT_CLASSIC_BRIDGE_DISABLED` | Disable the Classic browser bridge when set | unset |

For example, `OPENCUT_MCP_MAX_ACCESS=read` makes the server read-only, while
`OPENCUT_MCP_DENY=export.*,plugins.*` blocks those namespaces even when the
maximum access level would otherwise allow them.

For a client that accepts a JSON server configuration:

```json
{
  "mcpServers": {
    "opencut": {
      "command": "cargo",
      "args": ["run", "--quiet", "-p", "opencut-mcp-server"],
      "cwd": "/absolute/path/to/OpenCut"
    }
  }
}
```

For regular use, build the release binary and configure its absolute path
instead of starting it through Cargo:

```sh
moon run mcp:build
```

The executable is `target/release/opencut-mcp` (`.exe` on Windows).

For authenticated headless Streamable HTTP:

```sh
OPENCUT_MCP_HTTP_TOKEN=replace-with-a-random-secret-at-least-32-characters \
  cargo run -p opencut-mcp-server -- --http 127.0.0.1:32123
```

The endpoint is `http://127.0.0.1:32123/mcp`. Non-loopback addresses and weak
tokens are rejected.

### Current Classic browser editor

The Classic development launchers start the stdio MCP server and its
authenticated loopback bridge automatically:

```sh
cd classic
bun run dev:web       # browser + MCP bridge
bun run dev:electron  # Electron + MCP bridge
```

The Electron shell also ensures the bridge when it is started on its own with
`bun run --cwd apps/electron dev:shell`. The launcher reuses an already healthy
bridge (for example one started by an MCP client), otherwise it starts the
workspace `opencut-mcp` binary and keeps its stdio input open for the lifetime
of the editor.

To start the MCP server manually, use `cargo run -p opencut-mcp-server` from the
repository root. Automatic startup detects and reuses that bridge.

The MCP process writes a short-lived connection record under OpenCut's local
application-data directory. The browser never receives its bearer token:
same-origin `/api/mcp-bridge/*` routes read the record on the server, verify
that both sides are loopback-only, and proxy the authenticated requests. The
editor displays an `MCP connected` badge while the live session is attached.

Use `opencut.classic.session.read` to identify the connected project and exact
playhead. Classic tools advertised by the open editor then appear dynamically,
including full timeline reads, preview capture, and validated edit-plan
application. Mutations require the connected `projectId` and may include
`expectedRevision`.

This bridge intentionally cannot inspect other browser tabs, capture the
desktop, expose credentials, or execute arbitrary shell commands. It connects
only the OpenCut editor page that loaded the local bridge component.

## Feature author contract

All user-visible reads and actions belong in the Editor API. UI panels should
call these same capabilities instead of mutating editor state through a second
path. This is the invariant that gives MCP full coverage.

Minimal registration:

```rust
use std::sync::Arc;
use opencut_editor_api::{
    AccessLevel, CapabilityDescriptor, CapabilityResult, FnCapability,
    OpenCutRuntime,
};
use serde_json::json;

fn register_clip_move(runtime: &OpenCutRuntime) -> Result<(), Box<dyn std::error::Error>> {
    let mut descriptor = CapabilityDescriptor::read(
        "timeline.clip.move",
        "Move timeline clip",
        "Moves a clip to a track and start time through the editor transaction layer.",
        "timeline",
        json!({
            "type": "object",
            "properties": {
                "clipId": {"type": "string"},
                "trackId": {"type": "string"},
                "startSeconds": {"type": "number", "minimum": 0}
            },
            "required": ["clipId", "trackId", "startSeconds"],
            "additionalProperties": false
        }),
        json!({
            "type": "object",
            "properties": {
                "clipId": {"type": "string"},
                "revision": {"type": "integer"}
            },
            "required": ["clipId", "revision"],
            "additionalProperties": false
        }),
    );
    descriptor.access = AccessLevel::Write;
    descriptor.idempotent = true;
    descriptor.tags = vec!["clip".into(), "timeline".into(), "reposition".into()];

    runtime.register(Arc::new(FnCapability::new(descriptor, |context, input| {
        Box::pin(async move {
            // Call the canonical editor transaction here.
            let _ = (context, input);
            Ok(CapabilityResult {
                data: json!({"clipId": "clip-1", "revision": 2}),
                summary: Some("Moved clip".into()),
                changed_resources: vec!["opencut://state".into()],
                artifacts: Vec::new(),
            })
        })
    })))?;
    Ok(())
}
```

The registry validates input before the handler runs and validates structured
output afterward. Invalid feature contracts fail at registration. The
`InvocationContext` also carries the originating client's identity, request ID,
dry-run preference, and cancellation token; long-running handlers should stop
cleanly when `context.cancellation.is_cancelled()` becomes true.

Repository-level feature instructions in `AGENTS.md` make this registration
contract part of future Codex development work, so new UI functionality is not
silently introduced outside the canonical runtime.

## Authority and safety

"Full access" means complete coverage of operations deliberately registered by
OpenCut. It does **not** expose a shell, arbitrary process execution, raw
credentials, or unrestricted machine filesystem access.

Every capability declares one access level:

- `read`
- `write`
- `destructive`
- `admin`

`AccessPolicy` applies a maximum access level plus namespace allow/deny lists
before every invocation. Trusted local stdio currently uses
`AccessPolicy::full_local_access()`. Embedders can choose `read_only()` or a
custom policy. Destructive and open-world hints are projected into standard MCP
tool annotations so compatible clients can require user confirmation.

Network transport must not be enabled without authentication, loopback binding,
Host/Origin validation, and an explicit policy. The shipped HTTP mode enforces
the first three and uses the same configurable `AccessPolicy` as stdio.

### Active desktop instance

The desktop can opt in to an authenticated Streamable HTTP endpoint backed by
its exact live `OpenCutRuntime`:

```sh
OPENCUT_MCP_HTTP_ADDR=127.0.0.1:32123
OPENCUT_MCP_HTTP_TOKEN=replace-with-a-random-secret-at-least-32-characters
moon run desktop:dev
```

Connect the MCP client to `http://127.0.0.1:32123/mcp` with
`Authorization: Bearer <the token>`. The server refuses non-loopback binds,
requires a token of at least 32 characters, validates Host/Origin through the
MCP transport, and does not start unless both environment variables are
present.

Use the desktop endpoint when the agent must see live selection, playback, UI,
or in-memory project state. Use stdio for headless automation.

Mutating MCP tools advertise `projectId` as required so edits cannot drift to a
different tab. They also accept `expectedRevision` and `idempotencyKey`.
Omitting `projectId` still targets the sole active tab for one compatibility
release, but new clients should always send it.

### Render fidelity

`preview.frame.capture` and `export.render` use the same FFmpeg compatibility
backend, so the agent receives the same composition path used for export.
`render.capabilities.list` is the source of truth for fidelity. It currently
reports animated keyframes, soft transitions, adjustment layers, masks,
gradient backgrounds, rich text spans, and unknown effect types as preserved
but unsupported rather than silently claiming they rendered.

## Validate

```sh
moon run mcp:check
moon run mcp:test
```

The tests cover schema validation, policy enforcement, capability discovery,
invocation, and automatic MCP projection. A protocol smoke test can also be run
with an MCP Inspector against `target/debug/opencut-mcp`.
