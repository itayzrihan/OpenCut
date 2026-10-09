use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
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
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"] = json!({"opacity":{"keys":[{"id":"old-opacity","time":0,"value":0.5}]},"audioSyncOffset":{"keys":[{"id":"retain","time":0,"value":0.25}]}});
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn input(r: &OpenCutRuntime, preset: &str, side: &str) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"applications":[{"trackId":"video-track","elementId":"item-2","presetId":preset,"side":side}]})
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
async fn shared_catalog_all_presets_anchor_at_edges_and_preserve_unrelated_state_and_history() {
    let r = setup().await;
    let first = call(
        &r,
        "timeline.classic.transitions.catalog",
        json!({"limit":50}),
    )
    .await;
    let definitions: Vec<Value> = serde_json::from_str(include_str!(
        "../../../classic/rust/crates/timeline/data/transition-presets.json"
    ))
    .unwrap();
    assert_eq!(first["total"].as_u64().unwrap() as usize, definitions.len());
    let mut page = first;
    let mut presets = vec![];
    loop {
        presets.extend(page["presets"].as_array().unwrap().iter().cloned());
        if page["hasMore"] == false {
            break;
        }
        page = call(
            &r,
            "timeline.classic.transitions.catalog",
            json!({"limit":50,"offset":presets.len()}),
        )
        .await;
    }
    assert_eq!(presets.len(), definitions.len());
    let before = tracks(&r).await;
    for preset in presets {
        for side in ["in", "out"] {
            call(
                &r,
                "timeline.classic.transitions.apply",
                input(&r, preset["id"].as_str().unwrap(), side),
            )
            .await;
            let after = tracks(&r).await;
            let clip = &after["main"]["elements"][0];
            assert_eq!(clip["masks"], before["main"]["elements"][0]["masks"]);
            assert_eq!(
                clip["animations"]["audioSyncOffset"],
                before["main"]["elements"][0]["animations"]["audioSyncOffset"]
            );
            if preset["id"] != "none" {
                let expected = if preset["id"] == "flicker" {
                    120000
                } else {
                    60000
                };
                assert_eq!(clip["transitions"][side]["duration"], expected);
                assert_eq!(
                    clip["transitions"][side]["startTime"],
                    if side == "in" { 0 } else { 1200000 - expected }
                );
                assert_eq!(clip["transitions"][side]["placement"], side);
            }
            call(&r, "history.undo", json!({})).await;
            assert_eq!(tracks(&r).await, before);
        }
    }
    call(
        &r,
        "timeline.classic.transitions.apply",
        input(&r, "fade", "out"),
    )
    .await;
    let after = tracks(&r).await;
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
async fn invalid_transition_batches_duration_preset_scope_and_cancel_are_atomic() {
    let r = setup().await;
    let before = r.snapshot().unwrap();
    for bad in [
        json!({"trackId":"video-track","elementId":"missing","presetId":"fade","side":"in"}),
        json!({"trackId":"video-track","elementId":"item-2","presetId":"unknown","side":"in"}),
        json!({"trackId":"video-track","elementId":"item-2","presetId":"fade","side":"out","duration":1200001}),
    ] {
        let mut request = input(&r, "fade", "in");
        request["applications"].as_array_mut().unwrap().push(bad);
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.transitions.apply",
                    InvocationContext::default(),
                    request
                )
                .await
                .is_err()
        );
        assert_eq!(r.snapshot().unwrap(), before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.transitions.apply",
                cancelled,
                input(&r, "fade", "in")
            )
            .await
            .is_err()
    );
    r.registry()
        .invoke(
            "timeline.classic.transitions.apply",
            InvocationContext {
                dry_run: true,
                ..InvocationContext::default()
            },
            input(&r, "fade", "in"),
        )
        .await
        .unwrap();
    assert_eq!(r.snapshot().unwrap(), before);
    let mut foreign = input(&r, "fade", "in");
    foreign["projectId"] = json!("foreign");
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.transitions.apply",
                InvocationContext::default(),
                foreign
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
}

#[tokio::test]
async fn managed_text_companions_use_shared_definition_and_atomic_history() {
    let r = setup().await;
    let before = tracks(&r).await;
    let request = |revision| json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,"managedTextSfx":true,"applications":[{"trackId":"titles","elementId":"text-1","presetId":"flicker","side":"in"}]});
    call(
        &r,
        "timeline.classic.transitions.apply",
        request(r.snapshot().unwrap().revision),
    )
    .await;
    let applied = tracks(&r).await;
    let clip = &applied["audio"][0]["elements"][0];
    assert_eq!(
        clip["params"]["opencut.textTransitionSfx.textElementId"],
        "text-1"
    );
    assert_eq!(clip["params"]["volume"], -13);
    assert_eq!(clip["startTime"], 0);
    assert_eq!(clip["duration"], 67540);
    assert_eq!(clip["trimStart"], 24000);
    assert_eq!(
        applied["overlay"][0]["elements"][0]["transitions"]["in"]["duration"],
        12000
    );
    let mut bad = request(r.snapshot().unwrap().revision);
    bad["applications"]
        .as_array_mut()
        .unwrap()
        .push(json!({"trackId":"titles","elementId":"missing","presetId":"pop","side":"in"}));
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.transitions.apply",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err()
    );
    assert_eq!(tracks(&r).await, applied);
    // Replacing companions must not accumulate a second SFX clip.
    call(
        &r,
        "timeline.classic.transitions.apply",
        request(r.snapshot().unwrap().revision),
    )
    .await;
    assert_eq!(
        tracks(&r).await["audio"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["elements"].as_array().unwrap().len())
            .sum::<usize>(),
        1
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(tracks(&r).await, applied);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(tracks(&r).await, before);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(tracks(&r).await, applied);
}
