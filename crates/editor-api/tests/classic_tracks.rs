use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const ID: &str = "timeline.classic.track.update";

async fn parallax_runtime() -> OpenCutRuntime {
    let runtime = attached().await;
    let before = read(&runtime).await;
    call(&runtime, "timeline.classic.tracks.layout", json!({
        "projectId":"classic-project", "sceneId":"main-scene", "expectedRevision":before["revision"],
        "change":{"type":"add","trackId":"depth","trackType":"parallax"}
    })).await;
    runtime
}

#[tokio::test]
async fn parallax_controls_share_clamping_and_preserve_state_preview_retry_and_history() {
    for (change, expected) in [
        (
            json!({"type":"parallax","direction":"with-camera","speedPercent":850}),
            json!({"direction":"with-camera","speedPercent":400.0}),
        ),
        (
            json!({"type":"parallax","speedPercent":-10}),
            json!({"speedPercent":0.0}),
        ),
        (
            json!({"type":"parallax","speedPercent":37.5}),
            json!({"speedPercent":37.5}),
        ),
        (
            json!({"type":"parallax","direction":"with-camera"}),
            json!({"direction":"with-camera"}),
        ),
    ] {
        let runtime = parallax_runtime().await;
        let before = read(&runtime).await;
        let request = input(&before, "depth", change);
        let mut context = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("parallax-once"));
        runtime
            .registry()
            .invoke(ID, context.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(read(&runtime).await, before);
        context.dry_run = false;
        let receipt = runtime
            .registry()
            .invoke(ID, context.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(
            runtime
                .registry()
                .invoke(ID, context, request.clone())
                .await
                .unwrap(),
            receipt
        );
        let after = read(&runtime).await;
        let mut expected_project = before["project"].clone();
        let marker =
            &mut expected_project["classic"]["document"]["scenes"][0]["tracks"]["overlay"][0];
        for (key, value) in expected.as_object().unwrap() {
            marker[key] = value.clone();
        }
        assert_eq!(after["project"], expected_project);
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), request)
                .await
                .is_err()
        );
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], before["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], after["project"]);
    }
}

#[tokio::test]
async fn invalid_parallax_controls_and_document_fallback_are_atomic() {
    let runtime = parallax_runtime().await;
    let before = read(&runtime).await;
    for (track, change) in [
        ("depth", json!({"type":"parallax"})),
        ("depth", json!({"type":"parallax","direction":"sideways"})),
        ("depth", json!({"type":"parallax","speedPercent":"fast"})),
        ("depth", json!({"type":"parallax","speedPercent":null})),
        (
            "depth",
            json!({"type":"parallax","direction":"with-camera","hidden":true}),
        ),
        ("titles", json!({"type":"parallax","speedPercent":50})),
        ("video-track", json!({"type":"parallax","speedPercent":50})),
        ("other-main", json!({"type":"parallax","speedPercent":50})),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    ID,
                    InvocationContext::default(),
                    input(&before, track, change)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let request = input(
        &before,
        "depth",
        json!({"type":"parallax","speedPercent":50}),
    );
    for (field, value) in [
        ("sceneId", json!("other-scene")),
        ("projectId", json!("foreign")),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = request.clone();
        invalid[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), invalid)
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(ID, cancelled, request)
            .await
            .is_err()
    );
    for (path,value) in [
        ("/document/scenes/0/tracks/overlay/0/speedPercent",json!(401)),
        ("/document/scenes/0/tracks/overlay/0/direction",json!("sideways")),
        ("/document/scenes/0/tracks/overlay/0/elements",before["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][1]["elements"].clone()),
        ("/document/scenes/0/parallax",Value::Null),
    ] {
        let mut classic = before["project"]["classic"].clone();
        *classic.pointer_mut(path).unwrap() = value;
        assert!(runtime.registry().invoke("project.classic.synchronize", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":before["revision"],"classic":classic})).await.is_err());
        assert_eq!(read(&runtime).await, before);
    }
}
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
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["audio"] = json!([
        {"id":"music", "name":"Music", "type":"audio", "elements":[], "muted":false}
    ]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({
            "projectId":"classic-project", "expectedRevision":0, "classic":classic
        }),
    )
    .await;
    runtime
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
fn input(state: &Value, track: &str, change: Value) -> Value {
    json!({"projectId":"classic-project", "sceneId":"main-scene", "trackId":track,
        "expectedRevision":state["revision"], "change":change})
}

#[tokio::test]
async fn track_controls_preserve_the_document_and_support_preview_retries_and_history() {
    for (track, change, expected) in [
        (
            "video-track",
            json!({"type":"set", "name":"סרטון", "muted":true, "hidden":true}),
            json!({"name":"סרטון", "muted":true, "hidden":true}),
        ),
        (
            "titles",
            json!({"type":"toggleVisibility"}),
            json!({"hidden":true}),
        ),
        ("music", json!({"type":"toggleMute"}), json!({"muted":true})),
    ] {
        let runtime = attached().await;
        let before = read(&runtime).await;
        let request = input(&before, track, change);
        let descriptor = runtime.registry().descriptor(ID).unwrap().unwrap();
        assert_eq!(descriptor.access, AccessLevel::Write);
        assert_eq!(descriptor.document_support, DocumentSupport::Classic);
        assert!(descriptor.supports_dry_run && descriptor.transactional && !descriptor.open_world);
        let mut context = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("track-change"));
        assert_eq!(
            runtime
                .registry()
                .invoke(ID, context.clone(), request.clone())
                .await
                .unwrap()
                .result
                .data["committed"],
            false
        );
        assert_eq!(read(&runtime).await, before);
        context.dry_run = false;
        let receipt = runtime
            .registry()
            .invoke(ID, context.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(
            runtime
                .registry()
                .invoke(ID, context, request.clone())
                .await
                .unwrap(),
            receipt
        );
        let after = read(&runtime).await;
        let mut wanted = before["project"]["classic"].clone();
        let tracks = &mut wanted["document"]["scenes"][0]["tracks"];
        let target = match track {
            "video-track" => &mut tracks["main"],
            "titles" => &mut tracks["overlay"][0],
            _ => &mut tracks["audio"][0],
        };
        for (key, value) in expected.as_object().unwrap() {
            target[key] = value.clone();
        }
        assert_eq!(after["project"]["classic"], wanted);
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), request)
                .await
                .is_err()
        );
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], before["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], after["project"]);
    }
}

#[tokio::test]
async fn track_controls_reject_invalid_targets_and_partial_updates_without_mutation() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for (track, change) in [
        (
            "titles",
            json!({"type":"set", "name":"Should roll back", "muted":true}),
        ),
        ("music", json!({"type":"toggleVisibility"})),
        ("missing", json!({"type":"toggleMute"})),
        ("other-main", json!({"type":"toggleMute"})),
        ("video-track", json!({"type":"set"})),
        ("video-track", json!({"type":"set", "name":"   "})),
        (
            "video-track",
            json!({"type":"set", "name":"x".repeat(1025)}),
        ),
        ("video-track", json!({"type":"set", "muted":"true"})),
        ("video-track", json!({"type":"toggleMute", "hidden":true})),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    ID,
                    InvocationContext::default(),
                    input(&before, track, change)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let mut request = input(&before, "video-track", json!({"type":"toggleMute"}));
    request["projectId"] = json!("other-project");
    assert!(
        runtime
            .registry()
            .invoke(ID, InvocationContext::default(), request)
            .await
            .is_err()
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(
                ID,
                cancelled,
                input(&before, "video-track", json!({"type":"toggleMute"}))
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn controls_address_other_scenes_and_unmute_without_touching_active_scene() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let mut request = input(&before, "other-main", json!({"type":"set", "muted":true}));
    request["sceneId"] = json!("other-scene");
    call(&runtime, ID, request).await;
    let after = read(&runtime).await;
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["currentSceneId"],
        "main-scene"
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][1]["tracks"]["main"]["muted"],
        true
    );
    let mut request = input(&after, "other-main", json!({"type":"set", "muted":false}));
    request["sceneId"] = json!("other-scene");
    call(&runtime, ID, request).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
}
