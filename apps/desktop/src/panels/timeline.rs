use gpui::{Context, Window, div, prelude::*};
use opencut_editor_api::OpenCutRuntime;

use crate::{panels::watch_runtime, theme::ActiveTheme};

pub(crate) struct Timeline {
    runtime: OpenCutRuntime,
}

impl Timeline {
    pub(crate) fn new(runtime: OpenCutRuntime, cx: &mut Context<Self>) -> Self {
        watch_runtime(&runtime, cx);
        Self { runtime }
    }
}

impl Render for Timeline {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let colors = window.theme().colors;
        let snapshot = self.runtime.snapshot().ok();
        let position = snapshot
            .as_ref()
            .map(|state| state.playback.position_seconds)
            .unwrap_or_default();
        let tracks = snapshot
            .as_ref()
            .and_then(|state| state.project.as_ref())
            .map(|project| project.timeline.tracks.as_slice())
            .unwrap_or_default();

        div()
            .id("timeline")
            .flex()
            .flex_col()
            .h_1_3()
            .gap_1()
            .p_2()
            .overflow_y_scroll()
            .bg(colors.card)
            .text_color(colors.card_foreground)
            .child(format!(
                "Timeline · {:.3}s · {} track(s)",
                position,
                tracks.len()
            ))
            .children(tracks.iter().map(|track| {
                div()
                    .flex()
                    .gap_2()
                    .p_1()
                    .border_b_1()
                    .border_color(colors.border)
                    .child(format!("{} [{:?}]", track.name, track.kind))
                    .children(track.items.iter().map(|item| {
                        let text = item
                            .text
                            .as_ref()
                            .map(|text| format!(" · “{}”", text.content))
                            .unwrap_or_default();
                        div().bg(colors.background).p_1().child(format!(
                            "{} {:.2}–{:.2}{}",
                            item.name,
                            item.start_seconds,
                            item.end_seconds(),
                            text
                        ))
                    }))
            }))
    }
}
