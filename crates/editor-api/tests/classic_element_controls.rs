use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.elements.controls";
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value {
    rt.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn read(rt: &OpenCutRuntime) -> Value {
    call(rt, "app.state.read", json!({})).await["value"].clone()
}
async fn setup() -> OpenCutRuntime {
    let rt = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"].as_array_mut().unwrap().push(json!({"id":"audio-asset","name":"audio","type":"audio","duration":1,"storageKind":"linked","sourcePath":"C:/selected/audio.wav"}));
    classic["document"]["scenes"][0]["tracks"]["audio"] = json!([{ "id":"audio-lane","type":"audio","name":"audio","muted":false,"elements":[{"id":"audio-clip","type":"audio","sourceType":"upload","mediaId":"audio-asset","name":"audio","startTime":0,"duration":120000,"trimStart":0,"trimEnd":0,"params":{"muted":true,"volume":-7}}]}]);
    classic["document"]["scenes"][0]["tracks"]["order"]
        .as_array_mut()
        .unwrap()
        .push(json!("audio-lane"));
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"].as_array_mut().unwrap().push(json!({"id":"second-video","type":"video","name":"second","mediaId":"video-asset","startTime":1200000,"duration":120000,"trimStart":0,"trimEnd":0,"hidden":true,"params":{"muted":true,"volume":-12,"sourceAudioEnabled":false}}));
    call(
        &rt,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    rt
}

#[tokio::test]
async fn audio_clips_are_skipped_by_visibility_and_mute_preserves_gain_and_timing() {
    let rt = setup().await;
    let before = read(&rt).await;
    let mut input = request(&before, json!({"type":"setHidden","value":true}));
    input["elements"] = json!([{"trackId":"audio-lane","elementId":"audio-clip"}]);
    let result = call(&rt, ID, input.clone()).await;
    assert_eq!(result["applied"], json!([]));
    assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(read(&rt).await["project"], before["project"]);
    input["expectedRevision"] = read(&rt).await["revision"].clone();
    input["change"] = json!({"type":"setMuted","value":false});
    call(&rt, ID, input).await;
    let mut expected = before["project"].clone();
    expected["classic"]["document"]["scenes"][0]["tracks"]["audio"][0]["elements"][0]["params"]["muted"] =
        json!(false);
    assert_eq!(read(&rt).await["project"], expected);
}
fn request(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"change":change,"elements":[{"trackId":"video-track","elementId":"item-2"},{"trackId":"video-track","elementId":"second-video"},{"trackId":"titles","elementId":"text-1"},{"trackId":"titles","elementId":"text-1"}]})
}
#[tokio::test]
async fn mixed_groups_share_values_deduplicate_and_preserve_source_metadata() {
    for change in [
        json!({"type":"toggleVisibility"}),
        json!({"type":"toggleMute"}),
        json!({"type":"setHidden","value":false}),
        json!({"type":"setMuted","value":false}),
    ] {
        let rt = setup().await;
        let before = read(&rt).await;
        let descriptor = rt.registry().descriptor(ID).unwrap().unwrap();
        assert_eq!(descriptor.document_support, DocumentSupport::Classic);
        assert_eq!(descriptor.access, AccessLevel::Write);
        let input = request(&before, change.clone());
        let mut ctx = InvocationContext {
            dry_run: true,
            ..Default::default()
        };
        ctx.metadata
            .insert("opencut/idempotencyKey".into(), json!("controls-once"));
        rt.registry()
            .invoke(ID, ctx.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(read(&rt).await, before);
        ctx.dry_run = false;
        let receipt = rt
            .registry()
            .invoke(ID, ctx.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(
            rt.registry().invoke(ID, ctx, input.clone()).await.unwrap(),
            receipt
        );
        let after = read(&rt).await;
        let hidden = change["type"].as_str().unwrap().contains("Hidden")
            || change["type"] == "toggleVisibility";
        let value = change["value"].as_bool().unwrap_or(true);
        let mut expected = before["project"].clone();
        let tracks = &mut expected["classic"]["document"]["scenes"][0]["tracks"];
        for element in tracks["main"]["elements"].as_array_mut().unwrap() {
            if hidden {
                element["hidden"] = json!(value);
            } else {
                element["params"]["muted"] = json!(value);
            }
        }
        if hidden {
            tracks["overlay"][0]["elements"][0]["hidden"] = json!(value);
        }
        assert_eq!(after["project"], expected);
        assert_eq!(
            receipt.result.data["applied"].as_array().unwrap().len(),
            if hidden { 3 } else { 2 }
        );
        assert_eq!(
            receipt.result.data["skipped"].as_array().unwrap().len(),
            if hidden { 0 } else { 1 }
        );
        assert!(
            rt.registry()
                .invoke(ID, InvocationContext::default(), input)
                .await
                .is_err()
        );
        call(&rt, "history.undo", json!({})).await;
        assert_eq!(read(&rt).await["project"], before["project"]);
        call(&rt, "history.redo", json!({})).await;
        assert_eq!(read(&rt).await["project"], after["project"]);
        call(
            &rt,
            ID,
            request(
                &read(&rt).await,
                if hidden {
                    json!({"type":"toggleVisibility"})
                } else {
                    json!({"type":"toggleMute"})
                },
            ),
        )
        .await;
        assert_eq!(
            read(&rt).await["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"]
                [0][if hidden { "hidden" } else { "params" }],
            if hidden {
                json!(!value)
            } else {
                json!({"transform.scaleX":1.2,"audioSyncOffset":0.1,"muted":!value})
            }
        );
    }
}
#[tokio::test]
async fn bad_scope_missing_target_and_cancellation_cannot_partially_commit() {
    let rt = setup().await;
    let before = read(&rt).await;
    for field in ["projectId", "sceneId"] {
        let mut input = request(&before, json!({"type":"toggleMute"}));
        input[field] = json!("foreign");
        assert!(
            rt.registry()
                .invoke(ID, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&rt).await, before);
    }
    let mut input = request(&before, json!({"type":"toggleMute"}));
    input["elements"]
        .as_array_mut()
        .unwrap()
        .push(json!({"trackId":"video-track","elementId":"missing"}));
    assert!(
        rt.registry()
            .invoke(ID, InvocationContext::default(), input)
            .await
            .is_err()
    );
    assert_eq!(read(&rt).await, before);
    let ctx = InvocationContext::default();
    ctx.cancellation.cancel();
    assert!(
        rt.registry()
            .invoke(ID, ctx, request(&before, json!({"type":"toggleMute"})))
            .await
            .is_err()
    );
    assert_eq!(read(&rt).await, before);
}

#[tokio::test]
async fn opaque_legacy_scalar_parameters_are_rejected_without_poisoning_the_runtime() {
    let rt = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["params"] = json!(42);
    call(
        &rt,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&rt).await;
    let mut input = request(&before, json!({"type":"toggleMute"}));
    input["elements"] = json!([{"trackId":"video-track","elementId":"item-2"}]);
    assert!(
        rt.registry()
            .invoke(ID, InvocationContext::default(), input)
            .await
            .is_err()
    );
    assert_eq!(read(&rt).await, before);
}
