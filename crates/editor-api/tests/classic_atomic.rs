use opencut_editor_api::{InvocationContext, OpenCutRuntime, RegistryEvent};
use serde_json::{Value, json};

#[tokio::test]
async fn atomic_edits_publish_once_and_rollback_only_their_retry_receipts() {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let initial_input =
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic});
    let mut attach_context = InvocationContext::default();
    attach_context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("initial-attach"));
    let original_receipt = runtime
        .registry()
        .invoke(
            "project.classic.attach",
            attach_context.clone(),
            initial_input.clone(),
        )
        .await
        .unwrap();
    let before = runtime.snapshot().unwrap();
    let mut events = runtime.registry().subscribe();
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/transaction".into(), json!(true));
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("atomic-edit"));
    classic["document"]["metadata"]["name"] = json!("During transaction");
    let input = json!({"projectId":"classic-project", "expectedRevision":1, "classic":classic});
    let checkpoint = runtime.begin_atomic().unwrap();
    runtime
        .registry()
        .invoke("project.classic.commit", context.clone(), input.clone())
        .await
        .unwrap();
    assert!(
        events.try_recv().is_err(),
        "must not publish a partial transaction"
    );
    runtime.rollback_atomic(checkpoint).unwrap();
    assert_eq!(runtime.snapshot().unwrap(), before);
    assert_eq!(
        runtime
            .registry()
            .invoke("project.classic.attach", attach_context, initial_input)
            .await
            .unwrap(),
        original_receipt
    );
    let checkpoint = runtime.begin_atomic().unwrap();
    runtime
        .registry()
        .invoke("project.classic.commit", context, input)
        .await
        .unwrap();
    assert_eq!(
        runtime.snapshot().unwrap().project.as_ref().unwrap().name,
        "During transaction"
    );
    classic["document"]["metadata"]["name"] = json!("Committed");
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/transaction".into(), json!(true));
    runtime
        .registry()
        .invoke(
            "project.classic.commit",
            context,
            json!({"projectId":"classic-project", "expectedRevision":2, "classic":classic}),
        )
        .await
        .unwrap();
    assert!(events.try_recv().is_err());
    runtime
        .commit_atomic_with_context(
            checkpoint,
            "Grouped edit",
            json!({"callbackId":"host-command"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .unwrap();
    assert!(matches!(
        events.try_recv().unwrap(),
        RegistryEvent::ResourcesChanged { .. }
    ));
    assert!(events.try_recv().is_err());
    let undo = runtime
        .registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(
        undo.result.data["hostContext"]["callbackId"],
        "host-command"
    );
    assert_eq!(undo.result.data["canUndo"], false);
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
}
