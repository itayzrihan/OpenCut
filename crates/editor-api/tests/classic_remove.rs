use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const ID: &str = "timeline.classic.remove";
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
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let source = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0]["captionSource"];
    source["words"]
        .as_array_mut()
        .unwrap()
        .push(json!({"text":"keep", "start":2,"end":3,"future":{"confidence":0.9}}));
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, removal: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"removal":removal})
}

#[tokio::test]
async fn removal_preserves_extensions_media_and_history_with_dry_run_and_exact_retry() {
    for removal in [
        json!({"type":"elements","elements":[{"trackId":"titles","elementId":"text-1"}]}),
        json!({"type":"track","trackId":"titles"}),
        json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]}),
    ] {
        let runtime = attached().await;
        let before = read(&runtime).await;
        let request = input(&before, removal.clone());
        let descriptor = runtime.registry().descriptor(ID).unwrap().unwrap();
        assert_eq!(descriptor.access, AccessLevel::Write);
        assert_eq!(descriptor.document_support, DocumentSupport::Classic);
        assert!(descriptor.supports_dry_run && descriptor.transactional && !descriptor.open_world);
        let mut context = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("delete-once"));
        runtime
            .registry()
            .invoke(ID, context.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(read(&runtime).await, before);
        context.dry_run = false;
        let receipt = runtime
            .registry()
            .invoke(ID, context.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(
            runtime
                .registry()
                .invoke(ID, context, request.clone())
                .await
                .unwrap(),
            receipt
        );
        let after = read(&runtime).await;
        let mut expected = before["project"].clone();
        let tracks = &mut expected["classic"]["document"]["scenes"][0]["tracks"];
        if removal["type"] == "track" {
            tracks["overlay"] = json!([]);
            tracks["order"] = json!(["video-track"]);
        } else if removal["elements"][0]["trackId"] == "titles" {
            tracks["overlay"][0]["elements"] = json!([]);
            tracks["overlay"][0]["captionSource"]["words"]
                .as_array_mut()
                .unwrap()
                .remove(0);
        } else {
            tracks["main"]["elements"] = json!([]);
        }
        assert_eq!(after["project"], expected);
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), request)
                .await
                .is_err()
        );
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], before["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], after["project"]);
    }
}

#[tokio::test]
async fn invalid_removals_do_not_partially_delete_or_create_history() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for removal in [
        json!({"type":"track","trackId":"video-track"}),
        json!({"type":"track","trackId":"other-main"}),
        json!({"type":"track","trackId":"missing"}),
        json!({"type":"elements","elements":[]}),
        json!({"type":"elements","elements":[{"trackId":"titles","elementId":"text-1"},{"trackId":"video-track","elementId":"missing"}]}),
        json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"text-1"}]}),
        json!({"type":"track","trackId":"titles","extra":true}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), input(&before, removal))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let request = input(&before, json!({"type":"track","trackId":"titles"}));
    for (key, value) in [
        ("projectId", json!("foreign")),
        ("sceneId", json!("missing")),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = request.clone();
        invalid[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), invalid)
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
            .invoke(ID, cancelled, request)
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}
