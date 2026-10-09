use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{json, Value};
const ID: &str = "timeline.classic.elements.split";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    tracks["main"]["elements"][0]["animations"] = json!({"opacity":{"keys":[{"id":"a","time":0,"value":0,"segmentToNext":"bezier","tangentMode":"broken","rightHandle":{"dt":800000,"dv":0.5}},{"id":"b","time":1200000,"value":1,"segmentToNext":"linear","tangentMode":"broken","leftHandle":{"dt":-800000,"dv":-0.5}}]}});
    tracks["overlay"].as_array_mut().unwrap().push(json!({"id":"manual","type":"text","name":"Manual","hidden":false,"elements":[{"id":"manual-text","type":"text","name":"Words","startTime":0,"duration":100,"trimStart":0,"trimEnd":0,"params":{"content":"שלום\nworld"},"wordRuns":[{"id":"old-a","text":"שלום","lineIndex":2,"startTime":0,"endTime":50,"params":{"color":"red"}},{"id":"old-b","text":"world","lineIndex":4,"startTime":50,"endTime":100}],"textRowOverrides":[{"id":"old-row","lineIndex":4,"params":{"color":"blue"}}]}]}));
    tracks["order"]
        .as_array_mut()
        .unwrap()
        .push(json!("manual"));
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
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
#[tokio::test]
async fn split_snaps_source_once_preserves_curves_and_reopens_history() {
    let r = setup().await;
    let before = tracks(&r).await;
    let output = call(
        &r,
        ID,
        input(
            &r,
            json!([{"trackId":"video-track","elementId":"item-2"}]),
            600001,
            "both",
        ),
    )
    .await;
    let after = tracks(&r).await;
    let halves = after["main"]["elements"].as_array().unwrap();
    assert_eq!(halves.len(), 2);
    assert_eq!(halves[0]["duration"], 600001);
    assert_eq!(halves[1]["duration"], 599999);
    assert_eq!(halves[0]["trimEnd"], 989999);
    assert_eq!(halves[1]["trimStart"], 1230001);
    assert_eq!(output["rightElements"][0]["elementId"], halves[1]["id"]);
    assert_eq!(halves[1]["masks"], before["main"]["elements"][0]["masks"]);
    assert_eq!(
        halves[1]["effects"],
        before["main"]["elements"][0]["effects"]
    );
    let left = halves[0]["animations"]["opacity"]["keys"]
        .as_array()
        .unwrap();
    let right = halves[1]["animations"]["opacity"]["keys"]
        .as_array()
        .unwrap();
    assert_eq!(left.len(), 2);
    assert_eq!(right.len(), 2);
    assert_eq!(left[1]["time"], 600001);
    assert_eq!(right[0]["time"], 0);
    assert_eq!(left[1]["value"], right[0]["value"]);
    assert_ne!(left[0]["id"], left[1]["id"]);
    assert_eq!(left[0]["rightHandle"]["dt"], 400001);
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","persistableOnly":true}),
    )
    .await;
    let reopened = OpenCutRuntime::full_access().unwrap();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(tracks(&reopened).await, before);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(tracks(&reopened).await, after);
}
#[tokio::test]
async fn manual_text_rebases_words_rows_and_right_only_identity_without_deleting_transcript() {
    let r = setup().await;
    let before = tracks(&r).await;
    let output = call(
        &r,
        ID,
        input(
            &r,
            json!([{"trackId":"manual","elementId":"manual-text"}]),
            50,
            "right",
        ),
    )
    .await;
    let after = tracks(&r).await;
    let right = &after["overlay"][1]["elements"][0];
    assert_eq!(output["rightElements"][0]["elementId"], "manual-text");
    assert_eq!(right["startTime"], 50);
    assert_eq!(right["duration"], 50);
    assert_eq!(right["params"]["content"], "world");
    assert_eq!(right["wordRuns"][0]["id"], "word-0");
    assert_eq!(right["wordRuns"][0]["startTime"], 0);
    assert_eq!(right["wordRuns"][0]["endTime"], 50);
    assert_eq!(right["textRowOverrides"][0]["lineIndex"], 0);
    assert_eq!(right["textRowOverrides"][0]["params"]["color"], "blue");
    assert!(after["overlay"][0]["captionSource"]["words"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["text"] == before["overlay"][0]["captionSource"]["words"][0]["text"]));
    call(&r, "history.undo", json!({})).await;
    assert_eq!(tracks(&r).await, before);
}
#[tokio::test]
async fn split_invalid_batch_stale_scope_dry_run_cancel_and_trim_overflow_are_atomic() {
    let r = setup().await;
    let before = r.snapshot().unwrap();
    let valid = json!({"trackId":"video-track","elementId":"item-2"});
    for tail in [
        valid.clone(),
        json!({"trackId":"video-track","elementId":"missing"}),
    ] {
        assert!(r
            .registry()
            .invoke(
                ID,
                InvocationContext::default(),
                input(&r, json!([valid, tail]), 600000, "both")
            )
            .await
            .is_err());
        assert_eq!(r.snapshot().unwrap(), before);
    }
    let dry = InvocationContext {
        dry_run: true,
        ..InvocationContext::default()
    };
    r.registry()
        .invoke(ID, dry, input(&r, json!([valid]), 600000, "both"))
        .await
        .unwrap();
    assert_eq!(r.snapshot().unwrap(), before);
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(r
        .registry()
        .invoke(ID, cancelled, input(&r, json!([valid]), 600000, "both"))
        .await
        .is_err());
    assert_eq!(r.snapshot().unwrap(), before);
    for (field, value) in [
        ("expectedRevision", json!(0)),
        ("projectId", json!("foreign")),
        ("splitTime", json!(1.5)),
    ] {
        let mut request = input(&r, json!([valid]), 600000, "both");
        request[field] = value;
        assert!(r
            .registry()
            .invoke(ID, InvocationContext::default(), request)
            .await
            .is_err());
        assert_eq!(r.snapshot().unwrap(), before);
    }
    call(&r,"timeline.classic.elements.update",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"updates":[{"trackId":"video-track","elementId":"item-2","patch":{"trimEnd":9007199254740991_i64}}]})).await;
    let overflow_before = r.snapshot().unwrap();
    assert!(r
        .registry()
        .invoke(
            ID,
            InvocationContext::default(),
            input(&r, json!([valid]), 600000, "both")
        )
        .await
        .is_err());
    assert_eq!(r.snapshot().unwrap(), overflow_before);
}
