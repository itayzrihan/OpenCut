use opencut_editor_api::{
    register_editor_ui_capabilities, register_editor_ui_control, HostBridge, HostEffectResult,
    InvocationContext, OpenCutRuntime,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

async fn setup() -> (OpenCutRuntime, HostBridge, Value) {
    let runtime = OpenCutRuntime::full_access().unwrap();
    assert!(runtime
        .registry()
        .descriptor("editor.ui.snapshot")
        .unwrap()
        .is_none());
    let bridge = HostBridge::default();
    register_editor_ui_capabilities(&runtime, &bridge).unwrap();
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
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"limit":2,"query":"button"});
    (runtime, bridge, input)
}
#[tokio::test]
async fn scoped_ui_gesture_is_write_only_nontransactional_and_never_changes_document() {
    let (runtime, bridge, _) = setup().await;
    register_editor_ui_control(&runtime, &bridge).unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"snapshotId":"ui-fixture","targetId":"target-1","gesture":{"type":"click"}});
    let before = runtime.snapshot().unwrap();
    let descriptor = runtime
        .registry()
        .descriptor("editor.ui.control")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, opencut_editor_api::AccessLevel::Write);
    assert!(!descriptor.transactional && !descriptor.open_world && !descriptor.supports_dry_run);
    assert!(descriptor.cancellable);
    let mut pending = std::pin::pin!(runtime.registry().invoke(
        "editor.ui.control",
        InvocationContext::default(),
        input.clone()
    ));
    assert!(pending
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending());
    let effect = bridge.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "editorUiControl");
    assert_eq!(effect.request, input);
    let output = json!({"projectId":input["projectId"],"revision":input["expectedRevision"],"snapshotId":"ui-fixture","targetId":"target-1","performed":true,"transport":"ownedPlaywright"});
    bridge
        .settle(
            effect.id,
            HostEffectResult::Success {
                data: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(pending.await.unwrap().result.data, output);
    assert_eq!(runtime.snapshot().unwrap(), before);
    for gesture in [
        json!({"type":"key","key":"Control+Delete"}),
        json!({"type":"scroll","x":2001,"y":0}),
        json!({"type":"fill","text":"x".repeat(2001)}),
        json!({"type":"click","selector":"body"}),
    ] {
        let mut invalid = input.clone();
        invalid["gesture"] = gesture;
        assert!(runtime
            .registry()
            .invoke("editor.ui.control", InvocationContext::default(), invalid)
            .await
            .is_err());
        assert!(bridge.pending().unwrap().is_empty());
    }
    let cancel = InvocationContext::default();
    cancel.cancellation.cancel();
    assert!(runtime
        .registry()
        .invoke("editor.ui.control", cancel, input)
        .await
        .is_err());
    assert!(bridge.pending().unwrap().is_empty());
}
fn snapshot(input: &Value) -> HostEffectResult {
    HostEffectResult::Success {
        data: json!({"projectId":input["projectId"],"revision":input["expectedRevision"],"nodes":[
        {"role":"button","name":"פיצ׳ר חדש","disabled":false,"focused":false,"selected":null,"checked":null,"expanded":null,
        "bounds":{"x":10,"y":20,"width":100,"height":30},
        "action":{"capabilityId":"timeline.classic.track.update","input":{"projectId":input["projectId"],"expectedRevision":input["expectedRevision"],"sceneId":"main-scene","trackId":"video-track","change":{"type":"toggleMute"}}}}
    ],"truncated":false,"scanned":1}),
    }
}
#[tokio::test]
async fn snapshot_is_host_installed_schema_validated_and_read_only() {
    let (runtime, bridge, input) = setup().await;
    let before = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data;
    let descriptor = runtime
        .registry()
        .descriptor("editor.ui.snapshot")
        .unwrap()
        .unwrap();
    assert!(bridge.supports(&descriptor));
    assert!(!descriptor.open_world && !descriptor.transactional);
    assert_eq!(descriptor.access, opencut_editor_api::AccessLevel::Read);
    let mut pending = std::pin::pin!(runtime.registry().invoke(
        "editor.ui.snapshot",
        InvocationContext::default(),
        input.clone()
    ));
    assert!(pending
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending());
    let effect = bridge.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "editorUi");
    assert_eq!(effect.project_id, "classic-project");
    assert_eq!(effect.request, input);
    assert!(bridge
        .settle(
            effect.id,
            HostEffectResult::Success {
                data: json!({"nodes":[]})
            }
        )
        .is_err());
    assert_eq!(bridge.pending().unwrap().len(), 1);
    bridge.settle(effect.id, snapshot(&input)).unwrap();
    let result = pending.await.unwrap().result.data;
    assert_eq!(result["nodes"][0]["name"], "פיצ׳ר חדש");
    let after = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(before, after);
}
#[tokio::test]
async fn invalid_or_cancelled_observation_never_reaches_the_host() {
    let (runtime, bridge, input) = setup().await;
    for (key, value) in [
        ("projectId", json!("other")),
        ("expectedRevision", json!(0)),
        ("limit", json!(0)),
        ("limit", json!(201)),
        ("query", json!("x".repeat(201))),
        ("selector", json!("body")),
    ] {
        let mut bad = input.clone();
        bad[key] = value;
        assert!(runtime
            .registry()
            .invoke("editor.ui.snapshot", InvocationContext::default(), bad)
            .await
            .is_err());
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
        assert!(runtime
            .registry()
            .invoke("editor.ui.snapshot", context, input.clone())
            .await
            .is_err());
        assert!(bridge.pending().unwrap().is_empty());
    }
}
#[tokio::test]
async fn stale_cancelled_and_mis_scoped_host_results_are_rejected() {
    for mode in 0..8 {
        let (runtime, bridge, input) = setup().await;
        let context = InvocationContext::default();
        let cancel = context.cancellation.clone();
        let mut pending =
            std::pin::pin!(runtime
                .registry()
                .invoke("editor.ui.snapshot", context, input.clone()));
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        let effect = bridge.pending().unwrap().pop().unwrap();
        let mut output = snapshot(&input);
        if mode == 0 {
            runtime.registry().invoke("project.classic.settings.update", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":input["expectedRevision"],"settings":{"fps":{"numerator":30,"denominator":1}}})).await.unwrap();
        } else if mode == 1 {
            cancel.cancel();
        } else if let HostEffectResult::Success { data } = &mut output {
            match mode {
                2 => data["projectId"] = json!("other"),
                3 => data["revision"] = json!(0),
                4 => data["nodes"] = json!([data["nodes"][0], data["nodes"][0], data["nodes"][0]]),
                5 => data["nodes"][0]["action"]["input"]["projectId"] = json!("other"),
                6 => data["nodes"][0]["action"]["input"]["expectedRevision"] = json!(0),
                _ => data["nodes"][0]["action"]["input"]["large"] = json!("x".repeat(16001)),
            }
        }
        bridge.settle(effect.id, output).unwrap();
        assert!(pending.await.is_err());
        assert!(bridge.pending().unwrap().is_empty());
    }
}
