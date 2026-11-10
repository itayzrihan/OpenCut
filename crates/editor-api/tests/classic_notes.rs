use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const EDIT: &str = "project.classic.notes.edit";
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
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project","expectedRevision":state["revision"],"change":change})
}
fn notes(state: &Value) -> &Value {
    &state["project"]["classic"]["document"]["notes"]
}

#[tokio::test]
async fn user_and_agent_notes_use_registry_persist_after_close_and_reopen_with_history() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let create = input(
        &before,
        json!({"type":"create","noteId":"outline","title":"תכנית עריכה","body":"Opening\n• Keep the original audio"}),
    );
    runtime
        .registry()
        .invoke(
            EDIT,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            create.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    let mut agent = InvocationContext {
        actor: Some("internal-editor-agent".into()),
        ..Default::default()
    };
    agent
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("create-outline"));
    let receipt = runtime
        .registry()
        .invoke(EDIT, agent.clone(), create.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(EDIT, agent, create)
            .await
            .unwrap(),
        receipt
    );
    let created = read(&runtime).await;
    assert_eq!(notes(&created)[0]["title"], "תכנית עריכה");
    assert_eq!(notes(&created)[0]["version"], 1);
    assert_eq!(
        created["project"]["classic"]["document"]["scenes"],
        before["project"]["classic"]["document"]["scenes"]
    );
    call(&runtime,EDIT,input(&created,json!({"type":"update","noteId":"outline","expectedNoteVersion":1,"body":"Reviewed opening"}))).await;
    let edited = read(&runtime).await;
    assert_eq!(notes(&edited)[0]["version"], 2);
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    call(
        &runtime,
        "project.close",
        json!({"projectId":"classic-project"}),
    )
    .await;
    assert!(read(&runtime).await["project"].is_null());
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(notes(&read(&reopened).await), notes(&edited));
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(notes(&read(&reopened).await), notes(&created));
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(notes(&read(&reopened).await), notes(&edited));
    let state = read(&reopened).await;
    call(&reopened,"project.classic.notes.remove",json!({"projectId":"classic-project","expectedRevision":state["revision"],"noteId":"outline","expectedNoteVersion":2})).await;
    assert_eq!(notes(&read(&reopened).await), &json!([]));
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(notes(&read(&reopened).await), notes(&edited));
    for id in [EDIT, "project.classic.notes.remove"] {
        let descriptor = runtime.registry().descriptor(id).unwrap().unwrap();
        assert_eq!(descriptor.access, AccessLevel::Write);
        assert!(descriptor.transactional && descriptor.supports_dry_run);
        assert!(!descriptor.open_world);
    }
}

#[tokio::test]
async fn stale_note_drafts_targets_and_oversized_inputs_cannot_overwrite_canonical_state() {
    let runtime = attached().await;
    call(
        &runtime,
        EDIT,
        input(
            &read(&runtime).await,
            json!({"type":"create","noteId":"note","title":"Plan","body":"First"}),
        ),
    )
    .await;
    call(&runtime,EDIT,input(&read(&runtime).await,json!({"type":"update","noteId":"note","expectedNoteVersion":1,"body":"Agent updated this"}))).await;
    let state = read(&runtime).await;
    for change in [
        json!({"type":"update","noteId":"note","expectedNoteVersion":1,"body":"Stale user draft"}),
        json!({"type":"create","noteId":"note","title":"Duplicate","body":""}),
        json!({"type":"create","noteId":"new","title":" ","body":""}),
        json!({"type":"create","noteId":"new","title":"Large","body":"x".repeat(20001)}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(EDIT, InvocationContext::default(), input(&state, change))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, state);
    }
    let mut wrong = input(
        &state,
        json!({"type":"update","noteId":"note","expectedNoteVersion":2,"body":"Wrong target"}),
    );
    wrong["projectId"] = json!("other-project");
    assert!(
        runtime
            .registry()
            .invoke(EDIT, InvocationContext::default(), wrong)
            .await
            .is_err()
    );
    let mut stale = input(
        &state,
        json!({"type":"update","noteId":"note","expectedNoteVersion":2,"body":"Wrong revision"}),
    );
    stale["expectedRevision"] = json!(0);
    assert!(
        runtime
            .registry()
            .invoke(EDIT, InvocationContext::default(), stale)
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, state);
    call(&runtime,EDIT,input(&state,json!({"type":"update","noteId":"note","expectedNoteVersion":2,"body":"Agent updated this"}))).await;
    assert_eq!(
        read(&runtime).await,
        state,
        "unchanged save creates no revision or undo entry"
    );
}

#[tokio::test]
async fn all_import_paths_validate_note_schema_before_accepting_documents() {
    for note in [
        json!({"id":"invalid"}),
        json!({"id":"n","title":"Title","body":"text","version":0,"createdAt":"2026-11-10T00:00:00Z","updatedAt":"2026-11-10T00:00:00Z"}),
    ] {
        let runtime = OpenCutRuntime::default();
        let mut classic: Value =
            serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
        classic["document"]["notes"] = json!([note]);
        assert!(
            runtime
                .registry()
                .invoke(
                    "project.classic.session.attach",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project","expectedRevision":0,"classic":classic})
                )
                .await
                .is_err()
        );
        assert!(read(&runtime).await["project"].is_null());
    }
}
