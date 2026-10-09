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
    let restored = call(
        &reopened,
        "project.classic.session.read",
        json!({"projectId":"classic-project"}),
    )
    .await;
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

#[tokio::test]
async fn compact_history_preserves_every_boundary_and_rejects_invalid_deltas() {
    let runtime = OpenCutRuntime::default();
    let mut initial = classic();
    initial["document"]["futureMetadata"] = json!("unchanged project data ".repeat(20_000));
    let boundaries: Vec<_> = (0..12).map(|index| {
        let mut snapshot = initial.clone();
        snapshot["document"]["metadata"]["name"] = json!(format!("Before edit {index}"));
        json!({"label":format!("Edit {index}"),"classic":snapshot,"hostContext":{"selection":index}})
    }).collect();
    call(&runtime, "project.classic.session.attach", json!({"projectId":"classic-project","expectedRevision":0,"classic":initial,"undoStack":boundaries})).await;
    let full = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let compact = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","compact":true}),
    )
    .await;
    assert_eq!(compact["schemaVersion"], 2);
    assert!(compact["undoStack"][0]["classic"]["delta"].is_array());
    assert!(
        serde_json::to_vec(&compact).unwrap().len() * 4 < serde_json::to_vec(&full).unwrap().len()
    );
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":compact}),
    )
    .await;
    assert_eq!(
        call(
            &reopened,
            "project.classic.session.archive",
            json!({"projectId":"classic-project"})
        )
        .await,
        full
    );
    for operation in ["history.undo", "history.redo"] {
        for _ in 0..12 {
            call(&runtime, operation, json!({})).await;
            call(&reopened, operation, json!({})).await;
            assert_eq!(
                call(&runtime, "app.state.read", json!({})).await,
                call(&reopened, "app.state.read", json!({})).await
            );
        }
    }
    for patch in [
        json!([{"op":"replace","path":"/document/metadata/id","value":"another-project"}]),
        json!([{"op":"remove","path":"/missing"}]),
        json!([{"op":"copy","from":"","path":"/duplicate"}]),
    ] {
        let mut invalid = compact.clone();
        invalid["undoStack"][0]["classic"] = json!({"delta":patch});
        let target = OpenCutRuntime::default();
        assert!(
            target
                .registry()
                .invoke(
                    "project.classic.session.restore",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project","expectedRevision":0,"archive":invalid})
                )
                .await
                .is_err()
        );
        assert!(target.snapshot().unwrap().project.is_none());
    }
}

#[tokio::test]
async fn chained_history_preserves_divergent_scenes_and_both_stack_orders() {
    let runtime = OpenCutRuntime::default();
    let mut initial = classic();
    initial["document"]["futureLargeField"] = json!("original".repeat(10_000));
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0,"classic":initial}),
    )
    .await;
    for revision in 1..=20 {
        let mut changed = initial.clone();
        changed["document"]["metadata"]["name"] = json!(format!("edit-{revision}"));
        if revision > 10 {
            changed["document"]["futureLargeField"] = json!("different".repeat(10_000));
        }
        call(
            &runtime,
            "project.classic.commit",
            json!({"projectId":"classic-project","expectedRevision":revision,"classic":changed}),
        )
        .await;
    }
    for _ in 0..5 {
        call(&runtime, "history.undo", json!({})).await;
    }
    let full = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let compact = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","compact":true}),
    )
    .await;
    let chained = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","compact":true,"chained":true}),
    )
    .await;
    assert_eq!(chained["schemaVersion"], 3);
    assert!(
        serde_json::to_vec(&chained).unwrap().len() * 2
            < serde_json::to_vec(&compact).unwrap().len(),
        "chained={} compact={}",
        serde_json::to_vec(&chained).unwrap().len(),
        serde_json::to_vec(&compact).unwrap().len()
    );
    let restored = OpenCutRuntime::default();
    call(
        &restored,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":chained}),
    )
    .await;
    assert_eq!(
        call(
            &restored,
            "project.classic.session.archive",
            json!({"projectId":"classic-project"})
        )
        .await,
        full
    );
    for operation in ["history.redo", "history.undo"] {
        for _ in 0..5 {
            call(&runtime, operation, json!({})).await;
            call(&restored, operation, json!({})).await;
            assert_eq!(
                call(&runtime, "app.state.read", json!({})).await,
                call(&restored, "app.state.read", json!({})).await
            );
        }
    }
    let mut invalid = chained;
    invalid["undoStack"][1]["classic"] =
        json!({"delta":[{"op":"replace","path":"/document/metadata/id","value":"other"}]});
    let empty = OpenCutRuntime::default();
    assert!(
        empty
            .registry()
            .invoke(
                "project.classic.session.restore",
                InvocationContext::default(),
                json!({"projectId":"classic-project","expectedRevision":0,"archive":invalid})
            )
            .await
            .is_err()
    );
    assert_eq!(empty.snapshot().unwrap().revision, 0);
}

/// Opt-in local benchmark; no fixture contents enter the repository or stdout.
#[tokio::test]
#[ignore]
async fn local_archive_performance() {
    let input = std::env::var("OPENCUT_PERF_PROJECT").unwrap();
    let output = std::env::var("OPENCUT_PERF_ARCHIVE_OUTPUT").unwrap();
    let project: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let record: Value =
        serde_json::from_str(project["__opencutEditorSession"].as_str().unwrap()).unwrap();
    let archive = &record["saved"]["bundle"]["archive"];
    let project_id = archive["projectId"].as_str().unwrap();
    let runtime = OpenCutRuntime::default();
    let start = std::time::Instant::now();
    call(
        &runtime,
        "project.classic.session.restore",
        json!({"projectId":project_id,"expectedRevision":0,"archive":archive}),
    )
    .await;
    let restore_ms = start.elapsed().as_millis();
    let full = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":project_id}),
    )
    .await;
    let start = std::time::Instant::now();
    let chained = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":project_id,"compact":true,"chained":true}),
    )
    .await;
    let encode_ms = start.elapsed().as_millis();
    let restored = OpenCutRuntime::default();
    let start = std::time::Instant::now();
    call(
        &restored,
        "project.classic.session.restore",
        json!({"projectId":project_id,"expectedRevision":0,"archive":chained}),
    )
    .await;
    let chained_restore_ms = start.elapsed().as_millis();
    assert_eq!(
        call(
            &restored,
            "project.classic.session.archive",
            json!({"projectId":project_id})
        )
        .await,
        full
    );
    let bytes = serde_json::to_vec(&chained).unwrap();
    println!(
        "{}",
        json!({"beforeBytes":serde_json::to_vec(archive).unwrap().len(),"afterBytes":bytes.len(),"restoreMs":restore_ms,"chainedRestoreMs":chained_restore_ms,"encodeMs":encode_ms,"undo":chained["undoStack"].as_array().unwrap().len(),"redo":chained["redoStack"].as_array().unwrap().len(),"exactHistoryEquality":true})
    );
    std::fs::write(output, bytes).unwrap();
}
