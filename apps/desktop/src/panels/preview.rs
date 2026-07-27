use std::sync::Arc;

use gpui::{Context, Image, ImageFormat, ObjectFit, StyledImage, Window, div, img, prelude::*};
use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::json;

use crate::theme::ActiveTheme;

pub(crate) struct Preview {
    runtime: OpenCutRuntime,
    frame: Option<Arc<Image>>,
    frame_error: Option<String>,
}

impl Preview {
    pub(crate) fn new(runtime: OpenCutRuntime, cx: &mut Context<Self>) -> Self {
        let mut revisions = runtime.subscribe_state();
        let capture_runtime = runtime.clone();
        cx.spawn(async move |panel, cx| {
            loop {
                if revisions.recv().await.is_err() {
                    break;
                }
                let result = capture_runtime
                    .registry()
                    .invoke(
                        "preview.frame.capture",
                        InvocationContext {
                            source: "desktop.preview".into(),
                            ..Default::default()
                        },
                        json!({}),
                    )
                    .await;
                let update = match result {
                    Ok(receipt) => receipt
                        .result
                        .artifacts
                        .first()
                        .and_then(|artifact| capture_runtime.artifacts().get(&artifact.uri).ok())
                        .map(|artifact| {
                            (
                                Some(Arc::new(Image::from_bytes(
                                    ImageFormat::Png,
                                    artifact.bytes.to_vec(),
                                ))),
                                None,
                            )
                        })
                        .unwrap_or_else(|| {
                            (None, Some("Preview capture returned no image".into()))
                        }),
                    Err(error) => (None, Some(error.to_string())),
                };
                if panel
                    .update(cx, |panel, cx| {
                        panel.frame = update.0;
                        panel.frame_error = update.1;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            runtime,
            frame: None,
            frame_error: None,
        }
    }
}

impl Render for Preview {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let colors = window.theme().colors;
        let snapshot = self.runtime.snapshot().ok();
        let position = snapshot
            .as_ref()
            .map(|state| state.playback.position_seconds)
            .unwrap_or_default();
        let active_layers = snapshot
            .as_ref()
            .and_then(|state| state.project.as_ref())
            .map(|project| {
                project
                    .timeline
                    .tracks
                    .iter()
                    .filter(|track| track.enabled && !track.hidden)
                    .flat_map(|track| &track.items)
                    .filter(|item| {
                        item.enabled
                            && item.start_seconds <= position
                            && item.end_seconds() >= position
                    })
                    .count()
            })
            .unwrap_or_default();
        let content = if let Some(frame) = &self.frame {
            img(frame.clone())
                .object_fit(ObjectFit::Contain)
                .size_full()
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(
                    self.frame_error
                        .clone()
                        .unwrap_or_else(|| "Preview is ready when the timeline has content".into()),
                )
                .into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .w_1_2()
            .h_full()
            .gap_2()
            .items_center()
            .justify_center()
            .bg(colors.background)
            .child(div().text_xl().child("Program preview"))
            .child(div().flex_1().w_full().child(content))
            .child(format!("{position:.3}s · {active_layers} active layer(s)"))
    }
}
