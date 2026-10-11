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
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}

#[tokio::test]
async fn studio_source_has_one_authority_with_validation_and_durable_history() {
    let runtime = OpenCutRuntime::default();
    call(&runtime, "project.create", json!({"name":"HyperCut"})).await;
    let state = read(&runtime).await;
    let id = state["project"]["id"].clone();
    let mut input = json!({"projectId":id, "expectedRevision":state["revision"],
        "source":{"files":{"index.html":"<html>first</html>"},"assets":{}}, "label":"Initial source"});
    call(&runtime, "project.studio.source.commit", input.clone()).await;
    let initial = read(&runtime).await;
    input["expectedRevision"] = initial["revision"].clone();
    input["source"]["files"]["index.html"] = json!("<html>second</html>");
    call(&runtime, "project.studio.source.commit", input.clone()).await;
    let edited = read(&runtime).await;
    assert_eq!(
        edited["project"]["extensions"]["hypercutStudio"]["files"]["index.html"],
        "<html>second</html>"
    );
    assert!(
        runtime
            .registry()
            .invoke(
                "project.studio.source.commit",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    let restored = OpenCutRuntime::default();
    let bytes = runtime.serialize_application_state_with_history().unwrap();
    restored
        .restore_application_state_from_bytes(&bytes)
        .unwrap();
    call(&restored, "history.undo", json!({})).await;
    assert_eq!(read(&restored).await["project"], initial["project"]);
    call(&restored, "history.redo", json!({})).await;
    assert_eq!(read(&restored).await["project"], edited["project"]);
    let before_corrupt = read(&restored).await;
    let mut corrupt: Value = serde_json::from_slice(&bytes).unwrap();
    corrupt["active"]["undo"][0]["document"]["project"]["id"] = json!("another-project");
    assert!(
        restored
            .restore_application_state_from_bytes(&serde_json::to_vec(&corrupt).unwrap())
            .is_err()
    );
    assert_eq!(read(&restored).await, before_corrupt);
    // The admin escape hatch also runs the typed Studio validator.
    let bad = json!({"expectedRevision":before_corrupt["revision"], "patch":[
        {"op":"add","path":"/project/extensions/hypercutStudio/files/..~1escape","value":"bad"}]});
    assert!(
        restored
            .registry()
            .invoke("app.state.patch", InvocationContext::default(), bad)
            .await
            .is_err()
    );
    assert_eq!(read(&restored).await, before_corrupt);
}

#[tokio::test]
async fn studio_history_budget_prunes_old_boundaries_without_blocking_new_edits() {
    let runtime = OpenCutRuntime::default();
    call(&runtime, "project.create", json!({"name":"Budget test"})).await;
    let id = read(&runtime).await["project"]["id"].clone();
    let large = "x".repeat(6 * 1024 * 1024);
    for i in 0..5 {
        let revision = runtime.snapshot().unwrap().revision;
        call(
            &runtime,
            "project.studio.source.commit",
            json!({
                "projectId":id, "expectedRevision":revision, "label":format!("edit {i}"),
                "source":{"files":{"index.html":format!("{i}{large}")}, "assets":{}}
            }),
        )
        .await;
    }
    let history = call(&runtime, "history.list", json!({"projectId":id})).await;
    assert_eq!(history["undo"].as_array().unwrap().len(), 2);
    let archive = runtime.serialize_application_state_with_history().unwrap();
    let restored = OpenCutRuntime::default();
    restored
        .restore_application_state_from_bytes(&archive)
        .unwrap();
    call(&restored, "history.undo", json!({})).await;
    let state = read(&restored).await;
    assert!(
        state["project"]["extensions"]["hypercutStudio"]["files"]["index.html"]
            .as_str()
            .unwrap()
            .starts_with('3')
    );
}
