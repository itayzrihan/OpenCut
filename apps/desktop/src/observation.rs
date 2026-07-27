use std::{
    io::Cursor,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use gpui::{Bounds, Pixels};
use opencut_editor_api::{
    AccessLevel, ArtifactRef, CapabilityDescriptor, CapabilityError, CapabilityResult,
    FnCapability, OpenCutRuntime,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use xcap::{Window as CaptureWindow, image::ImageFormat};

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiRect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiPanelSnapshot {
    id: String,
    title: String,
    bounds: UiRect,
    visible: bool,
    focused: bool,
    state: Value,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiSnapshot {
    captured_at_ms: u64,
    window_title: String,
    window_bounds: UiRect,
    window_focused: bool,
    active_panel: String,
    active_project_id: Option<String>,
    project_revision: u64,
    playhead_seconds: f64,
    playing: bool,
    selected_asset_ids: Vec<String>,
    selected_track_ids: Vec<String>,
    selected_item_ids: Vec<String>,
    selected_effect_ids: Vec<String>,
    panels: Vec<UiPanelSnapshot>,
    mcp_http_configured: bool,
    ui_capture_approved: bool,
}

impl Default for UiSnapshot {
    fn default() -> Self {
        Self {
            captured_at_ms: now_ms(),
            window_title: "OpenCut".into(),
            window_bounds: UiRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            window_focused: false,
            active_panel: "timeline".into(),
            active_project_id: None,
            project_revision: 0,
            playhead_seconds: 0.0,
            playing: false,
            selected_asset_ids: Vec::new(),
            selected_track_ids: Vec::new(),
            selected_item_ids: Vec::new(),
            selected_effect_ids: Vec::new(),
            panels: Vec::new(),
            mcp_http_configured: false,
            ui_capture_approved: false,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct UiObservation {
    snapshot: Arc<RwLock<UiSnapshot>>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyInput {}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UiCaptureOutput {
    artifact: ArtifactRef,
    window_title: String,
    width: u32,
    height: u32,
}

impl UiObservation {
    pub(crate) fn register(&self, runtime: &OpenCutRuntime) -> Result<(), String> {
        let snapshot = self.snapshot.clone();
        runtime
            .register(Arc::new(FnCapability::new(
                descriptor::<EmptyInput, UiSnapshot>(
                    "ui.snapshot.read",
                    "Read semantic UI snapshot",
                    "Returns the OpenCut window, panels, focus, project, playhead, selection, viewport, and MCP capture state without pixel interpretation.",
                    AccessLevel::Read,
                    false,
                ),
                move |_, _| {
                    let snapshot = snapshot.clone();
                    Box::pin(async move {
                        let snapshot = snapshot
                            .read()
                            .map_err(|_| CapabilityError::Failed("UI snapshot lock was poisoned".into()))?
                            .clone();
                        Ok(CapabilityResult::data(
                            serde_json::to_value(snapshot)
                                .map_err(|error| CapabilityError::Failed(error.to_string()))?,
                        ))
                    })
                },
            )))
            .map_err(|error| error.to_string())?;

        let capture_approved = capture_approved();
        let artifacts = runtime.artifacts().clone();
        let mut capture_descriptor = descriptor::<EmptyInput, UiCaptureOutput>(
            "ui.screenshot.capture",
            "Capture OpenCut window",
            "Captures only this OpenCut process window and returns the PNG directly as an MCP image artifact.",
            AccessLevel::Read,
            false,
        );
        capture_descriptor.available = capture_approved;
        capture_descriptor.unavailable_reason = (!capture_approved).then(|| {
            "UI capture requires one-time process approval via OPENCUT_MCP_UI_CAPTURE=1".into()
        });
        runtime
            .register(Arc::new(FnCapability::new(
                capture_descriptor,
                move |context, _| {
                    let artifacts = artifacts.clone();
                    Box::pin(async move {
                        if context.cancellation.is_cancelled() {
                            return Err(CapabilityError::Failed("capture was cancelled".into()));
                        }
                        let pid = std::process::id();
                        let windows = CaptureWindow::all()
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                        let window = windows
                            .into_iter()
                            .filter(|window| window.pid().ok() == Some(pid))
                            .filter(|window| {
                                window.title().is_ok_and(|title| title.contains("OpenCut"))
                            })
                            .filter(|window| !window.is_minimized().unwrap_or(true))
                            .max_by_key(|window| window.is_focused().unwrap_or(false))
                            .ok_or_else(|| {
                                CapabilityError::Unavailable(
                                    "the visible OpenCut window could not be located".into(),
                                )
                            })?;
                        let title = window.title().unwrap_or_else(|_| "OpenCut".into());
                        let image = window
                            .capture_image()
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                        let width = image.width();
                        let height = image.height();
                        let mut bytes = Cursor::new(Vec::new());
                        image
                            .write_to(&mut bytes, ImageFormat::Png)
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                        let artifact = artifacts
                            .put(
                                bytes.into_inner(),
                                "image/png",
                                Some(width),
                                Some(height),
                                None,
                            )
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                        let output = UiCaptureOutput {
                            artifact: artifact.clone(),
                            window_title: title,
                            width,
                            height,
                        };
                        Ok(CapabilityResult {
                            data: serde_json::to_value(output)
                                .map_err(|error| CapabilityError::Failed(error.to_string()))?,
                            summary: Some("Captured OpenCut window".into()),
                            changed_resources: Vec::new(),
                            artifacts: vec![artifact],
                        })
                    })
                },
            )))
            .map_err(|error| error.to_string())
    }

    pub(crate) fn update(&self, runtime: &OpenCutRuntime, bounds: Bounds<Pixels>, focused: bool) {
        let Ok(document) = runtime.snapshot() else {
            return;
        };
        let width: f32 = bounds.size.width.into();
        let height: f32 = bounds.size.height.into();
        let x: f32 = bounds.origin.x.into();
        let y: f32 = bounds.origin.y.into();
        let top_height = height * 2.0 / 3.0;
        let browser_width = width * 0.22;
        let inspector_width = width * 0.25;
        let preview_width = width - browser_width - inspector_width;
        let active_panel = document.workspace.active_panel.clone();
        let panel =
            |id: &str, title: &str, x: f32, y: f32, width: f32, height: f32, state: Value| {
                UiPanelSnapshot {
                    id: id.into(),
                    title: title.into(),
                    bounds: UiRect {
                        x,
                        y,
                        width,
                        height,
                    },
                    visible: width > 0.0 && height > 0.0,
                    focused: active_panel == id,
                    state,
                }
            };
        let panels = vec![
            panel(
                "browser",
                "Media Browser",
                x,
                y,
                browser_width,
                top_height,
                json!({"assetCount": document.project.as_ref().map_or(0, |project| project.assets.len())}),
            ),
            panel(
                "preview",
                "Program Preview",
                x + browser_width,
                y,
                preview_width,
                top_height,
                json!({
                    "positionSeconds": document.playback.position_seconds,
                    "playing": document.playback.playing
                }),
            ),
            panel(
                "inspector",
                "Inspector",
                x + browser_width + preview_width,
                y,
                inspector_width,
                top_height,
                json!({"selectedItemIds": document.selection.item_ids}),
            ),
            panel(
                "timeline",
                "Timeline",
                x,
                y + top_height,
                width,
                height - top_height,
                json!({
                    "zoom": document.project.as_ref().map_or(1.0, |project| project.timeline.zoom),
                    "scrollSeconds": document.project.as_ref().map_or(0.0, |project| project.timeline.scroll_seconds),
                    "trackCount": document.project.as_ref().map_or(0, |project| project.timeline.tracks.len())
                }),
            ),
        ];
        if let Ok(mut snapshot) = self.snapshot.write() {
            *snapshot = UiSnapshot {
                captured_at_ms: now_ms(),
                window_title: "OpenCut".into(),
                window_bounds: UiRect {
                    x,
                    y,
                    width,
                    height,
                },
                window_focused: focused,
                active_panel,
                active_project_id: document.project.as_ref().map(|project| project.id.clone()),
                project_revision: document.revision,
                playhead_seconds: document.playback.position_seconds,
                playing: document.playback.playing,
                selected_asset_ids: document.selection.asset_ids.iter().cloned().collect(),
                selected_track_ids: document.selection.track_ids.iter().cloned().collect(),
                selected_item_ids: document.selection.item_ids.iter().cloned().collect(),
                selected_effect_ids: document.selection.effect_ids.iter().cloned().collect(),
                panels,
                mcp_http_configured: std::env::var_os("OPENCUT_MCP_HTTP_ADDR").is_some(),
                ui_capture_approved: capture_approved(),
            };
        }
    }
}

fn descriptor<I: JsonSchema, O: JsonSchema>(
    id: &str,
    title: &str,
    description: &str,
    access: AccessLevel,
    open_world: bool,
) -> CapabilityDescriptor {
    let mut descriptor = CapabilityDescriptor::read(
        id,
        title,
        description,
        "ui",
        serde_json::to_value(schema_for!(I)).expect("input schema"),
        serde_json::to_value(schema_for!(O)).expect("output schema"),
    );
    descriptor.access = access;
    descriptor.open_world = open_world;
    descriptor.tags = vec![
        "ui".into(),
        "window".into(),
        "panels".into(),
        "observation".into(),
    ];
    descriptor
}

fn capture_approved() -> bool {
    std::env::var("OPENCUT_MCP_UI_CAPTURE").is_ok_and(|value| value == "1")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
