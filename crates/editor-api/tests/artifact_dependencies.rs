use opencut_editor_api::{InvocationContext, OpenCutRuntime};
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
async fn attach(classic: Value, runtime: &OpenCutRuntime) {
    call(
        runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap()
}

#[tokio::test]
async fn future_artifact_refs_and_legacy_bindings_are_retained_from_current_document_and_history_only()
 {
    let runtime = OpenCutRuntime::default();
    let used = runtime
        .artifacts()
        .put(vec![1, 2, 3], "image/png", Some(1), Some(1), None)
        .unwrap();
    let unused = runtime
        .artifacts()
        .put(vec![4, 5, 6], "image/png", Some(1), Some(1), None)
        .unwrap();
    let mut classic = fixture();
    classic["document"]["futureFeature"]["preview"] = json!({"nested":[used]});
    classic["mediaAssets"][0]["generation"] = json!({"artifactId":used.id,"sha256":used.sha256});
    attach(classic.clone(), &runtime).await;
    let before = runtime.snapshot().unwrap();
    assert_eq!(
        runtime.referenced_artifact_ids("classic-project").unwrap(),
        vec![used.id.clone()]
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
    assert!(runtime.referenced_artifact_ids("foreign-project").is_err());
    assert!(
        !runtime
            .referenced_artifact_ids("classic-project")
            .unwrap()
            .contains(&unused.id)
    );
    classic["document"]["futureFeature"]
        .as_object_mut()
        .unwrap()
        .remove("preview");
    classic["mediaAssets"][0]
        .as_object_mut()
        .unwrap()
        .remove("generation");
    call(
        &runtime,
        "project.classic.commit",
        json!({"projectId":"classic-project","expectedRevision":1,"classic":classic}),
    )
    .await;
    assert_eq!(
        runtime.referenced_artifact_ids("classic-project").unwrap(),
        vec![used.id.clone()]
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(
        runtime.referenced_artifact_ids("classic-project").unwrap(),
        vec![used.id.clone()]
    );
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(
        runtime.referenced_artifact_ids("classic-project").unwrap(),
        vec![used.id.clone()]
    );
    runtime
        .restore_application_state_from_bytes(&runtime.serialize_application_state().unwrap())
        .unwrap();
    assert!(
        runtime
            .referenced_artifact_ids("classic-project")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn conflicting_checksums_cannot_be_hidden_by_a_good_historical_reference() {
    let runtime = OpenCutRuntime::default();
    let used = runtime
        .artifacts()
        .put(vec![1, 2, 3], "image/png", None, None, None)
        .unwrap();
    let mut classic = fixture();
    classic["document"]["futureFeature"]["preview"] = json!(used);
    attach(classic.clone(), &runtime).await;
    classic["document"]["futureFeature"]["preview"]["sha256"] = json!("0".repeat(64));
    call(
        &runtime,
        "project.classic.commit",
        json!({"projectId":"classic-project","expectedRevision":1,"classic":classic}),
    )
    .await;
    assert!(runtime.referenced_artifact_ids("classic-project").is_err());
    assert_eq!(
        runtime.artifacts().get(&used.id).unwrap().bytes.as_ref(),
        &[1, 2, 3]
    );
}
