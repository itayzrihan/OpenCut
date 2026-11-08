use opencut_editor_api::{register_peer_media, AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime};
use serde_json::{json, Value};
use std::{future::Future, task::{Context, Waker}};

async fn setup() -> (OpenCutRuntime, HostBridge, Value) {
    let runtime = OpenCutRuntime::full_access().unwrap(); let bridge = HostBridge::default();
    register_peer_media(&runtime, &bridge).unwrap();
    let mut classic: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"].as_array_mut().unwrap().push(json!({"id":"offline","name":"Original","type":"video","size":10,"missing":true,"bindingRevision":2}));
    runtime.registry().invoke("project.classic.session.attach", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":0,"classic":classic})).await.unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"mediaId":"offline","deviceId":"laptop","operationId":"pull-1","expectedBindingRevision":2});
    (runtime, bridge, input)
}
#[tokio::test]
async fn discovery_and_host_reply_keep_the_document_exact() {
    let (runtime, bridge, input) = setup().await; let before = runtime.snapshot().unwrap();
    for id in ["media.devices.list", "media.transfer.list", "media.transfer.start", "media.transfer.status", "media.transfer.cancel", "media.transfer.commit"] {
        let d = runtime.registry().descriptor(id).unwrap().unwrap();
        assert_eq!(d.access, AccessLevel::Write); assert!(d.open_world && d.cancellable && d.idempotent);
        assert!(!d.transactional && !d.supports_dry_run);
    }
    let mut pending = std::pin::pin!(runtime.registry().invoke("media.transfer.start", InvocationContext::default(), input.clone()));
    assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    let effect = bridge.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "peerMedia"); assert_eq!(effect.request["operation"], "start");
    let reply = json!({"projectId":"classic-project","revision":before.revision,"devices":[],"jobs":[],"linked":false,
        "job":{"projectId":"classic-project","operationId":"pull-1","mediaId":"offline","deviceId":"laptop","expectedBindingRevision":2,"status":"running","phase":"downloading","receivedBytes":3,"totalBytes":10,"error":null}});
    bridge.settle(effect.id, HostEffectResult::Success { data: reply.clone() }).unwrap();
    assert_eq!(pending.await.unwrap().result.data, reply);
    let read = runtime.registry().invoke("app.state.read", InvocationContext::default(), json!({})).await.unwrap();
    assert_eq!(read.result.data["value"]["project"]["classic"]["mediaAssets"], serde_json::to_value(before.project.as_ref().unwrap().classic.as_ref().unwrap().media_assets.clone()).unwrap());
    assert_eq!(runtime.snapshot().unwrap(), before);
}
#[tokio::test]
async fn invalid_project_revision_binding_and_identity_never_start_network_io() {
    let (runtime, bridge, input) = setup().await;
    for patch in [json!({"projectId":"other"}), json!({"expectedRevision":0}), json!({"mediaId":"other"}), json!({"expectedBindingRevision":3}), json!({"deviceId":"../outside"}), json!({"operationId":null})] {
        let mut bad = input.clone(); bad.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        assert!(runtime.registry().invoke("media.transfer.start", InvocationContext::default(), bad).await.is_err());
        assert!(bridge.pending().unwrap().is_empty());
    }
    let context = InvocationContext { dry_run: true, ..Default::default() };
    assert!(runtime.registry().invoke("media.transfer.start", context, input).await.is_err());
    assert!(bridge.pending().unwrap().is_empty());
}
#[tokio::test]
async fn rejects_cross_project_host_results_without_changing_state() {
    let (runtime, bridge, input) = setup().await; let before = runtime.snapshot().unwrap();
    let mut pending = std::pin::pin!(runtime.registry().invoke("media.transfer.start", InvocationContext::default(), input));
    assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    let effect = bridge.pending().unwrap().pop().unwrap();
    bridge.settle(effect.id, HostEffectResult::Success { data: json!({"projectId":"other","revision":before.revision,"devices":[],"jobs":[],"job":null,"linked":false}) }).unwrap();
    assert!(pending.await.is_err()); assert_eq!(runtime.snapshot().unwrap(), before);
}
