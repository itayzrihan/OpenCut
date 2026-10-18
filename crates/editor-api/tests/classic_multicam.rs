use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const CREATE: &str = "timeline.classic.multicam.create";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn read(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn fixture() -> (OpenCutRuntime, Value) {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["settings"]["fps"] = json!({"numerator":25,"denominator":1});
    classic["mediaAssets"] = json!([
 {"id":"video-asset","name":"Camera A","type":"video","duration":100.0},
 {"id":"video-b","name":"Camera B","type":"video","duration":100.0},
 {"id":"mic-a","name":"Mic A","type":"audio","duration":100.0},
 {"id":"mic-b","name":"Mic B","type":"audio","duration":100.0}]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let state = read(&r).await;
    let plan = json!({"settings":classic_podcast::podcast_multicam_defaults(classic_podcast::PodcastMulticamDefaultsOptions{quick:true}),"duration":50.0,
 "channels":[{"id":"a","name":"A","videoId":"video-asset","audioId":"mic-a","videoBindingRevision":0,"audioBindingRevision":0,"videoOffset":8.8,"audioOffset":25.5,"audioDelay":0.0},{"id":"b","name":"B","videoId":"video-b","audioId":"mic-b","videoBindingRevision":0,"audioBindingRevision":0,"videoOffset":0.0,"audioOffset":0.0,"audioDelay":0.5}],
 "cuts":[{"timestamp":0.0,"duration":20.0,"channelId":"a"},{"timestamp":20.0,"duration":5.0,"channelId":"b"},{"timestamp":25.0,"duration":20.0,"channelId":"a"},{"timestamp":45.0,"duration":5.0,"channelId":"b"}]});
    (
        r,
        json!({"projectId":"classic-project","expectedRevision":state["revision"],"plan":plan}),
    )
}
#[tokio::test]
async fn canonical_creation_mutes_all_camera_audio_preserves_mics_and_undo() {
    let (r, input) = fixture().await;
    let before = read(&r).await;
    let preview = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    r.registry()
        .invoke(CREATE, preview, input.clone())
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("multicam-1"));
    let result = r
        .registry()
        .invoke(CREATE, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke(CREATE, context, input.clone())
            .await
            .unwrap(),
        result
    );
    let after = read(&r).await;
    let d = &after["project"]["classic"]["document"];
    let scene = &d["scenes"][2];
    assert_eq!(
        d["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    assert_eq!(d["currentSceneId"], scene["id"]);
    assert_eq!(scene["multicam"], input["plan"]);
    let overlays = scene["tracks"]["overlay"].as_array().unwrap();
    assert_eq!(overlays.len(), 2);
    for (i, t) in overlays.iter().enumerate() {
        assert_eq!(t["muted"], true);
        assert_eq!(t["hidden"], false);
        assert_eq!(t["elements"].as_array().unwrap().len(), 4);
        for (j, e) in t["elements"].as_array().unwrap().iter().enumerate() {
            assert_eq!(e["enabled"], (j % 2) == i);
            assert_eq!(
                e["startTime"].as_f64().unwrap(),
                input["plan"]["cuts"][j]["timestamp"].as_f64().unwrap() * 120000.0
            );
        }
        for e in t["elements"].as_array().unwrap() {
            assert_eq!(e["isSourceAudioEnabled"], false);
        }
    }
    let audio = scene["tracks"]["audio"].as_array().unwrap();
    assert_eq!(audio.len(), 2);
    assert_eq!(audio[0]["elements"].as_array().unwrap().len(), 1);
    assert_eq!(audio[0]["elements"][0]["duration"], 6000000);
    assert_eq!(audio[1]["elements"][0]["startTime"], 60000);
    assert_eq!(audio[1]["elements"][0]["duration"], 5940000);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
    let descriptor = r.registry().descriptor(CREATE).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
}
#[tokio::test]
async fn rejects_gaps_unknown_cameras_source_overflow_stale_revision_and_cancellation() {
    let (r, input) = fixture().await;
    let before = read(&r).await;
    for (pointer, value) in [
        ("/plan/cuts/1/timestamp", json!(21.0)),
        ("/plan/cuts/0/channelId", json!("missing")),
        ("/plan/channels/0/videoOffset", json!(60.0)),
        ("/projectId", json!("wrong")),
        ("/expectedRevision", json!(0)),
        ("/plan/channels/0/videoBindingRevision", json!(1)),
        ("/plan/settings/reactionDuration", json!(-1.0)),
    ] {
        let mut request = input.clone();
        *request.pointer_mut(pointer).unwrap() = value;
        assert!(
            r.registry()
                .invoke(CREATE, InvocationContext::default(), request)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(CREATE, context, input).await.is_err());
    assert_eq!(read(&r).await, before);
}

#[tokio::test]
async fn video_boundaries_snap_once_while_microphone_delay_stays_precise() {
    let (r, mut input) = fixture().await;
    input["plan"]["cuts"][0]["duration"] = json!(20.013);
    input["plan"]["cuts"][1]["timestamp"] = json!(20.013);
    input["plan"]["cuts"][1]["duration"] = json!(4.987);
    input["plan"]["channels"][1]["audioDelay"] = json!(0.513);
    call(&r, CREATE, input).await;
    let state = read(&r).await;
    let scene = &state["project"]["classic"]["document"]["scenes"][2];
    for track in scene["tracks"]["overlay"].as_array().unwrap() {
        for e in track["elements"].as_array().unwrap() {
            assert_eq!(e["startTime"].as_i64().unwrap() % 4800, 0);
            assert_eq!(e["duration"].as_i64().unwrap() % 4800, 0);
        }
    }
    assert_eq!(
        scene["tracks"]["audio"][1]["elements"][0]["startTime"],
        61560
    );
    assert_eq!(scene["multicam"]["cuts"][1]["timestamp"], 20.0);
}

#[tokio::test]
async fn registry_audio_analysis_is_read_only_and_its_plan_creates_readable_state() {
    let (r, mut input) = fixture().await;
    let before = read(&r).await;
    let result=call(&r,"timeline.classic.multicam.analyze",json!({
        "projectId":"classic-project","expectedRevision":before["revision"],
        "options":{"envelopes":[vec![0.5;5000],vec![0.0;5000]],"channelIds":["a","b"],"duration":50.0,"settings":input["plan"]["settings"]}
    })).await;
    assert_eq!(read(&r).await, before);
    assert_eq!(result["cuts"], input["plan"]["cuts"]);
    input["plan"]["cuts"] = result["cuts"].clone();
    call(&r, CREATE, input).await;
    assert_eq!(
        read(&r).await["project"]["classic"]["document"]["scenes"][2]["multicam"]["cuts"],
        result["cuts"]
    );
}

#[tokio::test]
async fn group_sync_and_six_camera_creation_use_the_canonical_registry() {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["settings"]["fps"] = json!({"numerator":25,"denominator":1});
    let mut assets = vec![];
    let mut channels = vec![];
    for i in 0..6 {
        for (prefix, kind) in [("v", "video"), ("a", "audio")] {
            assets.push(json!({"id":format!("{prefix}{i}"),"name":format!("Source {prefix}{i}"),"type":kind,"duration":100}));
        }
        channels.push(json!({"id":format!("c{i}"),"name":format!("Camera {i}"),"videoId":format!("v{i}"),"audioId":format!("a{i}"),"videoBindingRevision":0,"audioBindingRevision":0,"videoOffset":0,"audioOffset":0,"audioDelay":0}));
    }
    // Preserve the fixture's existing bindings as well as the new sources.
    classic["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .extend(assets);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&r).await;
    let signal: Vec<f32> = (0..1000)
        .map(|i| ((i * 7919 + i * i * 13) % 1009) as f32 / 1009.0)
        .collect();
    let result = call(&r,"timeline.classic.multicam.align",json!({"projectId":"classic-project","expectedRevision":before["revision"],"options":{"envelopes":vec![signal;12],"resolutionSeconds":0.01,"maxLagSeconds":3}})).await;
    assert_eq!(result["offsets"], json!(vec![0.0; 12]));
    assert_eq!(read(&r).await, before);
    call(&r,CREATE,json!({"projectId":"classic-project","expectedRevision":before["revision"],"plan":{"settings":classic_podcast::podcast_multicam_defaults(classic_podcast::PodcastMulticamDefaultsOptions{quick:true}),"channels":channels,"duration":10,"cuts":[{"timestamp":0,"duration":10,"channelId":"c0"}]}})).await;
    let after = read(&r).await;
    let scenes = after["project"]["classic"]["document"]["scenes"]
        .as_array()
        .unwrap();
    let scene = scenes.last().unwrap();
    assert_eq!(scene["multicam"]["channels"].as_array().unwrap().len(), 6);
    assert_eq!(scene["tracks"]["audio"].as_array().unwrap().len(), 6);
}

#[tokio::test]
async fn finishing_is_shared_atomic_and_preserves_existing_edit() {
    let (r, mut input) = fixture().await;
    input["finishPodcast"] = json!(true);
    call(&r, CREATE, input).await;
    let created = read(&r).await;
    let scene = &created["project"]["classic"]["document"]["scenes"][2];
    let audio = scene["tracks"]["audio"].as_array().unwrap();
    let cameras: Vec<Value> = scene["tracks"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["type"] == "video")
        .cloned()
        .collect();
    assert_eq!(cameras.len(), 2);
    for track in audio {
        let e = &track["elements"][0];
        assert_eq!(e["params"]["volume"], 15);
        assert_eq!(e["params"]["gainDb"], -1.0);
        assert_eq!(e["params"]["noiseReduction"], 100);
        assert_eq!(e["params"]["hardLimiterEnabled"], true);
        assert_eq!(e["params"]["hardLimiterCeilingDb"], -1);
        assert_eq!(e["podcastFinishingVersion"], 1);
    }
    let request = json!({"projectId":"classic-project","sceneId":scene["id"],"expectedRevision":created["revision"],"microphoneTrackIds":audio.iter().map(|t| t["id"].clone()).collect::<Vec<_>>(),"cameraTrackIds":cameras.iter().map(|t| t["id"].clone()).collect::<Vec<_>>()});
    call(&r, "timeline.classic.podcast.finish", request).await;
    let repeated = read(&r).await;
    assert_eq!(
        repeated["project"]["classic"]["document"]["scenes"],
        created["project"]["classic"]["document"]["scenes"]
    );

    // Apply to a previously created edit, keeping unrelated scenes and camera cuts.
    let (r, input) = fixture().await;
    call(&r, CREATE, input).await;
    let before = read(&r).await;
    let scene = &before["project"]["classic"]["document"]["scenes"][2];
    let request = json!({"projectId":"classic-project","sceneId":scene["id"],"expectedRevision":before["revision"],"microphoneTrackIds":scene["tracks"]["audio"].as_array().unwrap().iter().map(|t|t["id"].clone()).collect::<Vec<_>>(),"cameraTrackIds":scene["tracks"]["overlay"].as_array().unwrap().iter().map(|t|t["id"].clone()).collect::<Vec<_>>()});
    let id = "timeline.classic.podcast.finish";
    r.registry()
        .invoke(
            id,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut invalid = request.clone();
    invalid["cameraTrackIds"][0] = json!("missing");
    assert!(
        r.registry()
            .invoke(id, InvocationContext::default(), invalid)
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("finish-once"));
    let receipt = r
        .registry()
        .invoke(id, ctx.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(id, ctx, request).await.unwrap(),
        receipt
    );
    let after = read(&r).await;
    let after_scenes = &after["project"]["classic"]["document"]["scenes"];
    assert_eq!(
        after_scenes[0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    assert_eq!(
        after_scenes[1],
        before["project"]["classic"]["document"]["scenes"][1]
    );
    assert_eq!(after_scenes[2]["multicam"], scene["multicam"]);
    assert_eq!(
        after_scenes[2]["tracks"]["overlay"][1],
        scene["tracks"]["overlay"][0]
    );
    assert_eq!(
        after_scenes[2]["tracks"]["overlay"][2],
        scene["tracks"]["overlay"][1]
    );
    assert_eq!(
        after_scenes[2]["tracks"]["overlay"][0]["elements"][0]["duration"],
        6000000
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
}

#[tokio::test]
async fn short_camera_can_start_late_and_end_early_without_truncating_main_recording() {
    let (r, mut input) = fixture().await;
    let state = read(&r).await;
    let mut classic = state["project"]["classic"].clone();
    classic["mediaAssets"][1]["duration"] = json!(20.0);
    call(&r,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":state["revision"],"classic":classic})).await;
    input["expectedRevision"] = read(&r).await["revision"].clone();
    input["plan"]["channels"][1]["videoDelay"] = json!(10.0);
    input["plan"]["cuts"] = json!([
        {"channelId":"a","timestamp":0.0,"duration":15.0},
        {"channelId":"b","timestamp":15.0,"duration":10.0},
        {"channelId":"a","timestamp":25.0,"duration":25.0}
    ]);
    call(&r, CREATE, input).await;
    let after = read(&r).await;
    let scene = &after["project"]["classic"]["document"]["scenes"][2];
    assert_eq!(scene["multicam"]["duration"], 50.0);
    for clip in scene["tracks"]["overlay"][1]["elements"]
        .as_array()
        .unwrap()
    {
        let start = clip["startTime"].as_f64().unwrap() / 120000.0;
        let end = start + clip["duration"].as_f64().unwrap() / 120000.0;
        assert!(start >= 10.0 && end <= 30.0);
        assert_eq!(clip["trimStart"].as_f64().unwrap() / 120000.0, start - 10.0);
    }
}
