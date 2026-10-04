use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
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
async fn state(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
async fn fixture() -> (OpenCutRuntime, Value) {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let imported = call(&runtime, "timeline.hyperframes.import", json!({
        "projectId":"classic-project", "expectedRevision":1, "name":"Brag project", "startSeconds":0,
        "source":{"entryFile":"index.html","files":{"index.html":"<div data-composition-id='brag' data-duration='6' data-width='720' data-height='1280'><script>throw new Error('never execute source')</script></div>"},
        "resourceAssetIds":{"first.mp4":"video-asset","alias.mp4":"video-asset"}}
    })).await;
    (runtime, imported)
}
fn read(revision: &Value) -> Value {
    json!({"projectId":"classic-project","expectedRevision":revision})
}
fn insert(imported: &Value, revision: &Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,
        "assetId":imported["assetId"],"name":"Brag again","startSeconds":3.5})
}

#[tokio::test]
async fn library_is_a_read_only_projection_and_reuse_preserves_one_source_and_media_binding() {
    let (runtime, imported) = fixture().await;
    let before = state(&runtime).await;
    let library = call(
        &runtime,
        "hyperframes.library.read",
        read(&before["revision"]),
    )
    .await;
    let item = &library["items"][0];
    assert_eq!(library["items"].as_array().unwrap().len(), 1);
    assert_eq!(item["assetId"], imported["assetId"]);
    assert_eq!(item["name"], "Brag project");
    assert_eq!(item["resourceAssetIds"], json!(["video-asset"]));
    assert_eq!(item["sourceFileCount"], 1);
    assert_eq!(item["width"], 720);
    assert_eq!(item["durationSeconds"], 6.0);
    assert_eq!(item["occurrences"][0]["sceneId"], "main-scene");
    assert_eq!(item["occurrences"][0]["elementId"], imported["itemId"]);
    assert!(!library.to_string().contains("never execute source"));
    assert_eq!(state(&runtime).await, before);

    let added = call(
        &runtime,
        "timeline.hyperframes.insert",
        insert(&imported, &before["revision"]),
    )
    .await;
    let after = state(&runtime).await;
    assert_eq!(added["assetId"], imported["assetId"]);
    assert_ne!(added["itemId"], imported["itemId"]);
    let original = &before["project"]["classic"];
    let current = &after["project"]["classic"];
    assert_eq!(
        current["document"]["hyperframesCompositions"],
        original["document"]["hyperframesCompositions"]
    );
    assert_eq!(current["mediaAssets"], original["mediaAssets"]);
    assert_eq!(
        current["document"]["scenes"][0]["tracks"]["main"],
        original["document"]["scenes"][0]["tracks"]["main"]
    );
    assert_eq!(
        current["document"]["scenes"][1],
        original["document"]["scenes"][1]
    );
    let reused = call(
        &runtime,
        "hyperframes.library.read",
        read(&after["revision"]),
    )
    .await;
    let occurrences = reused["items"][0]["occurrences"].as_array().unwrap();
    assert_eq!(occurrences.len(), 2);
    assert!(
        occurrences
            .iter()
            .any(|item| item["elementId"] == added["itemId"] && item["startTime"] == 420_000)
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn library_rejects_wrong_target_and_stale_revision_and_insert_is_atomic() {
    let (runtime, imported) = fixture().await;
    let before = state(&runtime).await;
    for (capability, mut input, key, value) in [
        (
            "hyperframes.library.read",
            read(&before["revision"]),
            "projectId",
            json!("other"),
        ),
        (
            "hyperframes.library.read",
            read(&before["revision"]),
            "expectedRevision",
            json!(0),
        ),
        (
            "timeline.hyperframes.insert",
            insert(&imported, &before["revision"]),
            "sceneId",
            json!("other-scene"),
        ),
        (
            "timeline.hyperframes.insert",
            insert(&imported, &before["revision"]),
            "assetId",
            json!("missing"),
        ),
        (
            "timeline.hyperframes.insert",
            insert(&imported, &before["revision"]),
            "trackId",
            json!("video-track"),
        ),
        (
            "timeline.hyperframes.insert",
            insert(&imported, &before["revision"]),
            "startSeconds",
            json!(-1),
        ),
        (
            "timeline.hyperframes.insert",
            insert(&imported, &before["revision"]),
            "expectedRevision",
            json!(0),
        ),
    ] {
        input[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(capability, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(state(&runtime).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.hyperframes.insert",
                cancelled,
                insert(&imported, &before["revision"])
            )
            .await
            .is_err()
    );
    assert_eq!(state(&runtime).await, before);
    let preview = InvocationContext {
        dry_run: true,
        ..InvocationContext::default()
    };
    runtime
        .registry()
        .invoke(
            "timeline.hyperframes.insert",
            preview,
            insert(&imported, &before["revision"]),
        )
        .await
        .unwrap();
    assert_eq!(state(&runtime).await, before);
    let descriptor = runtime
        .registry()
        .descriptor("timeline.hyperframes.insert")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.transactional && descriptor.supports_dry_run && descriptor.cancellable);
}

#[tokio::test]
async fn repeated_insert_key_returns_the_same_occurrence_without_another_history_entry() {
    let (runtime, imported) = fixture().await;
    let before = state(&runtime).await;
    let input = insert(&imported, &before["revision"]);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("library-add"));
    let first = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.insert",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    let after = state(&runtime).await;
    let repeated = runtime
        .registry()
        .invoke("timeline.hyperframes.insert", context, input)
        .await
        .unwrap();
    assert_eq!(first.result.data, repeated.result.data);
    assert_eq!(state(&runtime).await, after);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], before["project"]);
}
