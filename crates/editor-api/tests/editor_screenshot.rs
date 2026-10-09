use opencut_editor_api::{
    HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_editor_screenshot_capability,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};

async fn setup() -> (OpenCutRuntime, HostBridge, Value) {
    let runtime = OpenCutRuntime::full_access().unwrap();
    assert!(
        runtime
            .registry()
            .descriptor("editor.ui.screenshot")
            .unwrap()
            .is_none()
    );
    let bridge = HostBridge::default();
    register_editor_screenshot_capability(&runtime, &bridge).unwrap();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision});
    (runtime, bridge, input)
}

#[tokio::test]
async fn desktop_screenshot_returns_a_verified_artifact_without_editing() {
    let (runtime, bridge, input) = setup().await;
    let before = runtime.snapshot().unwrap();
    let descriptor = runtime
        .registry()
        .descriptor("editor.ui.screenshot")
        .unwrap()
        .unwrap();
    assert!(bridge.supports(&descriptor));
    assert!(!descriptor.open_world && !descriptor.transactional);
    assert_eq!(descriptor.access, opencut_editor_api::AccessLevel::Read);
    let mut pending = std::pin::pin!(runtime.registry().invoke(
        "editor.ui.screenshot",
        InvocationContext::default(),
        input.clone()
    ));
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = bridge.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "editorScreenshot");
    assert_eq!(effect.request, input);
    let artifact = runtime
        .artifacts()
        .put(
            vec![255, 216, 255, 224],
            "image/jpeg",
            Some(100),
            Some(50),
            None,
        )
        .unwrap();
    bridge.settle(effect.id, HostEffectResult::Success { data: json!({"projectId":"classic-project","revision":input["expectedRevision"],"artifact":artifact}) }).unwrap();
    let receipt = pending.await.unwrap();
    assert_eq!(receipt.result.artifacts, vec![artifact]);
    assert_eq!(
        serde_json::to_value(runtime.snapshot().unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
}

#[tokio::test]
async fn screenshot_rejects_stale_cancelled_spoofed_and_missing_artifacts() {
    for mode in 0..10 {
        let (runtime, bridge, input) = setup().await;
        let context = InvocationContext::default();
        let cancel = context.cancellation.clone();
        let mut pending = std::pin::pin!(runtime.registry().invoke(
            "editor.ui.screenshot",
            context,
            input.clone()
        ));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = bridge.pending().unwrap().pop().unwrap();
        let artifact = runtime
            .artifacts()
            .put(
                if mode == 8 {
                    vec![0, 0, 0]
                } else {
                    vec![255, 216, 255, 224]
                },
                if mode == 5 { "image/png" } else { "image/jpeg" },
                Some(if mode == 6 { 4096 } else { 100 }),
                Some(50),
                None,
            )
            .unwrap();
        let mut output = json!({"projectId":"classic-project","revision":input["expectedRevision"],"artifact":artifact});
        match mode {
            0 => {
                runtime.registry().invoke("project.classic.settings.update", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":input["expectedRevision"],"settings":{"fps":{"numerator":30,"denominator":1}}})).await.unwrap();
            }
            1 => cancel.cancel(),
            2 => output["projectId"] = json!("other"),
            3 => output["revision"] = json!(0),
            4 => output["artifact"]["sha256"] = json!("fake"),
            7 => {
                runtime.artifacts().remove(&artifact.uri).unwrap();
            }
            9 => output["artifact"]["uri"] = json!("C:/arbitrary/path"),
            _ => {}
        }
        bridge
            .settle(effect.id, HostEffectResult::Success { data: output })
            .unwrap();
        assert!(pending.await.is_err(), "mode {mode}");
    }
}

#[tokio::test]
async fn screenshot_rejects_invalid_input_before_host_io() {
    let (runtime, bridge, input) = setup().await;
    for (key, value) in [
        ("projectId", json!("other")),
        ("expectedRevision", json!(0)),
        ("selector", json!("body")),
        ("path", json!("C:/output.jpg")),
    ] {
        let mut bad = input.clone();
        bad[key] = value;
        assert!(
            runtime
                .registry()
                .invoke("editor.ui.screenshot", InvocationContext::default(), bad)
                .await
                .is_err()
        );
        assert!(bridge.pending().unwrap().is_empty());
    }
    for mode in 0..3 {
        let mut context = InvocationContext::default();
        match mode {
            0 => context.dry_run = true,
            1 => context.cancellation.cancel(),
            _ => {
                context
                    .metadata
                    .insert("opencut/projectId".into(), json!("other"));
            }
        }
        assert!(
            runtime
                .registry()
                .invoke("editor.ui.screenshot", context, input.clone())
                .await
                .is_err()
        );
        assert!(bridge.pending().unwrap().is_empty());
    }
}
