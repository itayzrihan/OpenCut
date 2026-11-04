use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_generative_host,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};
async fn setup() -> (OpenCutRuntime, HostBridge, String) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_generative_host(&rt, &host).unwrap();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let pid = classic["document"]["metadata"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    rt.registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":pid,"expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    (rt, host, pid)
}
#[tokio::test]
async fn generative_mcp_import_and_prepare_are_canonical_but_cannot_approve() {
    let (rt, host, pid) = setup().await;
    let descriptor = rt
        .registry()
        .descriptor("project.generative.request")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.open_world);
    assert!(!descriptor.transactional);
    assert!(!descriptor.supports_dry_run);
    for action in ["approve", "unlock", "setup"] {
        assert!(rt.registry().invoke("project.generative.request",InvocationContext::default(),json!({"projectId":pid,"expectedRevision":rt.snapshot().unwrap().revision,"operationId":"x","operation":{"type":action,"pin":"000000"}})).await.is_err());
    }
    let args = json!({"projectId":pid,"expectedRevision":rt.snapshot().unwrap().revision,"operationId":"import-1","operation":{"type":"importReference","name":"board.png","mime":"image/png","dataBase64":"eA==","sha256":"a".repeat(64),"storyboard":true}});
    let mut future = std::pin::pin!(rt.registry().invoke(
        "project.generative.request",
        InvocationContext::default(),
        args.clone()
    ));
    assert!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "generativeReview");
    let reference = json!({"id":"a".repeat(32),"name":"board.png","mime":"image/png","kind":"image","bytes":1,"storyboard":true});
    host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":pid,"revision":args["expectedRevision"],"reference":reference,"job":null,"jobs":[]})}).unwrap();
    future.await.unwrap();
    let state = rt
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(
        state["value"]["project"]["extensions"]["generative"]["references"][0],
        reference
    );
    let rev = rt.snapshot().unwrap().revision;
    let prepare = json!({"projectId":pid,"expectedRevision":rev,"operationId":"prepare-1","operation":{"type":"prepare","kind":"video","model":"test/seedance","prompt":"Show the city then the mysterious forest.","duration":8,"resolution":"480p","aspectRatio":"9:16","referenceIds":["a".repeat(32)]}});
    let mut pending = std::pin::pin!(rt.registry().invoke(
        "project.generative.request",
        InvocationContext::default(),
        prepare
    ));
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert!(
        effect.request["operation"]["prompt"]
            .as_str()
            .unwrap()
            .contains("At most ONE")
    );
    host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":pid,"revision":rev,"reference":null,"job":{"id":"b".repeat(32),"digest":"c".repeat(64),"status":"review","mediaId":null},"jobs":[]})}).unwrap();
    pending.await.unwrap();
    let read = rt
        .registry()
        .invoke(
            "project.generative.read",
            InvocationContext::default(),
            json!({"projectId":pid}),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(read["document"]["jobs"][0]["status"], "review");
    assert!(
        rt.registry()
            .descriptor("project.generative.approve")
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn generative_mcp_rejects_stale_scope_and_dry_run_without_host_io() {
    let (rt, host, pid) = setup().await;
    for (project, rev, dry) in [
        (pid.clone(), 0, false),
        ("other".into(), rt.snapshot().unwrap().revision, false),
        (pid.clone(), rt.snapshot().unwrap().revision, true),
    ] {
        assert!(rt.registry().invoke("project.generative.request",InvocationContext{dry_run:dry,..Default::default()},json!({"projectId":project,"expectedRevision":rev,"operationId":"status-1","operation":{"type":"status"}})).await.is_err());
        assert!(host.pending().unwrap().is_empty());
    }
}
