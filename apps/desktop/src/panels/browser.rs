use gpui::{Context, Window, div, prelude::*};
use opencut_editor_api::OpenCutRuntime;

use crate::{panels::watch_runtime, theme::ActiveTheme};

pub(crate) struct Browser {
    runtime: OpenCutRuntime,
}

impl Browser {
    pub(crate) fn new(runtime: OpenCutRuntime, cx: &mut Context<Self>) -> Self {
        watch_runtime(&runtime, cx);
        Self { runtime }
    }
}

impl Render for Browser {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let colors = window.theme().colors;
        let snapshot = self.runtime.snapshot().ok();
        let assets = snapshot
            .as_ref()
            .and_then(|state| state.project.as_ref())
            .map(|project| project.assets.as_slice())
            .unwrap_or_default();

        div()
            .id("media-browser")
            .flex()
            .flex_col()
            .w_1_4()
            .h_full()
            .gap_2()
            .p_3()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(colors.sidebar_border)
            .bg(colors.sidebar)
            .text_color(colors.sidebar_foreground)
            .child(
                div()
                    .text_sm()
                    .child(format!("Media · {} asset(s)", assets.len())),
            )
            .children(assets.iter().map(|asset| {
                div()
                    .p_2()
                    .bg(colors.card)
                    .child(format!("{} · {:?}", asset.name, asset.media_type))
            }))
    }
}
