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

async fn ripple_fixture(locked: bool) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let scene = &mut classic["document"]["scenes"][0];
    let video = scene["tracks"]["main"]["elements"][0].clone();
    scene["tracks"]["main"]["elements"] = json!(
        (0..3)
            .map(|index| {
                let mut clip = video.clone();
                clip["id"] = json!(format!("clip-{index}"));
                clip["startTime"] = json!(index * 240000);
                clip["duration"] = json!(240000);
                clip["trimStart"] = json!(index * 240000);
                clip["trimEnd"] = json!((2 - index) * 240000);
                clip
            })
            .collect::<Vec<_>>()
    );
    let caption = &mut scene["tracks"]["overlay"][0];
    caption["locked"] = json!(locked);
    caption["elements"][0]["startTime"] = json!(360000);
    caption["elements"][0]["duration"] = json!(120000);
    caption["elements"][0]["wordRuns"] =
        json!([{"id":"later-word","text":"later","lineIndex":0,"startTime":0,"endTime":120000}]);
    caption["captionSource"]["words"] =
        json!([{"text":"cut","start":0.5,"end":1.0},{"text":"later","start":3.0,"end":4.0}]);
    scene["bookmarks"] = json!([{"time":600000,"note":"end cue"}]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
#[tokio::test]
async fn explicit_ripple_delete_closes_only_selected_time_with_captions_markers_and_undo() {
    for ripple in [false, true] {
        let runtime = ripple_fixture(false).await;
        let before = read(&runtime).await;
        let request = input(
            &before,
            json!({"type":"elements","ripple":ripple,"elements":[{"trackId":"video-track","elementId":"clip-0"}]}),
        );
        runtime
            .registry()
            .invoke(
                ID,
                InvocationContext {
                    dry_run: true,
                    ..Default::default()
                },
                request.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read(&runtime).await, before);
        call(&runtime, ID, request).await;
        let after = read(&runtime).await;
        let scene = &after["project"]["classic"]["document"]["scenes"][0];
        let tracks = &scene["tracks"];
        assert_eq!(tracks["main"]["elements"].as_array().unwrap().len(), 2);
        assert_eq!(
            tracks["main"]["elements"][0]["startTime"],
            if ripple { 0 } else { 240000 }
        );
        assert_eq!(tracks["main"]["elements"][0]["trimStart"], 240000);
        assert_eq!(tracks["main"]["elements"][0]["duration"], 240000);
        assert_eq!(
            tracks["overlay"][0]["elements"][0]["startTime"],
            if ripple { 120000 } else { 360000 }
        );
        assert_eq!(
            scene["bookmarks"][0]["time"],
            if ripple { 360000 } else { 600000 }
        );
        if ripple {
            assert_eq!(
                tracks["overlay"][0]["captionSource"]["words"],
                json!([{"text":"later","start":1.0,"end":2.0}])
            );
        }
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], before["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], after["project"]);
    }
}
#[tokio::test]
async fn ripple_delete_merges_duplicate_ranges_and_rejects_locked_companions() {
    let runtime = ripple_fixture(false).await;
    let before = read(&runtime).await;
    call(
        &runtime,
        ID,
        input(
            &before,
            json!({"type":"elements","ripple":true,"elements":[
                {"trackId":"video-track","elementId":"clip-0"},
                {"trackId":"video-track","elementId":"clip-0"},
                {"trackId":"video-track","elementId":"clip-2"}
            ]}),
        ),
    )
    .await;
    let after = read(&runtime).await;
    let clips = &after["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"];
    assert_eq!(clips.as_array().unwrap().len(), 1);
    assert_eq!(clips[0]["id"], "clip-1");
    assert_eq!(clips[0]["startTime"], 0);
    assert_eq!(clips[0]["duration"], 240000);
    let runtime = ripple_fixture(true).await;
    let before = read(&runtime).await;
    assert!(runtime.registry().invoke(ID, InvocationContext::default(), input(&before, json!({"type":"elements","ripple":true,"elements":[{"trackId":"video-track","elementId":"clip-0"}]}))).await.is_err());
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn same_point_preserves_other_tracks_and_clip_payloads_with_history_and_retry() {
    let runtime = ripple_fixture(true).await; // An unrelated locked intro is allowed.
    let before = read(&runtime).await;
    let request = input(
        &before,
        json!({"type":"elements","samePoint":true,"elements":[
            {"trackId":"video-track","elementId":"clip-0"},
            {"trackId":"video-track","elementId":"clip-0"}
        ]}),
    );
    runtime
        .registry()
        .invoke(
            ID,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("same-point"));
    let receipt = runtime
        .registry()
        .invoke(ID, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(ID, context, request)
            .await
            .unwrap(),
        receipt
    );
    let after = read(&runtime).await;
    let mut expected = before["project"].clone();
    let clips = expected["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"]
        .as_array_mut()
        .unwrap();
    clips.remove(0);
    for clip in clips {
        clip["startTime"] = json!(clip["startTime"].as_i64().unwrap() - 240000);
    }
    assert_eq!(after["project"], expected); // Everything except removal/start times is identical.
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn same_point_handles_multiple_tracks_intervals_overlaps_and_empty_tracks() {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    let video = tracks["main"]["elements"][0].clone();
    let make = |id: &str, start: i64, duration: i64| {
        let mut clip = video.clone();
        clip["id"] = json!(id);
        clip["startTime"] = json!(start);
        clip["duration"] = json!(duration);
        clip
    };
    tracks["main"]["elements"] = json!([
        make("before", 0, 120000),
        make("remove-a", 240000, 240000),
        make("overlap", 360000, 120000),
        make("middle", 480000, 120000),
        make("remove-b", 720000, 120000),
        make("remove-c", 780000, 120000),
        make("after", 960000, 120000)
    ]);
    let mut second = tracks["main"].clone();
    second["id"] = json!("camera-2");
    second["elements"] = json!([
        make("second-remove", 240000, 120000),
        make("second-after", 480000, 120000)
    ]);
    tracks["overlay"].as_array_mut().unwrap().push(second);
    tracks["order"] = json!(["titles", "camera-2", "video-track"]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&runtime).await;
    call(
        &runtime,
        ID,
        input(
            &before,
            json!({"type":"elements","samePoint":true,"elements":[
                {"trackId":"video-track","elementId":"remove-a"},
                {"trackId":"video-track","elementId":"remove-b"},
                {"trackId":"video-track","elementId":"remove-c"},
                {"trackId":"camera-2","elementId":"second-remove"}
            ]}),
        ),
    )
    .await;
    let after = read(&runtime).await;
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    let mut expected = before["project"]["classic"]["document"]["scenes"][0]["tracks"].clone();
    expected["main"]["elements"] = json!([
        make("before", 0, 120000),
        make("overlap", 360000, 120000),
        make("middle", 240000, 120000),
        make("after", 540000, 120000)
    ]);
    expected["overlay"][1]["elements"] = json!([make("second-after", 360000, 120000)]);
    assert_eq!(tracks, &expected);
    call(&runtime, ID, input(&after, json!({"type":"elements","samePoint":true,"elements":[{"trackId":"camera-2","elementId":"second-after"}]}))).await;
    let empty = read(&runtime).await;
    assert_eq!(
        empty["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][1]["elements"],
        json!([])
    );
}

#[tokio::test]
async fn same_point_rejects_conflicts_missing_targets_locked_tracks_stale_and_cancelled() {
    let runtime = ripple_fixture(true).await;
    let before = read(&runtime).await;
    let valid = json!({"type":"elements","samePoint":true,"elements":[{"trackId":"video-track","elementId":"clip-0"}]});
    let mut conflicting = valid.clone();
    conflicting["ripple"] = json!(true);
    for removal in [
        conflicting,
        json!({"type":"elements","samePoint":true,"elements":[{"trackId":"titles","elementId":"text-1"}]}),
        json!({"type":"elements","samePoint":true,"elements":[{"trackId":"video-track","elementId":"clip-0"},{"trackId":"missing","elementId":"missing"}]}),
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
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(ID, cancelled, input(&before, valid.clone()))
            .await
            .is_err()
    );
    let mut stale = input(&before, valid);
    stale["expectedRevision"] = json!(0);
    assert!(
        runtime
            .registry()
            .invoke(ID, InvocationContext::default(), stale)
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn same_point_moves_selected_caption_tracks_without_rewriting_other_caption_copies() {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    let first = &mut tracks["overlay"][0]["elements"][0];
    first["wordRuns"] =
        json!([{"id":"word-1","text":"שלום","startTime":0,"endTime":120000,"lineIndex":0}]);
    let mut later = first.clone();
    later["id"] = json!("later-caption");
    later["startTime"] = json!(240000);
    later["wordRuns"][0]["id"] = json!("later-word");
    tracks["overlay"][0]["elements"]
        .as_array_mut()
        .unwrap()
        .push(later);
    tracks["overlay"][0]["captionSource"]["words"] = json!([
        {"text":"שלום","start":0,"end":1},{"text":"שלום","start":2,"end":3}
    ]);
    let mut copy = tracks["overlay"][0].clone();
    copy["id"] = json!("caption-copy");
    for e in copy["elements"].as_array_mut().unwrap() {
        e["id"] = json!(format!("copy-{}", e["id"].as_str().unwrap()));
    }
    tracks["overlay"].as_array_mut().unwrap().push(copy);
    tracks["order"] = json!(["titles", "caption-copy", "video-track"]);
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&runtime).await;
    call(&runtime,ID,input(&before,json!({"type":"elements","samePoint":true,"elements":[{"trackId":"titles","elementId":"text-1"}]}))).await;
    let after = read(&runtime).await;
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    assert_eq!(tracks["overlay"][0]["elements"][0]["startTime"], 120000);
    assert_eq!(
        tracks["overlay"][0]["captionSource"]["words"],
        json!([{"text":"שלום","start":1.0,"end":2.0}])
    );
    assert_eq!(
        tracks["overlay"][1],
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][1]
    );
}
