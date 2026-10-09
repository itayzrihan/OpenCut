use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{json, Value};
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup(above: bool) -> OpenCutRuntime {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    if above {
        let tracks = &mut classic["document"]["scenes"][0]["tracks"];
        tracks["overlay"].as_array_mut().unwrap().push(json!({"id":"above-video","name":"Layer","type":"video","hidden":false,"muted":false,"elements":[]}));
        tracks["order"] = json!(["titles", "above-video", "video-track"]);
    }
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"] =
        json!({"opacity":{"keys":[{"id":"old-key","time":0,"value":0.5}]}});
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn input(r: &OpenCutRuntime, duplicate: bool) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"trackId":"video-track","elementId":"item-2","settings":{"mode":"blur","quality":"precise","maskThreshold":2,"edgeFeather":10},"duplicate":duplicate})
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
async fn background_settings_and_person_layer_reuse_existing_policy_and_round_trip_history() {
    for (duplicate, above) in [(false, false), (true, false), (true, true)] {
        let r = setup(above).await;
        let before = tracks(&r).await;
        let result = call(
            &r,
            "timeline.classic.background_removal.set",
            input(&r, duplicate),
        )
        .await;
        let after = tracks(&r).await;
        assert_eq!(result["createdTrack"], duplicate && !above);
        let track_id = result["target"]["trackId"].as_str().unwrap();
        let element_id = result["target"]["elementId"].as_str().unwrap();
        let track = if track_id == "video-track" {
            &after["main"]
        } else {
            after["overlay"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == track_id)
                .unwrap()
        };
        let clip = track["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == element_id)
            .unwrap();
        assert_eq!(clip["backgroundRemoval"]["quality"], "precise");
        assert_eq!(clip["backgroundRemoval"]["edgeFeather"], 8.0);
        assert!((clip["backgroundRemoval"]["maskThreshold"].as_f64().unwrap() - 0.95).abs() < 1e-6);
        assert_eq!(clip["masks"], before["main"]["elements"][0]["masks"]);
        assert_eq!(clip["retime"], before["main"]["elements"][0]["retime"]);
        if duplicate {
            assert_eq!(after["main"], before["main"]);
            assert_eq!(clip["isSourceAudioEnabled"], false);
            assert_ne!(clip["animations"]["opacity"]["keys"][0]["id"], "old-key");
            if above {
                assert_eq!(track_id, "above-video");
            }
        }
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
}
#[tokio::test]
async fn background_configuration_rejects_scope_kind_settings_and_stale_or_cancelled_calls_atomically(
) {
    let r = setup(false).await;
    let before = r.snapshot().unwrap();
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("expectedRevision", json!(0)),
        ("trackId", json!("titles")),
        ("elementId", json!("missing")),
        ("settings", json!({"quality":"unknown"})),
        ("settings", json!({"futureUnexpected":true})),
    ] {
        let mut request = input(&r, true);
        request[field] = value;
        assert!(r
            .registry()
            .invoke(
                "timeline.classic.background_removal.set",
                InvocationContext::default(),
                request
            )
            .await
            .is_err());
        assert_eq!(r.snapshot().unwrap(), before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(r
        .registry()
        .invoke(
            "timeline.classic.background_removal.set",
            cancelled,
            input(&r, true)
        )
        .await
        .is_err());
    assert_eq!(r.snapshot().unwrap(), before);
    r.registry()
        .invoke(
            "timeline.classic.background_removal.set",
            InvocationContext {
                dry_run: true,
                ..InvocationContext::default()
            },
            input(&r, true),
        )
        .await
        .unwrap();
    assert_eq!(r.snapshot().unwrap(), before);
}
