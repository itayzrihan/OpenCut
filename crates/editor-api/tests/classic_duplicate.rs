use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.elements.duplicate";
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
fn scalar(id: &str, value: f64) -> Value {
    json!({"keys":[{"id":id,"time":0,"value":value,"segmentToNext":"linear","tangentMode":"flat","futureKey":{"keep":true}}],
        "extrapolation":{"before":"hold","after":"hold"},"futureChannel":{"keep":true}})
}
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let clip = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    clip["animations"] = json!({"opacity":scalar("shared",0.5),"color":{"r":scalar("color-key",10.0),"g":scalar("color-key",20.0),"b":scalar("color-key",30.0)},
        "future.discrete":{"keys":[{"id":"discrete-key","time":0,"value":"future value","futureKey":true}]}});
    clip["futureClip"] = json!({"linked":"keep"});
    classic["document"]["scenes"][0]["tracks"]["audio"] = json!([
        {"id":"music","name":"Music","type":"audio","muted":true,"elements":[
            {"id":"sound","type":"audio","sourceType":"library","libraryAssetId":"library-sound","name":"Sound","startTime":240000,"duration":120000,"trimStart":0,"trimEnd":0,"params":{"volume":0.6},"sourceUrl":"https://example.invalid/audio"}]}
    ]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, elements: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"elements":elements})
}
#[tokio::test]
async fn duplicate_preserves_source_media_animation_and_supports_dry_run_retry_and_undo() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let request = input(
        &before,
        json!([
            {"trackId":"music","elementId":"sound"},{"trackId":"video-track","elementId":"item-2"},
            {"trackId":"titles","elementId":"text-1"},{"trackId":"titles","elementId":"text-1"}
        ]),
    );
    let descriptor = runtime.registry().descriptor(ID).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(descriptor.transactional && descriptor.supports_dry_run && !descriptor.open_world);
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("duplicate-once"));
    let preview = runtime
        .registry()
        .invoke(ID, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(preview.result.data["elements"].as_array().unwrap().len(), 3);
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
    let refs = receipt.result.data["elements"].as_array().unwrap();
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    assert_eq!(tracks["order"][0], refs[2]["trackId"]);
    assert_eq!(tracks["order"][1], refs[1]["trackId"]);
    assert_eq!(tracks["order"][2], refs[0]["trackId"]);
    assert_eq!(
        tracks["futureTrackLayout"],
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["futureTrackLayout"]
    );
    assert_eq!(
        after["project"]["classic"]["mediaAssets"],
        before["project"]["classic"]["mediaAssets"]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][1],
        before["project"]["classic"]["document"]["scenes"][1]
    );
    let original =
        &before["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    let copied = &tracks["overlay"][0]["elements"][0];
    assert_eq!(copied["type"], "video");
    assert_eq!(copied["mediaId"], original["mediaId"]);
    let mut expected = original.clone();
    expected["id"] = refs[1]["elementId"].clone();
    expected["name"] = json!("Original video (copy)");
    expected["animations"] = copied["animations"].clone();
    assert_eq!(*copied, expected);
    let animation = &copied["animations"];
    assert_ne!(
        animation["opacity"]["keys"][0]["id"],
        original["animations"]["opacity"]["keys"][0]["id"]
    );
    assert_ne!(animation["color"]["r"]["keys"][0]["id"], json!("color-key"));
    assert_eq!(
        animation["color"]["r"]["keys"][0]["id"],
        animation["color"]["g"]["keys"][0]["id"]
    );
    assert_eq!(
        animation["color"]["r"]["keys"][0]["id"],
        animation["color"]["b"]["keys"][0]["id"]
    );
    assert_eq!(
        animation["opacity"]["futureChannel"],
        original["animations"]["opacity"]["futureChannel"]
    );
    assert_eq!(tracks["audio"][0]["muted"], false);
    assert!(tracks["overlay"][1].get("captionSource").is_none());
    let words = tracks["overlay"][2]["captionSource"]["words"]
        .as_array()
        .unwrap();
    assert!(
        words
            .iter()
            .any(|word| word["source"]["type"] == "text-layer"
                && word["source"]["elementId"] == refs[0]["elementId"])
    );
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
#[tokio::test]
async fn invalid_duplicate_is_atomic_and_does_not_consume_identity_allocation() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for refs in [
        json!([]),
        json!([{"trackId":"titles","elementId":"text-1"},{"trackId":"video-track","elementId":"missing"}]),
        json!([{"trackId":"titles","elementId":"item-2"}]),
        json!([{"trackId":"titles","elementId":"text-1","path":"no"}]),
        json!([{"trackId":"other-main","elementId":"item-2"}]),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(ID, InvocationContext::default(), input(&before, refs))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let request = input(
        &before,
        json!([{"trackId":"video-track","elementId":"item-2"}]),
    );
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("sceneId", json!("other-scene")),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = request.clone();
        invalid[field] = value;
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
            .invoke(ID, cancelled, request.clone())
            .await
            .is_err()
    );
    let clean = attached().await;
    assert_eq!(
        call(&runtime, ID, request.clone()).await["elements"],
        call(&clean, ID, request).await["elements"]
    );
}
