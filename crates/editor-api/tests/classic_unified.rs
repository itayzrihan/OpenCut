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
async fn read(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn fixture() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    c["document"]["settings"]["fps"] = json!({"numerator":25,"denominator":1});
    c["mediaAssets"] = json!([
     {"id":"video-asset","name":"Long camera","type":"video","duration":3600,"hasAudio":true,"bindingRevision":3},
     {"id":"short","name":"Short camera","type":"video","duration":1800,"hasAudio":true,"bindingRevision":4},
     {"id":"unified","name":"Speaker angles","type":"video","duration":1800,"hasAudio":true,"unifiedAngles":{"version":1,"angleAssetIds":["short","video-asset"],"defaultAngleAssetId":"short","audioAssetId":"short"}}
    ]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    r
}
fn sources() -> Value {
    json!([
     {"id":"short","duration":1800,"start":50,"bindingRevision":4},
     {"id":"video-asset","duration":3600,"start":20,"bindingRevision":3}
    ])
}
async fn sync(r: &OpenCutRuntime) {
    let state = read(r).await;
    call(r,"media.classic.unified.sync",json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaId":"unified","sources":sources()})).await;
}
#[tokio::test]
async fn unified_audio_sync_preserves_long_camera_and_switches_only_overlapping_cuts() {
    let r = fixture().await;
    let before = read(&r).await;
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"mediaId":"unified","sources":sources()});
    r.registry()
        .invoke(
            "media.classic.unified.sync",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("sync-once"));
    let receipt = r
        .registry()
        .invoke("media.classic.unified.sync", ctx.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke("media.classic.unified.sync", ctx, input)
            .await
            .unwrap(),
        receipt
    );
    let state = read(&r).await;
    let asset = &state["project"]["classic"]["mediaAssets"][2];
    assert_eq!(asset["duration"], 3600.0);
    assert_eq!(asset["unifiedAngles"]["defaultAngleAssetId"], "video-asset");
    assert_eq!(asset["unifiedAngles"]["audioAssetId"], "video-asset");
    assert_eq!(asset["unifiedAngles"]["sync"]["method"], "audio");
    assert_eq!(asset["unifiedAngles"]["sync"]["sources"][0]["start"], 30.0);
    let settings = classic_podcast::podcast_multicam_defaults(
        classic_podcast::PodcastMulticamDefaultsOptions { quick: true },
    );
    call(&r,"timeline.classic.multicam.create",json!({"projectId":"classic-project","expectedRevision":state["revision"],"plan":{
  "settings":settings,"duration":3600,"channels":[{"id":"speaker","name":"Speaker","videoId":"unified","audioId":"video-asset","videoBindingRevision":1,"audioBindingRevision":3,"videoOffset":0,"audioOffset":0,"audioDelay":0}],
  "cuts":[{"timestamp":0,"duration":3600,"channelId":"speaker"}]
 }})).await;
    let state = read(&r).await;
    let scene = &state["project"]["classic"]["document"]["scenes"][2];
    let clips = scene["tracks"]["overlay"][0]["elements"]
        .as_array()
        .unwrap();
    assert_eq!(clips.len(), 3);
    assert_eq!(clips[2]["startTime"], 1830 * 120000);
    assert_eq!(clips[2]["duration"], 1770 * 120000);
    assert_eq!(clips[0]["mediaId"], "unified");
    let switch = |ids: Value, cycle: bool| json!({"projectId":"classic-project","expectedRevision":state["revision"],"sceneId":scene["id"],"mediaId":"unified","elementIds":ids,"angleAssetId":"short","cycle":cycle});
    for index in [0, 2] {
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.unified.switch",
                    InvocationContext::default(),
                    switch(json!([clips[index]["id"]]), false)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, state);
    }
    call(
        &r,
        "timeline.classic.unified.switch",
        switch(json!([clips[1]["id"]]), false),
    )
    .await;
    let switched = read(&r).await;
    assert_eq!(
        switched["project"]["classic"]["document"]["scenes"][2]["tracks"]["overlay"][0]["elements"]
            [1]["unifiedAngleId"],
        "short"
    );
    call(&r, "history.undo", json!({})).await;
    let undone = read(&r).await;
    assert_eq!(undone["project"], state["project"]);
    let mut cycling = switch(
        json!(clips.iter().map(|e| e["id"].clone()).collect::<Vec<_>>()),
        true,
    );
    cycling["expectedRevision"] = undone["revision"].clone();
    call(&r, "timeline.classic.unified.switch", cycling).await;
    let result = read(&r).await;
    let clips =
        &result["project"]["classic"]["document"]["scenes"][2]["tracks"]["overlay"][0]["elements"];
    assert_eq!(clips[0]["unifiedAngleId"], "video-asset");
    assert_eq!(clips[1]["unifiedAngleId"], "short");
    assert_eq!(clips[2]["unifiedAngleId"], "video-asset");
}
#[tokio::test]
async fn sync_rejects_stale_duplicate_or_partial_audio_results_atomically() {
    let r = fixture().await;
    let state = read(&r).await;
    for sources in [
        json!([sources()[0], sources()[0]]),
        json!([sources()[0]]),
        json!([{ "id":"short","duration":1800,"start":50,"bindingRevision":5},sources()[1]]),
    ] {
        assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaId":"unified","sources":sources})).await.is_err());
        assert_eq!(read(&r).await, state);
    }
    sync(&r).await;
    let after = read(&r).await;
    assert!(r.registry().invoke("media.classic.remove",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":after["revision"],"mediaIds":["short"],"cascade":true})).await.is_err());
    assert_eq!(read(&r).await, after);
}

async fn task(r: &OpenCutRuntime, action: &str, id: &str, extra: Value) -> Result<Value, String> {
    let s = read(r).await;
    let mut input = json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":"unified","taskId":id,"action":action});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    r.registry()
        .invoke(
            "media.classic.unified.sync_task",
            InvocationContext::default(),
            input,
        )
        .await
        .map(|r| r.result.data)
        .map_err(|e| e.to_string())
}
#[tokio::test]
async fn audio_task_progress_is_canonical_grouped_undoable_and_source_preserving() {
    let r = fixture().await;
    let before = read(&r).await;
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"mediaId":"unified","taskId":"job-a","action":"start"});
    r.registry()
        .invoke(
            "media.classic.unified.sync_task",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input,
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    task(&r, "start", "job-a", json!({})).await.unwrap();
    let output = task(
        &r,
        "progress",
        "job-a",
        json!({"progress":0.6,"stage":"Comparing waveform windows"}),
    )
    .await
    .unwrap();
    assert_eq!(output["unifiedAngles"]["syncTask"]["progress"], 0.6);
    let after = read(&r).await;
    assert_eq!(
        after["project"]["classic"]["document"],
        before["project"]["classic"]["document"]
    );
    assert_eq!(
        after["project"]["classic"]["mediaAssets"][2]["unifiedAngles"]["syncTask"]["status"],
        "running"
    );
    assert_eq!(
        after["project"]["classic"]["mediaAssets"][0],
        before["project"]["classic"]["mediaAssets"][0]
    );
    for (action, extra) in [
        ("progress", json!({"progress":0.2})),
        ("start", json!({})),
        ("progress", json!({"progress":1.1})),
    ] {
        assert!(task(&r, action, "job-a", extra).await.is_err());
        assert_eq!(read(&r).await, after);
    }
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
}
#[tokio::test]
async fn interrupted_retry_replaces_exact_task_and_rejects_all_late_results() {
    let r = fixture().await;
    task(&r, "start", "old", json!({})).await.unwrap();
    assert!(task(&r, "start", "new", json!({})).await.is_err());
    task(&r, "start", "new", json!({"replaceTaskId":"old"}))
        .await
        .unwrap();
    let before = read(&r).await;
    assert!(
        task(&r, "fail", "old", json!({"error":"late failure"}))
            .await
            .is_err()
    );
    assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":before["revision"],"mediaId":"unified","taskId":"old","sources":sources()})).await.is_err());
    assert_eq!(read(&r).await, before);
    task(
        &r,
        "fail",
        "new",
        json!({"error":"No common reference audio"}),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&r).await["project"]["classic"]["mediaAssets"][2]["unifiedAngles"]["syncTask"]["status"],
        "failed"
    );
    task(&r, "start", "retry", json!({})).await.unwrap();
    let s = read(&r).await;
    call(&r,"media.classic.unified.sync",json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":"unified","taskId":"retry","sources":sources()})).await;
    let done = read(&r).await;
    assert!(
        done["project"]["classic"]["mediaAssets"][2]["unifiedAngles"]
            .get("syncTask")
            .is_none()
    );
    assert_eq!(
        done["project"]["classic"]["mediaAssets"][2]["unifiedAngles"]["sync"]["method"],
        "audio"
    );
    assert!(
        task(&r, "progress", "retry", json!({"progress":1}))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn cancelled_jobs_cannot_apply_offsets_and_missing_camera_audio_never_claims_sync() {
    let r = fixture().await;
    task(&r, "start", "cancel", json!({})).await.unwrap();
    task(&r, "cancel", "cancel", json!({})).await.unwrap();
    let s = read(&r).await;
    assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":"unified","taskId":"cancel","sources":sources()})).await.is_err());
    assert_eq!(read(&r).await, s);
    // Invalid persisted task fields are rejected by document validation too.
    let mut classic = s["project"]["classic"].clone();
    classic["mediaAssets"][2]["unifiedAngles"]["syncTask"]["progress"] = json!(2);
    let fresh = OpenCutRuntime::default();
    assert!(
        fresh
            .registry()
            .invoke(
                "project.classic.session.attach",
                InvocationContext::default(),
                json!({"projectId":"classic-project","expectedRevision":0,"classic":classic})
            )
            .await
            .is_err()
    );
    classic = s["project"]["classic"].clone();
    classic["mediaAssets"][0]["hasAudio"] = json!(false);
    let missing = OpenCutRuntime::default();
    call(
        &missing,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    assert!(
        task(&missing, "start", "missing-audio", json!({}))
            .await
            .is_err()
    );
}

async fn with_recorder() -> OpenCutRuntime {
    let r = fixture().await;
    let s = read(&r).await;
    let mut c = s["project"]["classic"].clone();
    c["mediaAssets"].as_array_mut().unwrap().push(json!({"id":"recorder","name":"External recorder","type":"audio","duration":7200,"hasAudio":true,"bindingRevision":8}));
    call(
        &r,
        "project.classic.commit",
        json!({"projectId":"classic-project","expectedRevision":s["revision"],"classic":c}),
    )
    .await;
    r
}
fn with_audio_input(s: &Value, video: &str) -> Value {
    json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaIds":[video,"recorder"]})
}
#[tokio::test]
async fn external_audio_compound_from_single_or_unified_is_new_full_camera_clock_and_undoable() {
    for video in ["video-asset", "unified"] {
        let r = with_recorder().await;
        let before = read(&r).await;
        let input = with_audio_input(&before, video);
        let prep = call(
            &r,
            "media.classic.unified.with_audio.prepare",
            input.clone(),
        )
        .await;
        assert_eq!(prep["audioMediaId"], "recorder");
        assert_eq!(read(&r).await, before);
        r.registry()
            .invoke(
                "media.classic.unified.with_audio.create",
                InvocationContext {
                    dry_run: true,
                    ..Default::default()
                },
                input.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read(&r).await, before);
        let mut ctx = InvocationContext::default();
        ctx.metadata
            .insert("opencut/idempotencyKey".into(), json!("compound-once"));
        let receipt = r
            .registry()
            .invoke(
                "media.classic.unified.with_audio.create",
                ctx.clone(),
                input.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            r.registry()
                .invoke("media.classic.unified.with_audio.create", ctx, input)
                .await
                .unwrap(),
            receipt
        );
        let after = read(&r).await;
        let c = &after["project"]["classic"];
        assert_eq!(c["document"], before["project"]["classic"]["document"]);
        assert_eq!(
            &c["mediaAssets"].as_array().unwrap()[..4],
            before["project"]["classic"]["mediaAssets"]
                .as_array()
                .unwrap()
        );
        let a = &c["mediaAssets"][4];
        assert_eq!(a["duration"], 3600.0);
        assert_eq!(a["unifiedAngles"]["defaultAngleAssetId"], "video-asset");
        assert_eq!(a["unifiedAngles"]["audioAssetId"], "recorder");
        assert_eq!(a["unifiedAngles"]["audioFinishingVersion"], 1);
        assert_eq!(
            a["unifiedAngles"]["angleAssetIds"]
                .as_array()
                .unwrap()
                .len(),
            if video == "unified" { 2 } else { 1 }
        );
        assert!(r.registry().invoke("media.classic.remove",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":after["revision"],"mediaIds":["recorder"],"cascade":true})).await.is_err());
        assert_eq!(read(&r).await, after);
        call(&r, "history.undo", json!({})).await;
        assert_eq!(read(&r).await["project"], before["project"]);
        call(&r, "history.redo", json!({})).await;
        assert_eq!(read(&r).await["project"], after["project"]);
    }
}
#[tokio::test]
async fn external_recorder_offsets_preset_angle_switch_extract_and_reopen_keep_one_audio_clock() {
    for video in ["video-asset", "unified"] {
        let r = with_recorder().await;
        call(
            &r,
            "media.classic.unified.with_audio.create",
            with_audio_input(&read(&r).await, video),
        )
        .await;
        let s = read(&r).await;
        let id = s["project"]["classic"]["mediaAssets"][4]["id"].clone();
        let mut insert = json!({"projectId":"classic-project","expectedRevision":s["revision"],"sceneId":"main-scene","clips":[{"element":{"type":"video","mediaId":id,"name":"Teleprompter clean audio","startTime":0,"duration":5*120000,"trimStart":60*120000,"trimEnd":3530*120000,"sourceDuration":3600*120000,"retime":{"rate":2},"params":{"gainDb":0,"audioSyncOffset":-0.25}},"placement":{"mode":"auto"}}]});
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.elements.insert",
                    InvocationContext::default(),
                    insert.clone()
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, s);
        call(&r,"media.classic.unified.sync_task",json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":id,"taskId":"recorder-job","action":"start"})).await;
        let s = read(&r).await;
        let task_sources =
            &s["project"]["classic"]["mediaAssets"][4]["unifiedAngles"]["syncTask"]["sources"];
        assert_eq!(
            task_sources.as_array().unwrap().len(),
            if video == "unified" { 3 } else { 2 }
        );
        let mut clocks = vec![
            json!({"id":"video-asset","duration":3600,"start":20,"bindingRevision":3}),
            json!({"id":"recorder","duration":7200,"start":-100,"bindingRevision":8}),
        ];
        if video == "unified" {
            clocks.push(sources()[0].clone());
        }
        call(&r,"media.classic.unified.sync",json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":id,"taskId":"recorder-job","sources":clocks})).await;
        let s = read(&r).await;
        let a = &s["project"]["classic"]["mediaAssets"][4];
        assert_eq!(a["duration"], 3600.0);
        assert_eq!(a["unifiedAngles"]["audioAssetId"], "recorder");
        insert["expectedRevision"] = s["revision"].clone();
        let added = call(&r, "timeline.classic.elements.insert", insert).await;
        let target = &added["elements"][0];
        let s = read(&r).await;
        let tracks = &s["project"]["classic"]["document"]["scenes"][0]["tracks"];
        let clip = std::iter::once(&tracks["main"])
            .chain(tracks["overlay"].as_array().unwrap())
            .flat_map(|t| t["elements"].as_array().unwrap())
            .find(|e| e["id"] == target["elementId"])
            .unwrap()
            .clone();
        assert_eq!(clip["params"]["sourceAudioOffsetSeconds"], 120.0);
        assert_eq!(clip["params"]["volume"], 15);
        assert_eq!(clip["params"]["gainDb"], -1.0);
        assert_eq!(clip["params"]["noiseReduction"], 100);
        assert_eq!(clip["params"]["hardLimiterEnabled"], true);
        assert_eq!(clip["params"]["hardLimiterCeilingDb"], -1);
        assert_eq!(clip["isSourceAudioEnabled"], true);
        let timing =
            classic_timeline::resolve_clip_audio_timing(classic_timeline::ClipAudioTimingOptions {
                start_time: 0.,
                duration: 5.,
                trim_start: 60.,
                rate: 2.,
                offset_seconds: -0.25,
                source_offset_seconds: clip["params"]["sourceAudioOffsetSeconds"].as_f64(),
            });
        assert_eq!(timing.trim_start, 180.5);
        let angle = if video == "unified" {
            "short"
        } else {
            "video-asset"
        };
        call(&r,"timeline.classic.unified.switch",json!({"projectId":"classic-project","expectedRevision":s["revision"],"sceneId":"main-scene","mediaId":id,"elementIds":[target["elementId"]],"angleAssetId":angle})).await;
        let s = read(&r).await;
        let mut c = s["project"]["classic"].clone();
        let tracks = &c["document"]["scenes"][0]["tracks"];
        let switched = std::iter::once(&tracks["main"])
            .chain(tracks["overlay"].as_array().unwrap())
            .flat_map(|t| t["elements"].as_array().unwrap())
            .find(|e| e["id"] == target["elementId"])
            .unwrap();
        assert_eq!(switched["params"], clip["params"]);
        assert_eq!(switched["unifiedAngleId"], angle);
        call(&r,"timeline.classic.audio.source.edit",json!({"projectId":"classic-project","expectedRevision":s["revision"],"sceneId":"main-scene","trackId":target["trackId"],"elementId":target["elementId"],"action":"extract"})).await;
        let s = read(&r).await;
        let audios = &s["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"];
        assert!(
            audios
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|t| t["elements"].as_array().unwrap())
                .any(|e| e["mediaId"] == id
                    && e["params"]["sourceAudioOffsetSeconds"] == 120.0
                    && e["params"]["noiseReduction"] == 100)
        );
        let reopened = OpenCutRuntime::default();
        call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":s["project"]["classic"]})).await;
        assert_eq!(
            read(&reopened).await["project"]["classic"],
            s["project"]["classic"]
        );
        // A relink after cuts cannot silently replace their clock; make a new asset.
        c["mediaAssets"][3]["bindingRevision"] = json!(9);
        call(
            &r,
            "project.classic.commit",
            json!({"projectId":"classic-project","expectedRevision":s["revision"],"classic":c}),
        )
        .await;
        let stale = read(&r).await;
        clocks = vec![
            json!({"id":"video-asset","duration":3600,"start":20,"bindingRevision":3}),
            json!({"id":"recorder","duration":7200,"start":-100,"bindingRevision":9}),
        ];
        if video == "unified" {
            clocks.push(sources()[0].clone());
        }
        assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":stale["revision"],"mediaId":id,"sources":clocks})).await.is_err());
        assert_eq!(read(&r).await, stale);
    }
}

#[tokio::test]
async fn external_audio_selection_and_sync_reject_wrong_sources_or_no_overlap_atomically() {
    let r = with_recorder().await;
    let s = read(&r).await;
    for ids in [
        json!(["video-asset", "short"]),
        json!(["recorder", "recorder"]),
        json!(["recorder"]),
        json!(["unified", "not-registered"]),
    ] {
        assert!(r.registry().invoke("media.classic.unified.with_audio.create",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaIds":ids})).await.is_err());
        assert_eq!(read(&r).await, s);
    }
    call(
        &r,
        "media.classic.unified.with_audio.create",
        with_audio_input(&s, "video-asset"),
    )
    .await;
    let s = read(&r).await;
    let id = s["project"]["classic"]["mediaAssets"][4]["id"].clone();
    for audio in [
        json!({"id":"recorder","duration":7200,"start":4000,"bindingRevision":8}),
        json!({"id":"recorder","duration":7200,"start":-100,"bindingRevision":9}),
    ] {
        assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":s["revision"],"mediaId":id,"sources":[{"id":"video-asset","duration":3600,"start":0,"bindingRevision":3},audio]})).await.is_err());
        assert_eq!(read(&r).await, s);
    }
}
