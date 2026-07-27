use std::path::PathBuf;

use gpui::{App, Context, Entity, Window, div, prelude::*};
use opencut_editor_api::OpenCutRuntime;

use crate::observation::UiObservation;
use crate::panels::{Browser, Inspector, Preview, Timeline};
use crate::theme::ActiveTheme;

// Panels are entities created once in `new`, not via `cx.new` inline in
// `render`, so each keeps its own state across renders instead of being
// torn down and rebuilt on every frame.
pub(crate) struct Shell {
    // The UI, headless mode, plugins, scripting, and MCP all consume this
    // canonical runtime. Feature modules register Editor API capabilities on
    // it instead of implementing transport-specific commands.
    runtime: OpenCutRuntime,
    browser: Entity<Browser>,
    preview: Entity<Preview>,
    inspector: Entity<Inspector>,
    timeline: Entity<Timeline>,
    observation: UiObservation,
}

impl Shell {
    pub(crate) fn new(cx: &mut App) -> Self {
        let runtime = OpenCutRuntime::default();
        let session_path = application_session_path();
        if let Err(error) = runtime.restore_application_state(&session_path) {
            eprintln!("OpenCut session restore failed: {error}");
        }
        start_session_persistence(&runtime, session_path);
        let observation = UiObservation::default();
        if let Err(error) = observation.register(&runtime) {
            eprintln!("OpenCut UI observation capabilities failed to register: {error}");
        }
        start_live_mcp_if_configured(&runtime);
        Self {
            browser: cx.new(|cx| Browser::new(runtime.clone(), cx)),
            preview: cx.new(|cx| Preview::new(runtime.clone(), cx)),
            inspector: cx.new(|cx| Inspector::new(runtime.clone(), cx)),
            timeline: cx.new(|cx| Timeline::new(runtime.clone(), cx)),
            observation,
            runtime,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn runtime(&self) -> &OpenCutRuntime {
        &self.runtime
    }
}

fn application_session_path() -> PathBuf {
    if let Some(path) = std::env::var_os("OPENCUT_SESSION_STATE_PATH") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    if let Some(directory) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(directory)
            .join("OpenCut")
            .join("session.json");
    }
    #[cfg(target_os = "macos")]
    if let Some(directory) = std::env::var_os("HOME") {
        return PathBuf::from(directory)
            .join("Library")
            .join("Application Support")
            .join("OpenCut")
            .join("session.json");
    }
    #[cfg(target_os = "linux")]
    if let Some(directory) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(directory)
            .join("opencut")
            .join("session.json");
    }
    std::env::temp_dir().join("opencut").join("session.json")
}

fn start_session_persistence(runtime: &OpenCutRuntime, path: PathBuf) {
    let runtime = runtime.clone();
    let mut changes = runtime.subscribe_state();
    let _ = std::thread::Builder::new()
        .name("opencut-session-persistence".into())
        .spawn(move || {
            let tokio_runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("OpenCut session persistence failed to start: {error}");
                    return;
                }
            };
            tokio_runtime.block_on(async move {
                while changes.recv().await.is_ok() {
                    if let Err(error) = runtime.save_application_state(&path) {
                        eprintln!("OpenCut session persistence failed: {error}");
                    }
                }
            });
        });
}

fn start_live_mcp_if_configured(runtime: &OpenCutRuntime) {
    let Some(address) = std::env::var_os("OPENCUT_MCP_HTTP_ADDR") else {
        return;
    };
    let Some(token) = std::env::var_os("OPENCUT_MCP_HTTP_TOKEN") else {
        eprintln!(
            "OpenCut MCP HTTP was not started: OPENCUT_MCP_HTTP_TOKEN must be set to a secret of at least 32 characters"
        );
        return;
    };
    let Ok(address) = address.to_string_lossy().parse() else {
        eprintln!("OpenCut MCP HTTP was not started: OPENCUT_MCP_HTTP_ADDR is invalid");
        return;
    };
    let token: String = token.to_string_lossy().into_owned();
    let runtime = runtime.clone();

    let _ = std::thread::Builder::new()
        .name("opencut-mcp-http".into())
        .spawn(move || {
            let tokio_runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("OpenCut MCP HTTP runtime failed to start: {error}");
                    return;
                }
            };
            if let Err(error) = tokio_runtime.block_on(
                opencut_mcp::serve_runtime_authenticated_http(runtime, address, token),
            ) {
                eprintln!("OpenCut MCP HTTP server stopped: {error}");
            }
        });
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        self.observation
            .update(&self.runtime, window.bounds(), window.is_window_active());
        let colors = window.theme().colors;

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(colors.background)
            .text_color(colors.foreground)
            .child(
                div()
                    .flex()
                    .h_2_3()
                    .border_b_1()
                    .border_color(colors.border)
                    .child(self.browser.clone())
                    .child(self.preview.clone())
                    .child(self.inspector.clone()),
            )
            .child(self.timeline.clone())
    }
}
