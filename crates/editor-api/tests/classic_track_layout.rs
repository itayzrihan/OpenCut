use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.tracks.layout";

async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic}),
    )
    .await;
    runtime
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
fn request(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project", "sceneId":"main-scene", "expectedRevision":state["revision"], "change":change})
}

#[tokio::test]
async fn all_track_types_use_expected_defaults_and_preserve_sources_history_and_retry_identity() {
    for kind in ["video", "text", "graphic", "effect", "audio", "parallax"] {
        let runtime = attached().await;
        let before = read(&runtime).await;
        let input = request(
            &before,
            json!({"type":"add", "trackId":"new-track", "trackType":kind}),
        );
        let mut context = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("add-track"));
        runtime
            .registry()
            .invoke(ID, context.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(read(&runtime).await, before);
        context.dry_run = false;
        let receipt = runtime
            .registry()
            .invoke(ID, context.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(
            runtime.registry().invoke(ID, context, input).await.unwrap(),
            receipt
        );
        let after = read(&runtime).await;
        let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
        let added = if kind == "audio" {
            &tracks["audio"][0]
        } else if matches!(kind, "effect" | "parallax") {
            &tracks["overlay"][0]
        } else {
            &tracks["overlay"][1]
        };
        assert_eq!(added["id"], "new-track");
        assert_eq!(added["type"], kind);
        assert_eq!(added["elements"], json!([]));
        assert_eq!(added["keepEmpty"], true);
        if kind == "parallax" {
            assert_eq!(added["speedPercent"], 35);
            assert_eq!(added["direction"], "against-camera");
        }
        let order = if matches!(kind, "effect" | "parallax") {
            json!(["new-track", "titles", "video-track"])
        } else {
            json!(["titles", "video-track", "new-track"])
        };
        assert_eq!(tracks["order"], order);
        let mut expected = before["project"]["classic"].clone();
        expected["document"]["scenes"][0]["tracks"] = tracks.clone();
        assert_eq!(after["project"]["classic"], expected);
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], before["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], after["project"]);
    }
}

#[tokio::test]
async fn layout_rejects_cross_scene_id_collisions_invalid_types_and_stale_or_cancelled_writes() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for change in [
        json!({"type":"add", "trackId":"titles", "trackType":"audio"}),
        json!({"type":"add", "trackId":"other-main", "trackType":"text"}),
        json!({"type":"add", "trackId":"text-1", "trackType":"video"}),
        json!({"type":"add", "trackId":"new-track", "trackType":"unknown"}),
        json!({"type":"add", "trackId":"new-track", "trackType":"audio", "name":" "}),
        json!({"type":"add", "trackId":"new-track", "trackType":"audio", "index":1.5}),
        json!({"type":"reorder", "trackId":"other-main", "toIndex":0}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), request(&before, change))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let mut input = request(
        &before,
        json!({"type":"add", "trackId":"new-track", "trackType":"parallax"}),
    );
    input["sceneId"] = json!("other-scene");
    assert!(
        runtime
            .registry()
            .invoke(ID, InvocationContext::default(), input)
            .await
            .is_err()
    );
    let input = request(
        &before,
        json!({"type":"reorder", "trackId":"video-track", "toIndex":0}),
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(ID, cancelled, input.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(&runtime, ID, input.clone()).await;
    assert!(
        runtime
            .registry()
            .invoke(ID, InvocationContext::default(), input)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn reorder_clamps_indices_and_keeps_main_identity_and_all_track_content() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    call(
        &runtime,
        ID,
        request(
            &before,
            json!({"type":"reorder", "trackId":"video-track", "toIndex":-100}),
        ),
    )
    .await;
    let middle = read(&runtime).await;
    let mut expected = before["project"].clone();
    expected["classic"]["document"]["scenes"][0]["tracks"]["order"] =
        json!(["video-track", "titles"]);
    assert_eq!(middle["project"], expected);
    call(
        &runtime,
        ID,
        request(
            &middle,
            json!({"type":"reorder", "trackId":"video-track", "toIndex":100}),
        ),
    )
    .await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
}
