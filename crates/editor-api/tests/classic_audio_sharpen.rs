use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
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
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &rt,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    rt
}
#[tokio::test]
async fn noise_reduction_has_atomic_validated_dry_run_retry_and_history() {
    let rt = setup().await;
    let before = read(&rt).await;
    let id = "timeline.classic.audio.noise-reduction";
    let input = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elements":[{"trackId":"video-track","elementId":"item-2","amount":65}]});
    let mut ctx = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("noise-once"));
    rt.registry()
        .invoke(id, ctx.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(read(&rt).await, before);
    ctx.dry_run = false;
    let receipt = rt
        .registry()
        .invoke(id, ctx.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        rt.registry().invoke(id, ctx, input.clone()).await.unwrap(),
        receipt
    );
    let after = read(&rt).await;
    let mut expected = before["project"].clone();
    expected["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["params"]["noiseReduction"] =
        json!(65.0);
    assert_eq!(after["project"], expected);
    for amount in [json!(-1), json!(101), json!("50")] {
        let mut invalid = input.clone();
        invalid["expectedRevision"] = after["revision"].clone();
        invalid["elements"][0]["amount"] = amount;
        assert!(
            rt.registry()
                .invoke(id, InvocationContext::default(), invalid)
                .await
                .is_err()
        );
        assert_eq!(read(&rt).await, after);
    }
    let invalid = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":after["revision"],"elements":[{"trackId":"video-track","elementId":"item-2","amount":20},{"trackId":"titles","elementId":"text-1","amount":50}]});
    assert!(
        rt.registry()
            .invoke(id, InvocationContext::default(), invalid)
            .await
            .is_err()
    );
    assert_eq!(read(&rt).await, after);
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(read(&rt).await["project"], before["project"]);
    call(&rt, "history.redo", json!({})).await;
    assert_eq!(read(&rt).await["project"], after["project"]);
    // Inspector edits share the same validator and state.
    call(&rt,"timeline.classic.elements.update",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":read(&rt).await["revision"],"updates":[{"trackId":"video-track","elementId":"item-2","patch":{"params":{"noiseReduction":0}}}]})).await;
    assert_eq!(
        read(&rt).await["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"]
            [0]["params"]["noiseReduction"],
        0
    );
}
#[tokio::test]
async fn full_scene_sharpen_ignores_playhead_and_survives_serialization_and_undo() {
    let rt = setup().await;
    let before = read(&rt).await;
    let tracks = &before["project"]["classic"]["document"]["scenes"][0]["tracks"];
    let end = std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().unwrap())
        .chain(tracks["audio"].as_array().unwrap())
        .flat_map(|t| t["elements"].as_array().unwrap())
        .map(|e| e["startTime"].as_i64().unwrap() + e["duration"].as_i64().unwrap())
        .max()
        .unwrap();
    let result=call(&rt,"timeline.classic.elements.insert",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"clips":[{"element":{"type":"effect","effectType":"sharpen","name":"Sharpen","startTime":123456,"duration":120000,"fullScene":true,"params":{"intensity":15}},"placement":{"mode":"auto","trackType":"effect"}}]})).await;
    let after = read(&rt).await;
    let element = after["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
        .find(|e| e["id"] == result["elements"][0]["elementId"])
        .unwrap();
    assert_eq!(element["startTime"], 0);
    assert_eq!(element["duration"], end);
    assert_eq!(element["params"]["intensity"], 15);
    assert!(element.get("fullScene").is_none());
    let persisted: Value =
        serde_json::from_str(&serde_json::to_string(&after["project"]["classic"]).unwrap())
            .unwrap();
    assert_eq!(persisted, after["project"]["classic"]);
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(read(&rt).await["project"], before["project"]);
    call(&rt, "history.redo", json!({})).await;
    assert_eq!(read(&rt).await["project"], after["project"]);
}

#[tokio::test]
async fn dynamics_are_validated_readable_and_undoable() {
    let rt = setup().await;
    let before = read(&rt).await;
    let id = "timeline.classic.audio.dynamics";
    let request = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elements":[{"trackId":"video-track","elementId":"item-2"}],"gainDb":-1,"hardLimiterEnabled":true,"ceilingDb":-1,"lookAheadMs":7,"releaseMs":100});
    for (key, value) in [
        ("gainDb", json!(31)),
        ("ceilingDb", json!(1)),
        ("lookAheadMs", json!(0)),
        ("releaseMs", json!(251)),
    ] {
        let mut invalid = request.clone();
        invalid[key] = value;
        assert!(
            rt.registry()
                .invoke(id, InvocationContext::default(), invalid)
                .await
                .is_err()
        );
        assert_eq!(read(&rt).await, before);
    }
    call(&rt, id, request).await;
    let after = read(&rt).await;
    let p = &after["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]
        ["params"];
    assert_eq!(p["gainDb"], -1.0);
    assert_eq!(p["hardLimiterEnabled"], true);
    assert_eq!(p["hardLimiterCeilingDb"], -1.0);
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(read(&rt).await["project"], before["project"]);
}
