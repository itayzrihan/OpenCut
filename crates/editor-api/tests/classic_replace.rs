use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.elements.split";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
fn input(r: &OpenCutRuntime, elements: Value, time: i64, side: &str) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"elements":elements,"splitTime":time,"retainSide":side})
}
async fn tracks(r: &OpenCutRuntime) -> Value {
    call(
        r,
        "app.state.read",
        json!({"pointer":"/project/classic/document/scenes/0/tracks"}),
    )
    .await["value"]
        .clone()
}

async fn setup() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"].as_array_mut().unwrap().push(
        json!({"id":"generated-replacement","name":"Replacement","type":"video","duration":2}),
    );
    let scene = &mut classic["document"]["scenes"][0];
    scene["bookmarks"] = json!([{"time":1200000,"label":"Incoming"}]);
    let tracks = &mut scene["tracks"];
    let mut right = tracks["main"]["elements"][0].clone();
    right["id"] = json!("incoming");
    right["startTime"] = json!(1200000);
    tracks["main"]["elements"]
        .as_array_mut()
        .unwrap()
        .push(right);
    tracks["audio"] = json!([{"id":"bed","type":"audio","name":"Bed","muted":false,"locked":true,
        "elements":[{"id":"music","type":"audio","name":"Music","sourceType":"library","sourceId":"music",
        "startTime":0, "duration":2400000,"trimStart":12000,"trimEnd":0,"params":{}}]}]);
    tracks["overlay"] = json!([{"id":"titles","type":"text","name":"Titles","hidden":false,
        "elements":[{"id":"title","type":"text","name":"Title","startTime":600000,
        "duration":1200000,"trimStart":0,"trimEnd":0,"params":{"content":"Title"}}]}]);
    tracks["order"] = json!(["titles", "video-track", "bed"]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}

#[tokio::test]
async fn replace_keeps_fractional_slot_original_sound_and_undo_and_rejects_stale_anchor() {
    let runtime = setup().await;
    let cut = input(
        &runtime,
        json!([{"trackId":"video-track","elementId":"item-2"}]),
        458400,
        "both",
    );
    call(&runtime, ID, cut).await;
    let before = tracks(&runtime).await;
    let original = &before["main"]["elements"][0];
    let mut request = json!({
        "projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,
        "target":{"sceneId":"main-scene","trackId":"video-track","elementId":original["id"]}
    });
    let plan = call(&runtime, "timeline.classic.replace.plan", request.clone()).await;
    assert_eq!(plan["durationTicks"], 458400);
    request["anchor"] = plan["anchor"].clone();
    request["mediaId"] = json!("generated-replacement");
    call(&runtime, "timeline.classic.replace.apply", request.clone()).await;
    let after = tracks(&runtime).await;
    let replacement = &after["main"]["elements"][0];
    assert_eq!(replacement["id"], original["id"]);
    assert_eq!(replacement["startTime"], original["startTime"]);
    assert_eq!(replacement["duration"], original["duration"]);
    assert_eq!(replacement["mediaId"], "generated-replacement");
    assert_eq!(replacement["effects"], original["effects"]);
    assert_eq!(replacement["isSourceAudioEnabled"], false);
    assert_eq!(replacement["retime"]["rate"], 240000.0 / 458400.0);
    assert_eq!(after["main"]["elements"][1], before["main"]["elements"][1]);
    assert_eq!(after["overlay"], before["overlay"]);
    assert_eq!(after["audio"][1], before["audio"][0]);
    let audio = &after["audio"][0]["elements"][0];
    assert_eq!(audio["mediaId"], original["mediaId"]);
    assert_eq!(audio["trimStart"], original["trimStart"]);
    assert_eq!(audio["retime"], original["retime"]);
    assert_eq!(audio["duration"], original["duration"]);
    assert_eq!(audio["startTime"], original["startTime"]);
    request["expectedRevision"] = json!(runtime.snapshot().unwrap().revision);
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.classic.replace.apply",
                InvocationContext::default(),
                request
            )
            .await
            .is_err()
    );
    assert_eq!(tracks(&runtime).await, after);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(tracks(&runtime).await, before);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(tracks(&runtime).await, after);
}
