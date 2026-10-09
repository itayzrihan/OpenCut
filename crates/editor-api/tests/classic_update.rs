use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let clip = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    clip["animations"] = json!({"opacity":{"extrapolation":{"before":"hold","after":"hold"},"keys":[{"id":"a","time":0,"value":0,"segmentToNext":"bezier","tangentMode":"broken","rightHandle":{"dt":800000,"dv":0.5}},{"id":"b","time":1200000,"value":1,"segmentToNext":"linear","tangentMode":"flat","leftHandle":{"dt":-800000,"dv":-0.5}}]}});
    clip["transitions"] =
        json!({"out":{"id":"fade-out","type":"fade","duration":120000,"startTime":1080000}});
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(runtime: &OpenCutRuntime, updates: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":runtime.snapshot().unwrap().revision,"updates":updates})
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(
        runtime,
        "app.state.read",
        json!({"pointer":"/project/classic/document/scenes/0/tracks"}),
    )
    .await["value"]
        .clone()
}
#[tokio::test]
async fn retime_uses_original_source_span_and_trim_curves_transitions_round_trip_through_history() {
    let runtime = setup().await;
    let before = read(&runtime).await;
    let update = json!([{"trackId":"video-track","elementId":"item-2","patch":{"retime":{"rate":2.5,"maintainPitch":true},"params":{"futureFeature":true}}}]);
    call(
        &runtime,
        "timeline.classic.elements.update",
        input(&runtime, update),
    )
    .await;
    let after = read(&runtime).await;
    let clip = &after["main"]["elements"][0];
    assert_eq!(clip["duration"], 600000);
    assert_eq!(clip["trimStart"], 480000);
    assert_eq!(clip["params"]["futureFeature"], true);
    assert_eq!(clip["transitions"]["out"]["startTime"], 480000);
    let keys = clip["animations"]["opacity"]["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[1]["time"], 600000);
    assert!((keys[1]["value"].as_f64().unwrap() - 0.5).abs() < 0.00001);
    assert_eq!(keys[0]["rightHandle"]["dt"], 400000);
    assert_eq!(clip["masks"], before["main"]["elements"][0]["masks"]);
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","persistableOnly":true}),
    )
    .await;
    let restored = OpenCutRuntime::full_access().unwrap();
    call(
        &restored,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    call(&restored, "history.undo", json!({})).await;
    assert_eq!(read(&restored).await, before);
    call(&restored, "history.redo", json!({})).await;
    assert_eq!(read(&restored).await, after);
}
#[tokio::test]
async fn batch_updates_reject_missing_duplicate_unsafe_and_identity_changes_without_partial_write()
{
    for patch in [
        json!({"duration":-1}),
        json!({"duration":1.25}),
        json!({"duration":9007199254740992_i64}),
        json!({"id":"replace-id"}),
    ] {
        let runtime = setup().await;
        let before = runtime.snapshot().unwrap();
        let updates = json!([{"trackId":"video-track","elementId":"item-2","patch":patch}]);
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.classic.elements.update",
                    InvocationContext::default(),
                    input(&runtime, updates)
                )
                .await
                .is_err()
        );
        assert_eq!(runtime.snapshot().unwrap(), before);
    }
    let runtime = setup().await;
    let before = runtime.snapshot().unwrap();
    for id in ["missing", "item-2"] {
        let updates = json!([{"trackId":"video-track","elementId":"item-2","patch":{"name":"Changed"}},{"trackId":"video-track","elementId":id,"patch":{"name":"Changed twice"}}]);
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.classic.elements.update",
                    InvocationContext::default(),
                    input(&runtime, updates)
                )
                .await
                .is_err()
        );
        assert_eq!(runtime.snapshot().unwrap(), before);
    }
    let context = InvocationContext {
        dry_run: true,
        ..InvocationContext::default()
    };
    runtime
        .registry()
        .invoke(
            "timeline.classic.elements.update",
            context,
            input(
                &runtime,
                json!([{"trackId":"video-track","elementId":"item-2","patch":{"name":"Preview"}}]),
            ),
        )
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap(), before);
}

#[tokio::test]
async fn typing_companions_segment_exact_ticks_preserve_other_audio_and_restore_history() {
    let r = setup().await;
    call(&r,"timeline.classic.elements.update",input(&r,json!([{"trackId":"titles","elementId":"text-1","patch":{"startTime":300000,"duration":1872001}}]))).await;
    call(&r,"timeline.classic.elements.insert",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"clips":[
        {"element":{"type":"audio","name":"Authored typing","sourceType":"library","libraryAssetId":"da73d7d4-9b71-4a24-84ad-f6c51034354c","startTime":300000,"duration":600000,"params":{}},"placement":{"mode":"auto","trackType":"audio"}},
        {"element":{"type":"audio","name":"Other sound","sourceType":"library","libraryAssetId":"keep-me","startTime":300000,"duration":600000,"params":{}},"placement":{"mode":"auto","trackType":"audio"}}
    ]})).await;
    let before = read(&r).await;
    let mut request = input(
        &r,
        json!([{"trackId":"titles","elementId":"text-1","patch":{"name":"Typed title","captionRevealMode":"letter-by-letter"}}]),
    );
    request["managedTypingSfx"] = json!(true);
    call(&r, "timeline.classic.elements.update", request).await;
    let after = read(&r).await;
    let audio: Vec<_> = after["audio"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
        .collect();
    assert_eq!(audio.len(), 3);
    assert!(audio.iter().any(|a| a["name"] == "Other sound"));
    assert!(!audio.iter().any(|a| a["name"] == "Authored typing"));
    let mut managed: Vec<_> = audio
        .iter()
        .filter(|a| a["params"]["opencut.typingRevealSfx.textElementId"] == "text-1")
        .collect();
    managed.sort_by_key(|a| a["startTime"].as_i64().unwrap());
    assert_eq!(managed[0]["duration"], 1872000);
    assert_eq!(managed[1]["startTime"], 2172000);
    assert_eq!(managed[1]["duration"], 1);
    assert_eq!(managed[1]["trimEnd"], 1871999);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await, before);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await, after);
    let mut disable = input(
        &r,
        json!([{"trackId":"titles","elementId":"text-1","patch":{"captionRevealMode":"row"}}]),
    );
    disable["managedTypingSfx"] = json!(false);
    call(&r, "timeline.classic.elements.update", disable).await;
    let remaining = read(&r).await;
    assert_eq!(
        remaining["audio"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["elements"].as_array().unwrap().len())
            .sum::<usize>(),
        1
    );
}
#[tokio::test]
async fn excessive_typing_segments_reject_without_changing_text_or_audio() {
    let r = setup().await;
    call(
        &r,
        "timeline.classic.elements.update",
        input(
            &r,
            json!([{"trackId":"titles","elementId":"text-1","patch":{"duration":1872000001_i64}}]),
        ),
    )
    .await;
    let before = r.snapshot().unwrap();
    let mut request = input(
        &r,
        json!([{"trackId":"titles","elementId":"text-1","patch":{"name":"Must roll back"}}]),
    );
    request["managedTypingSfx"] = json!(true);
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.elements.update",
                InvocationContext::default(),
                request
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
}
