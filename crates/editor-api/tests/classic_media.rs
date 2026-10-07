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
async fn attached(nested: bool) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][1]["tracks"]["main"]["elements"] = json!([
        {"id":"other-clip","type":"video","mediaId":"video-asset","name":"Other usage","startTime":0,"duration":120000,"trimStart":0,"trimEnd":0,"params":{}}
    ]);
    classic["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"keep-media","type":"image","name":"Retained","future":{"value":42}}));
    if nested {
        classic["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0]["future"] =
            json!({"layer":{"mediaId":"video-asset"}});
    }
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, ids: Value, cascade: bool) -> Value {
    json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaIds":ids,"cascade":cascade})
}

#[tokio::test]
async fn removal_is_atomic_across_scenes_and_retains_unrelated_content_history_and_dry_run() {
    let runtime = attached(false).await;
    let before = read(&runtime).await;
    let request = input(&before, json!(["video-asset", "video-asset"]), true);
    let descriptor = runtime
        .registry()
        .descriptor("media.classic.remove")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(descriptor.transactional && descriptor.supports_dry_run && !descriptor.open_world);
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("remove-media-once"));
    runtime
        .registry()
        .invoke("media.classic.remove", context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let receipt = runtime
        .registry()
        .invoke("media.classic.remove", context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke("media.classic.remove", context, request)
            .await
            .unwrap(),
        receipt
    );
    let after = read(&runtime).await;
    let mut expected = before["project"].clone();
    for scene in expected["classic"]["document"]["scenes"]
        .as_array_mut()
        .unwrap()
    {
        scene["tracks"]["main"]["elements"] = json!([]);
    }
    expected["classic"]["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    assert_eq!(after["project"], expected);
    assert_eq!(
        after["revision"].as_u64().unwrap(),
        before["revision"].as_u64().unwrap() + 1
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn missing_used_foreign_stale_or_cancelled_requests_leave_every_scene_and_history_unchanged()
{
    let runtime = attached(false).await;
    let before = read(&runtime).await;
    let mut wrong_scope = input(&before, json!(["video-asset"]), true);
    wrong_scope["projectId"] = json!("foreign-project");
    let mut stale = input(&before, json!(["video-asset"]), true);
    stale["expectedRevision"] = json!(0);
    for request in [
        input(&before, json!(["video-asset"]), false),
        input(&before, json!(["keep-media", "unknown"]), true),
        input(&before, json!([]), true),
        wrong_scope,
        stale,
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "media.classic.remove",
                    InvocationContext::default(),
                    request
                )
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
            .invoke(
                "media.classic.remove",
                cancelled,
                input(&before, json!(["video-asset"]), true)
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn retained_nested_media_dependency_prevents_cascade_removal_and_partial_asset_changes() {
    let runtime = attached(true).await;
    let before = read(&runtime).await;
    assert!(
        runtime
            .registry()
            .invoke(
                "media.classic.remove",
                InvocationContext::default(),
                input(&before, json!(["keep-media", "video-asset"]), true)
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(
        &runtime,
        "media.classic.remove",
        input(&before, json!(["keep-media"]), false),
    )
    .await;
    let after = read(&runtime).await;
    assert_eq!(
        after["project"]["classic"]["document"],
        before["project"]["classic"]["document"]
    );
    assert_eq!(
        after["project"]["classic"]["mediaAssets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn retained_hyperframes_and_compound_media_dependencies_fail_before_any_cascade() {
    for hyperframes in [true, false] {
        let runtime = attached(false).await;
        let mut classic = read(&runtime).await["project"]["classic"].clone();
        if hyperframes {
            classic["document"]["hyperframesCompositions"] = json!({"hf": {
                "compositionId":"hf", "width":1920, "height":1080, "fps":30, "durationSeconds":1,
                "source":{"entryFile":"index.html","files":{"index.html":"<div>Reference</div>"},"resourceAssetIds":{"resource.mp4":"video-asset"},"variables":{}}
            }});
        } else {
            classic["mediaAssets"][1]["unifiedAngles"] =
                json!({"angles":[{"mediaId":"video-asset"}]});
        }
        call(
            &runtime,
            "project.classic.commit",
            json!({"projectId":"classic-project", "expectedRevision":1, "classic":classic}),
        )
        .await;
        let before = read(&runtime).await;
        assert!(
            runtime
                .registry()
                .invoke(
                    "media.classic.remove",
                    InvocationContext::default(),
                    input(&before, json!(["video-asset"]), true)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
}
