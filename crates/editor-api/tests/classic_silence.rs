use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

fn classic() -> Value {
    serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap()
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

async fn state(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}

async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({
            "projectId":"classic-project", "expectedRevision":0, "classic":classic()
        }),
    )
    .await;
    runtime
}

fn edit(operation: &str, revision: u64) -> Value {
    let mut draft = classic();
    let tracks = &mut draft["document"]["scenes"][0]["tracks"];
    tracks["main"]["elements"][0]["duration"] = json!(1_080_000);
    tracks["main"]["elements"][0]["trimEnd"] = json!(360_000);
    // This source and its editable appearance travel in the exact same document.
    tracks["overlay"][0]["captionSource"]["words"] = json!([
        {"text":"שלום", "start":0.0, "end":1.0},
        {"text":"בעולם", "start":1.2, "end":1.7}
    ]);
    draft["document"]["metadata"]["duration"] = json!(1_080_000);
    if operation == "restore" {
        draft["document"]["scenes"][0]["bookmarks"][0]["time"] = json!(240_000);
    }
    json!({"projectId":"classic-project", "sceneId":"main-scene",
        "expectedRevision":revision, "operation":operation, "classic":draft})
}

#[tokio::test]
async fn silence_edits_are_lossless_revision_checked_retryable_and_undoable() {
    for operation in ["smart-remove", "restore", "repair-captions"] {
        let runtime = attached().await;
        let before = state(&runtime).await;
        let input = edit(operation, before["revision"].as_u64().unwrap());
        let descriptor = runtime
            .registry()
            .snapshot()
            .unwrap()
            .capabilities
            .into_iter()
            .find(|entry| entry.id == "timeline.silence.commit")
            .unwrap();
        assert_eq!(descriptor.access, AccessLevel::Write);
        assert_eq!(descriptor.document_support, DocumentSupport::Classic);
        assert!(descriptor.transactional && descriptor.supports_dry_run);
        assert!(!descriptor.open_world);

        let mut context = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("silence-edit"));
        let preview = runtime
            .registry()
            .invoke("timeline.silence.commit", context.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(preview.result.data["committed"], false);
        assert_eq!(state(&runtime).await, before);
        context.dry_run = false;
        let receipt = runtime
            .registry()
            .invoke("timeline.silence.commit", context.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(
            runtime
                .registry()
                .invoke("timeline.silence.commit", context, input.clone())
                .await
                .unwrap(),
            receipt
        );
        assert_eq!(
            state(&runtime).await["project"]["classic"],
            input["classic"]
        );
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.silence.commit",
                    InvocationContext::default(),
                    input.clone()
                )
                .await
                .is_err()
        );
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(
            state(&runtime).await["project"]["classic"],
            before["project"]["classic"]
        );
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(
            state(&runtime).await["project"]["classic"],
            input["classic"]
        );
    }
}

#[tokio::test]
async fn silence_commit_rejects_cross_project_cross_scene_and_unrelated_changes_atomically() {
    let runtime = attached().await;
    let before = state(&runtime).await;
    for (pointer, value) in [
        ("/projectId", json!("another-project")),
        ("/sceneId", json!("other-scene")),
        ("/classic/document/currentSceneId", json!("other-scene")),
        ("/classic/document/settings/canvasSize/width", json!(1080)),
        (
            "/classic/document/scenes/1/name",
            json!("Other scene edited"),
        ),
        (
            "/classic/mediaAssets/0/sourcePath",
            json!("C:/different.mp4"),
        ),
        (
            "/classic/document/scenes/0/tracks/main/elements/0/duration",
            json!(-1),
        ),
        ("/operation", json!("unknown-operation")),
    ] {
        let mut input = edit("smart-remove", before["revision"].as_u64().unwrap());
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.silence.commit",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err(),
            "accepted invalid mutation at {pointer}"
        );
        assert_eq!(state(&runtime).await, before);
    }
    let mut repair = edit("repair-captions", before["revision"].as_u64().unwrap());
    repair["classic"]["document"]["scenes"][0]["bookmarks"][0]["time"] = json!(240_000);
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.silence.commit",
                InvocationContext::default(),
                repair
            )
            .await
            .is_err()
    );
    assert_eq!(state(&runtime).await, before);
}
