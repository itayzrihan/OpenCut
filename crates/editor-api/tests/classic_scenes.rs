use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const SCENES: &str = "project.classic.scenes.edit";
const DELETE: &str = "project.classic.scene.delete";
const BOOKMARKS: &str = "timeline.classic.bookmarks.edit";

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
fn input(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project", "expectedRevision":state["revision"], "change":change})
}
fn bookmark_input(state: &Value, change: Value) -> Value {
    let mut request = input(state, change);
    request["sceneId"] = json!("main-scene");
    request
}
fn ignore_project_time(mut project: Value) -> Value {
    project["classic"]["document"]["metadata"]["updatedAt"] = Value::Null;
    project
}

#[tokio::test]
async fn scene_lifecycle_preserves_media_unknown_fields_and_restores_active_scene_through_history()
{
    let runtime = attached().await;
    let original = read(&runtime).await;
    let create = input(
        &original,
        json!({"type":"create", "sceneId":"third", "mainTrackId":"third-main", "name":"סצנה חדשה"}),
    );
    let preview = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    runtime
        .registry()
        .invoke(SCENES, preview, create.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, original);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("scene-create"));
    let receipt = runtime
        .registry()
        .invoke(SCENES, context.clone(), create.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(SCENES, context, create)
            .await
            .unwrap(),
        receipt
    );
    let created = read(&runtime).await;
    let scene = created["project"]["classic"]["document"]["scenes"][2].clone();
    assert_eq!(
        scene["tracks"]["main"],
        json!({"id":"third-main", "name":"Main Track", "type":"video", "elements":[], "muted":false, "hidden":false})
    );
    assert_eq!(scene["tracks"]["order"], json!(["third-main"]));
    assert_eq!(scene["bookmarks"], json!([]));
    assert_eq!(scene["isMain"], false);
    assert!(chrono::DateTime::parse_from_rfc3339(scene["createdAt"].as_str().unwrap()).is_ok());
    let mut expected = original["project"].clone();
    expected["classic"]["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .push(scene);
    assert_eq!(
        ignore_project_time(created["project"].clone()),
        ignore_project_time(expected)
    );
    call(
        &runtime,
        SCENES,
        input(&created, json!({"type":"select", "sceneId":"third"})),
    )
    .await;
    let selected = read(&runtime).await;
    assert_eq!(
        selected["project"]["classic"]["document"]["currentSceneId"],
        "third"
    );
    call(
        &runtime,
        SCENES,
        input(
            &selected,
            json!({"type":"rename", "sceneId":"third", "name":"Renamed"}),
        ),
    )
    .await;
    let renamed = read(&runtime).await;
    call(&runtime, DELETE, json!({"projectId":"classic-project", "expectedRevision":renamed["revision"], "sceneId":"third"})).await;
    let deleted = read(&runtime).await;
    assert_eq!(
        deleted["project"]["classic"]["document"]["currentSceneId"],
        "main-scene"
    );
    assert_eq!(
        ignore_project_time(deleted["project"].clone()),
        ignore_project_time(original["project"].clone())
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], renamed["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], deleted["project"]);
    assert_eq!(
        runtime
            .registry()
            .snapshot()
            .unwrap()
            .capabilities
            .iter()
            .find(|d| d.id == DELETE)
            .unwrap()
            .access,
        AccessLevel::Write
    );
}

#[tokio::test]
async fn scene_edits_reject_invalid_targets_collisions_main_deletion_stale_revision_and_cancellation()
 {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for change in [
        json!({"type":"create", "sceneId":"main-scene", "mainTrackId":"fresh", "name":"Duplicate"}),
        json!({"type":"create", "sceneId":"fresh", "mainTrackId":"text-1", "name":"Duplicate element ID"}),
        json!({"type":"create", "sceneId":"fresh", "mainTrackId":"other-main", "name":"Duplicate track ID"}),
        json!({"type":"create", "sceneId":"", "mainTrackId":"fresh", "name":"Bad"}),
        json!({"type":"rename", "sceneId":"main-scene", "name":" "}),
        json!({"type":"rename", "sceneId":"missing", "name":"Name"}),
        json!({"type":"select", "sceneId":"missing"}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(SCENES, InvocationContext::default(), input(&before, change))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    for scene in ["main-scene", "missing"] {
        assert!(runtime.registry().invoke(DELETE, InvocationContext::default(), json!({"projectId":"classic-project", "expectedRevision":before["revision"], "sceneId":scene})).await.is_err());
    }
    let request = input(&before, json!({"type":"select", "sceneId":"other-scene"}));
    let mut wrong_project = request.clone();
    wrong_project["projectId"] = json!("other-project");
    assert!(
        runtime
            .registry()
            .invoke(SCENES, InvocationContext::default(), wrong_project)
            .await
            .is_err()
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(SCENES, cancelled, request.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(&runtime, SCENES, request.clone()).await;
    assert!(
        runtime
            .registry()
            .invoke(SCENES, InvocationContext::default(), request)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn bookmark_moves_preserve_duplicate_order_ranges_groups_and_unknown_metadata() {
    let runtime = attached().await;
    let initial = read(&runtime).await;
    let bookmarks = json!([
        {"time":4004, "note":"first", "color":"#ff00ff", "duration":8008, "groupId":"takes", "future":{"nested":true}},
        {"time":8008, "note":"second"}, {"time":8008, "note":"third"}
    ]);
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&initial, json!({"type":"replace", "bookmarks":bookmarks})),
    )
    .await;
    let before = read(&runtime).await;
    let request = bookmark_input(
        &before,
        json!({"type":"move", "fromTime":4100, "toTime":7800}),
    );
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("move-marker"));
    let receipt = runtime
        .registry()
        .invoke(BOOKMARKS, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(BOOKMARKS, context, request)
            .await
            .unwrap(),
        receipt
    );
    let moved = read(&runtime).await;
    let mut expected = bookmarks.clone();
    expected[0]["time"] = json!(8008);
    assert_eq!(
        moved["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        expected
    );
    let mut preserved = before["project"].clone();
    preserved["classic"]["document"]["scenes"][0]["bookmarks"] = expected;
    assert_eq!(
        ignore_project_time(moved["project"].clone()),
        ignore_project_time(preserved)
    );
    call(&runtime, BOOKMARKS, bookmark_input(&moved, json!({"type":"update", "time":8000, "updates":{"note":"שלום", "clear":["color", "duration"]}}))).await;
    let updated = read(&runtime).await;
    assert_eq!(
        updated["project"]["classic"]["document"]["scenes"][0]["bookmarks"][0],
        json!({"time":8008, "note":"שלום", "groupId":"takes", "future":{"nested":true}})
    );
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&updated, json!({"type":"toggle", "time":8008})),
    )
    .await;
    let toggled = read(&runtime).await;
    assert_eq!(
        toggled["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        json!([{"time":8008,"note":"second"},{"time":8008,"note":"third"}])
    );
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&toggled, json!({"type":"remove", "time":8008})),
    )
    .await;
    let removed = read(&runtime).await;
    assert_eq!(
        removed["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        json!([])
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], toggled["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], removed["project"]);
}

#[tokio::test]
async fn invalid_bookmarks_fail_without_changing_any_scene_or_history() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for change in [
        json!({"type":"toggle", "time":-1}),
        json!({"type":"toggle", "time":1.5}),
        json!({"type":"toggle", "time":9007199254740992_i64}),
        json!({"type":"replace", "bookmarks":[{"time":0,"duration":-1}]}),
        json!({"type":"replace", "bookmarks":[{"time":9007199254740990_i64,"duration":2}]}),
        json!({"type":"replace", "bookmarks":[{"time":0,"note":3}]}),
        json!({"type":"update", "time":120000,"updates":{"note":"text","clear":["note"]}}),
        json!({"type":"update", "time":120000,"updates":{"clear":["future"]}}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    BOOKMARKS,
                    InvocationContext::default(),
                    bookmark_input(&before, change)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let preview = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    runtime
        .registry()
        .invoke(
            BOOKMARKS,
            preview,
            bookmark_input(&before, json!({"type":"toggle", "time":2002})),
        )
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    let mut missing = bookmark_input(&before, json!({"type":"toggle", "time":0}));
    missing["sceneId"] = json!("missing");
    assert!(
        runtime
            .registry()
            .invoke(BOOKMARKS, InvocationContext::default(), missing)
            .await
            .is_err()
    );
    // Generic Classic replacement is subject to the same bookmark model validation.
    let mut invalid = before["project"]["classic"].clone();
    invalid["document"]["scenes"][1]["bookmarks"] = json!([{"time":-10}]);
    assert!(runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({"projectId":"classic-project", "expectedRevision":before["revision"], "classic":invalid})).await.is_err());
    assert_eq!(read(&runtime).await, before);
}
