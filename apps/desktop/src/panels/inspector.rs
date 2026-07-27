use gpui::{Context, Window, div, prelude::*};
use opencut_editor_api::OpenCutRuntime;

use crate::{panels::watch_runtime, theme::ActiveTheme};

pub(crate) struct Inspector {
    runtime: OpenCutRuntime,
}

impl Inspector {
    pub(crate) fn new(runtime: OpenCutRuntime, cx: &mut Context<Self>) -> Self {
        watch_runtime(&runtime, cx);
        Self { runtime }
    }
}

impl Render for Inspector {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let colors = window.theme().colors;
        let snapshot = self.runtime.snapshot().ok();
        let selected_id = snapshot
            .as_ref()
            .and_then(|state| state.selection.item_ids.first().map(String::as_str));
        let selected_item = snapshot
            .as_ref()
            .and_then(|state| state.project.as_ref())
            .and_then(|project| {
                project
                    .timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.items)
                    .find(|item| Some(item.id.as_str()) == selected_id)
            });

        let panel = div()
            .id("inspector")
            .flex()
            .flex_col()
            .w_1_4()
            .h_full()
            .gap_2()
            .p_3()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(colors.border)
            .bg(colors.card)
            .text_color(colors.card_foreground)
            .child("Inspector");

        if let Some(item) = selected_item {
            panel
                .child(format!("{} · {:?}", item.name, item.kind))
                .child(format!(
                    "{:.3}s — {:.3}s · {:.3}s",
                    item.start_seconds,
                    item.end_seconds(),
                    item.duration_seconds
                ))
                .child(format!(
                    "Position {:.1}, {:.1} · Scale {:.2}, {:.2} · Rotation {:.1}°",
                    item.transform.position_x,
                    item.transform.position_y,
                    item.transform.scale_x,
                    item.transform.scale_y,
                    item.transform.rotation_degrees
                ))
                .child(format!(
                    "Opacity {:.0}% · {} effect(s) · {} keyframe(s)",
                    item.opacity * 100.0,
                    item.effects.len(),
                    item.keyframes.len()
                ))
                .when_some(item.text.as_ref(), |panel, text| {
                    panel.child(format!("Text: {}", text.content))
                })
        } else {
            panel.child("Nothing selected")
        }
    }
}
