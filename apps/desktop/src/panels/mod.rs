mod browser;
mod inspector;
mod preview;
mod timeline;

use gpui::Context;
use opencut_editor_api::OpenCutRuntime;

pub(crate) use browser::Browser;
pub(crate) use inspector::Inspector;
pub(crate) use preview::Preview;
pub(crate) use timeline::Timeline;

fn watch_runtime<T: 'static>(runtime: &OpenCutRuntime, cx: &mut Context<T>) {
    let mut revisions = runtime.subscribe_state();
    cx.spawn(async move |panel, cx| {
        loop {
            if revisions.recv().await.is_err() {
                break;
            }
            if panel.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        }
    })
    .detach();
}
