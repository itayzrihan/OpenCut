use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn asset() -> Value {
    json!({"id":"import-video","name":"Imported video","type":"video","size":42,"fps":59.94,"duration":3.5,"width":1920,"height":1080,"future":{"nested":true}})
}
fn input(state: &Value, assets: Value) -> Value {
    json!({"projectId":"classic-project","expectedRevision":state["revision"],"assets":assets})
}
#[tokio::test]
async fn registration_preserves_extensions_raises_rational_fps_and_has_one_undoable_dry_run_retry()
{
    let runtime = attached().await;
    let before = read(&runtime).await;
    let descriptor = runtime
        .registry()
        .descriptor("media.classic.register")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(descriptor.transactional && descriptor.supports_dry_run && !descriptor.open_world);
    let request = input(&before, json!([asset()]));
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("register-once"));
    runtime
        .registry()
        .invoke("media.classic.register", context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let receipt = runtime
        .registry()
        .invoke("media.classic.register", context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke("media.classic.register", context, request)
            .await
            .unwrap(),
        receipt
    );
    let after = read(&runtime).await;
    assert_eq!(
        after["project"]["classic"]["mediaAssets"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        &asset()
    );
    assert_eq!(
        after["project"]["classic"]["document"]["settings"]["fps"],
        json!({"numerator":60000,"denominator":1001})
    );
    assert_eq!(
        after["project"]["classic"]["document"]["settings"]["canvasSize"],
        before["project"]["classic"]["document"]["settings"]["canvasSize"]
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}
#[tokio::test]
async fn invalid_duplicate_stale_foreign_cancelled_or_transient_batches_publish_nothing() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let mut requests = vec![
        input(&before, json!([])),
        input(&before, json!([asset(), asset()])),
    ];
    for (key, value) in [
        ("id", json!("video-asset")),
        ("fps", json!(0)),
        ("size", json!(-1)),
        ("width", json!(0)),
        ("type", json!("other")),
        ("file", json!({})),
        ("url", json!("blob:bad")),
        ("generation", json!({"artifactId":"bad"})),
    ] {
        let mut bad = asset();
        bad[key] = value;
        requests.push(input(&before, json!([asset(), bad])));
    }
    let mut stale = input(&before, json!([asset()]));
    stale["expectedRevision"] = json!(0);
    requests.push(stale);
    let mut foreign = input(&before, json!([asset()]));
    foreign["projectId"] = json!("foreign");
    requests.push(foreign);
    for request in requests {
        assert!(
            runtime
                .registry()
                .invoke(
                    "media.classic.register",
                    InvocationContext::default(),
                    request
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(
                "media.classic.register",
                context,
                input(&before, json!([asset()]))
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}
#[tokio::test]
async fn nonvideo_or_lower_fps_does_not_change_project_clock_and_portable_history_reopens() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let mut image = asset();
    image["id"] = json!("image");
    image["type"] = json!("image");
    image["fps"] = json!(120);
    let mut video = asset();
    video["fps"] = json!(12);
    call(
        &runtime,
        "media.classic.register",
        input(&before, json!([image, video])),
    )
    .await;
    let after = read(&runtime).await;
    assert_eq!(
        after["project"]["classic"]["document"]["settings"]["fps"],
        before["project"]["classic"]["document"]["settings"]["fps"]
    );
    let archive = runtime.serialize_application_state().unwrap();
    let reopened = OpenCutRuntime::default();
    reopened
        .restore_application_state_from_bytes(&archive)
        .unwrap();
    assert_eq!(read(&reopened).await["project"], after["project"]);
}
