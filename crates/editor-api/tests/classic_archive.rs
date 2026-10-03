use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
use std::sync::Arc;

fn classic() -> Value {
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["hyperframesCompositions"] = json!({"composition":{
        "source":{"entryFile":"index.html", "files":{"index.html":format!("<div data-composition-id='main' data-duration='6'>{}</div>", "שלום".repeat(20_000))}, "resourceAssetIds":{}},
        "compositionId":"main", "width":720, "height":1280, "fps":30, "durationSeconds":6,
        "futureCompositionProperty":{"must":"survive"}
    }});
    classic
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

#[tokio::test]
async fn source_is_shared_in_memory_and_archived_once_across_history() {
    let runtime = OpenCutRuntime::default();
    let initial = classic();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":initial}),
    )
    .await;
    let before = runtime
        .snapshot()
        .unwrap()
        .project
        .unwrap()
        .classic
        .unwrap();
    for revision in 1..=12 {
        let mut changed = initial.clone();
        changed["document"]["metadata"]["name"] = json!(format!("Edit {revision}"));
        call(
            &runtime,
            "project.classic.commit",
            json!({"projectId":"classic-project", "expectedRevision":revision, "classic":changed}),
        )
        .await;
        let current = runtime
            .snapshot()
            .unwrap()
            .project
            .unwrap()
            .classic
            .unwrap();
        assert!(Arc::ptr_eq(
            &current.document.compositions.as_ref().unwrap()["composition"].source,
            &before.document.compositions.as_ref().unwrap()["composition"].source
        ));
    }
    call(&runtime, "history.undo", json!({})).await;
    let session = call(
        &runtime,
        "project.classic.session.read",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    assert_eq!(archive["sources"].as_object().unwrap().len(), 1);
    let inline_bytes = serde_json::to_vec(&session).unwrap().len();
    let archive_bytes = serde_json::to_vec(&archive).unwrap().len();
    assert!(
        archive_bytes * 8 < inline_bytes,
        "archive={archive_bytes}, inline={inline_bytes}"
    );
    let reopened = OpenCutRuntime::default();
    let input = json!({"projectId":"classic-project", "expectedRevision":0, "archive":archive});
    reopened
        .registry()
        .invoke(
            "project.classic.session.restore",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(reopened.snapshot().unwrap().revision, 0);
    call(&reopened, "project.classic.session.restore", input).await;
    let mut restored = call(
        &reopened,
        "project.classic.session.read",
        json!({"projectId":"classic-project"}),
    )
    .await;
    restored["revision"] = session["revision"].clone();
    assert_eq!(restored, session);
    call(&reopened, "history.redo", json!({})).await;
    call(&reopened, "history.undo", json!({})).await;
    for _ in 0..11 {
        call(&reopened, "history.undo", json!({})).await;
    }
    assert_eq!(
        call(&reopened, "app.state.read", json!({})).await["value"]["project"]["classic"],
        initial
    );
}

#[tokio::test]
async fn archive_rejects_corrupt_or_missing_source_and_invalid_history_atomically() {
    let runtime = OpenCutRuntime::default();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic(),
        "undoStack":[{"label":"Old edit", "classic":classic()}]}),
    )
    .await;
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let source_id = archive["sources"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap();
    let mut invalids = Vec::new();
    let mut corrupt = archive.clone();
    corrupt["sources"][source_id]["files"]["index.html"] = json!("changed");
    invalids.push(corrupt);
    let mut missing = archive.clone();
    missing["sources"] = json!({});
    invalids.push(missing);
    let mut invalid = archive.clone();
    invalid["undoStack"][0]["classic"]["document"]["metadata"]["id"] = json!("other-project");
    invalids.push(invalid);
    let mut version = archive.clone();
    version["schemaVersion"] = json!(999);
    invalids.push(version);
    for invalid in invalids {
        let target = OpenCutRuntime::default();
        assert!(
            target
                .registry()
                .invoke(
                    "project.classic.session.restore",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project", "expectedRevision":0, "archive":invalid})
                )
                .await
                .is_err()
        );
        assert_eq!(target.snapshot().unwrap().revision, 0);
        assert!(target.snapshot().unwrap().project.is_none());
    }
}
