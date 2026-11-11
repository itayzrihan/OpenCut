use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

async fn invoke(runtime: &OpenCutRuntime, capability: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(capability, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}

async fn speed(runtime: &OpenCutRuntime, revision: Value, change: &str) -> Value {
    invoke(
        runtime,
        "playback.classic.speed.change",
        json!({
            "projectId":"classic-project", "expectedRevision":revision, "change":change,
        }),
    )
    .await
}

#[tokio::test]
async fn shuttle_cycles_and_preserves_content_history() {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let attach = invoke(
        &runtime,
        "project.classic.session.attach",
        json!({
            "projectId":"classic-project", "expectedRevision":0, "classic":classic,
        }),
    )
    .await;
    let revision = attach["revision"].clone();
    let descriptor = runtime
        .registry()
        .descriptor("playback.classic.speed.change")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.supports_dry_run && !descriptor.transactional && !descriptor.open_world);
    let request =
        json!({"projectId":"classic-project","expectedRevision":revision,"change":"faster"});
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("l-1"));
    let dry_run = runtime
        .registry()
        .invoke(
            "playback.classic.speed.change",
            context.clone(),
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(dry_run.result.data["rate"], 1.5);
    assert_eq!(
        invoke(
            &runtime,
            "app.state.read",
            json!({"pointer":"/playback/rate"})
        )
        .await["value"],
        1.0
    );
    context.dry_run = false;
    let receipt = runtime
        .registry()
        .invoke(
            "playback.classic.speed.change",
            context.clone(),
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke("playback.classic.speed.change", context, request)
            .await
            .unwrap(),
        receipt
    );
    for expected in [2.0, 3.0, 4.0, 1.0] {
        let result = speed(&runtime, revision.clone(), "faster").await;
        assert_eq!(result["rate"], expected);
        assert_eq!(result["revision"], revision);
    }
    assert_eq!(
        speed(&runtime, revision.clone(), "slower").await["rate"],
        1.0
    );
    speed(&runtime, revision.clone(), "faster").await;
    speed(&runtime, revision.clone(), "faster").await;
    assert_eq!(
        speed(&runtime, revision.clone(), "slower").await["rate"],
        1.5
    );
    assert_eq!(
        speed(&runtime, revision.clone(), "normal").await["rate"],
        1.0
    );
    assert!(
        runtime
            .registry()
            .invoke("history.undo", InvocationContext::default(), json!({}))
            .await
            .is_err()
    );
    let rename = invoke(&runtime, "media.classic.rename", json!({"projectId":"classic-project", "expectedRevision":revision, "mediaId":"video-asset", "name":"Edited"})).await;
    assert!(runtime.registry().invoke("playback.classic.speed.change", InvocationContext::default(), json!({"projectId":"classic-project", "expectedRevision":revision, "change":"faster"})).await.is_err());
    speed(&runtime, rename["revision"].clone(), "faster").await;
    invoke(&runtime, "history.undo", json!({})).await;
    let state = invoke(&runtime, "app.state.read", json!({})).await;
    assert_eq!(state["value"]["playback"]["rate"], 1.5);
    assert_eq!(
        state["value"]["project"]["classic"]["mediaAssets"][0]["name"],
        "Footage"
    );
    invoke(&runtime, "history.redo", json!({})).await;
    assert_eq!(
        invoke(
            &runtime,
            "app.state.read",
            json!({"pointer":"/playback/rate"})
        )
        .await["value"],
        1.5
    );
}
