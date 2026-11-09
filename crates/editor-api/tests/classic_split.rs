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

async fn bridge_setup(gap: i64, locked: bool) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"generated-bridge","name":"Bridge","type":"video","duration":2}));
    let scene = &mut classic["document"]["scenes"][0];
    scene["bookmarks"] = json!([{"time":1200000+gap,"label":"Incoming"}]);
    let tracks = &mut scene["tracks"];
    let mut right = tracks["main"]["elements"][0].clone();
    right["id"] = json!("incoming");
    right["startTime"] = json!(1200000 + gap);
    tracks["main"]["elements"]
        .as_array_mut()
        .unwrap()
        .push(right);
    tracks["audio"] = json!([{"id":"bed","type":"audio","name":"Bed","muted":false,"locked":locked,
        "elements":[{"id":"music","type":"audio","name":"Music","sourceType":"library","sourceId":"music",
        "startTime":if gap == 0 {0} else {1200000+gap}, "duration":2400000,"trimStart":12000,"trimEnd":0,"params":{}}]}]);
    tracks["overlay"] = json!([{"id":"titles","type":"text","name":"Titles","hidden":false,
        "elements":[{"id":"title","type":"text","name":"Title","startTime":if gap == 0 {600000} else {1200000+gap},
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

fn bridge_pair(runtime: &OpenCutRuntime) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":runtime.snapshot().unwrap().revision,
        "trackId":"video-track","leftId":"item-2","rightId":"incoming"})
}

#[tokio::test]
async fn replace_keeps_fractional_slot_original_sound_and_undo_and_rejects_stale_anchor() {
    let runtime = bridge_setup(0, true).await;
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
    request["mediaId"] = json!("generated-bridge");
    call(&runtime, "timeline.classic.replace.apply", request.clone()).await;
    let after = tracks(&runtime).await;
    let replacement = &after["main"]["elements"][0];
    assert_eq!(replacement["id"], original["id"]);
    assert_eq!(replacement["startTime"], original["startTime"]);
    assert_eq!(replacement["duration"], original["duration"]);
    assert_eq!(replacement["mediaId"], "generated-bridge");
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
    assert_eq!(audio["linkedAudioVideoId"], original["id"]);
    assert_eq!(replacement["linkedAudioVideoId"], audio["id"]);
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

async fn bridge_input(runtime: &OpenCutRuntime) -> Value {
    let mut pair = bridge_pair(runtime);
    let plan = call(runtime, "timeline.classic.bridge.plan", pair.clone()).await;
    pair["anchor"] = plan["anchor"].clone();
    pair["mediaId"] = json!("generated-bridge");
    pair["duration"] = json!(240000);
    pair
}

#[tokio::test]
async fn seamless_bridge_splits_sound_and_text_shifts_both_right_halves_and_undoes_once() {
    let runtime = bridge_setup(0, false).await;
    let before = tracks(&runtime).await;
    let input = bridge_input(&runtime).await;
    let result = call(&runtime, "timeline.classic.bridge.insert", input.clone()).await;
    let after = tracks(&runtime).await;
    let video = after["main"]["elements"].as_array().unwrap();
    let bridge = video
        .iter()
        .find(|clip| clip["id"] == result["elementId"])
        .unwrap();
    assert_eq!(video[0], before["main"]["elements"][0]);
    assert_eq!(video[1]["startTime"], 1440000);
    assert_eq!(bridge["startTime"], 1200000);
    assert_eq!(bridge["duration"], 240000);
    assert_eq!(bridge["isSourceAudioEnabled"], false);
    let audio = &after["audio"][0]["elements"];
    assert_eq!(audio[0]["duration"], 1200000);
    assert_eq!(audio[1]["startTime"], 1440000);
    assert_eq!(audio[1]["trimStart"], 1212000);
    assert_eq!(audio[1]["duration"], 1200000);
    let text = &after["overlay"][0]["elements"];
    assert_eq!(text[0]["duration"], 600000);
    assert_eq!(text[1]["startTime"], 1440000);
    assert_eq!(text[1]["params"]["content"], "Title");
    assert_eq!(
        call(
            &runtime,
            "app.state.read",
            json!({"pointer":"/project/classic/document/scenes/0/bookmarks/0/time"})
        )
        .await["value"],
        1440000
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(tracks(&runtime).await, before);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(tracks(&runtime).await, after);
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.classic.bridge.insert",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn seamless_bridge_can_shorten_an_empty_gap_and_rejects_locked_or_stale_timeline() {
    let runtime = bridge_setup(480000, false).await;
    let mut input = bridge_input(&runtime).await;
    let before = tracks(&runtime).await;
    let anchor = input["anchor"].clone();
    input["anchor"] = json!("stale");
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.classic.bridge.insert",
                InvocationContext::default(),
                input.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(tracks(&runtime).await, before);
    input["anchor"] = anchor;
    call(&runtime, "timeline.classic.bridge.insert", input).await;
    let after = tracks(&runtime).await;
    assert_eq!(after["audio"][0]["elements"][0]["startTime"], 1440000);
    assert_eq!(after["overlay"][0]["elements"][0]["startTime"], 1440000);
    let locked = bridge_setup(0, true).await;
    assert!(
        locked
            .registry()
            .invoke(
                "timeline.classic.bridge.plan",
                InvocationContext::default(),
                bridge_pair(&locked)
            )
            .await
            .is_err()
    );
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
    assert!(
        after["overlay"][0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["text"] == before["overlay"][0]["captionSource"]["words"][0]["text"])
    );
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
        assert!(
            r.registry()
                .invoke(
                    ID,
                    InvocationContext::default(),
                    input(&r, json!([valid, tail]), 600000, "both")
                )
                .await
                .is_err()
        );
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
    assert!(
        r.registry()
            .invoke(ID, cancelled, input(&r, json!([valid]), 600000, "both"))
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
    for (field, value) in [
        ("expectedRevision", json!(0)),
        ("projectId", json!("foreign")),
        ("splitTime", json!(1.5)),
    ] {
        let mut request = input(&r, json!([valid]), 600000, "both");
        request[field] = value;
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), request)
                .await
                .is_err()
        );
        assert_eq!(r.snapshot().unwrap(), before);
    }
    call(&r,"timeline.classic.elements.update",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"updates":[{"trackId":"video-track","elementId":"item-2","patch":{"trimEnd":9007199254740991_i64}}]})).await;
    let overflow_before = r.snapshot().unwrap();
    assert!(
        r.registry()
            .invoke(
                ID,
                InvocationContext::default(),
                input(&r, json!([valid]), 600000, "both")
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), overflow_before);
}
