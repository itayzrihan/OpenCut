# OpenCut Desktop

Built with [GPUI](https://www.gpui.rs).

The desktop panels consume the same revisioned `OpenCutRuntime` used by the
Editor API and MCP. Live agent edits therefore update the media browser,
preview status, inspector, and timeline rather than a separate headless copy.

## Running

Rust is pinned in `.prototools` at the repo root (`proto use` installs it).

```sh
moon run desktop:dev     # cargo run
moon run desktop:check   # cargo check
moon run desktop:build   # cargo build --release
```

The first build compiles GPUI from source and takes a while. The root `Cargo.lock` is committed.

## Connect an agent to the active editor

Start the desktop with an authenticated loopback MCP endpoint:

```powershell
$env:OPENCUT_MCP_HTTP_ADDR = "127.0.0.1:32123"
$env:OPENCUT_MCP_HTTP_TOKEN = "replace-with-a-random-secret-at-least-32-characters"
moon run desktop:dev
```

Connect an MCP client to `http://127.0.0.1:32123/mcp` and send
`Authorization: Bearer <token>`. This endpoint is backed by the desktop's exact
in-memory runtime, including the open project, selection, playhead, text,
tracks, items, effects, and workspace state.

To approve app-window pixel capture for this desktop session, also set:

```powershell
$env:OPENCUT_MCP_UI_CAPTURE = "1"
```

`ui.screenshot.capture` locates a visible window owned by the current OpenCut
process and returns only that window as a PNG MCP image. It never offers a
full-screen or arbitrary-window selector. `ui.snapshot.read` remains available
without pixel-capture approval and reports panel bounds, focus, viewport state,
selection, playhead, open project, and MCP status.

Open tabs and recent-project metadata are restored from the platform
application-state directory. Set `OPENCUT_SESSION_STATE_PATH` to override that
location.

Set `OPENCUT_FFMPEG_PATH` and `OPENCUT_FFPROBE_PATH` when those executables are
not on `PATH`. They power media inspection, preview-frame rendering, and final
export.

## Platform requirements

- **macOS**: Xcode command line tools (Metal renderer).
- **Windows**: no extra dependencies (Win32 + DirectWrite).
- **Linux**: renders via Vulkan (Blade), windows via Wayland or X11 (both enabled by default). System packages (Debian/Ubuntu names): `libvulkan1` + working Vulkan drivers, `libwayland-dev`, `libx11-xcb-dev`, `libxkbcommon-x11-dev`, `libfontconfig-dev`, plus a C toolchain and `cmake`.
- **WSL2/WSLg**: uses XWayland automatically when available. GPUI 0.2.2 requires `xdg_wm_base` v2–5, while WSLg advertises v1.
