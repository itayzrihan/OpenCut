use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(r: &OpenCutRuntime, id: &str, v: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), v)
        .await
        .unwrap()
        .result
        .data
}
async fn state(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn setup(cuts: usize) -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let s = &mut c["document"]["scenes"][0];
    let mut original = s["tracks"]["main"]["elements"][0].clone();
    original["retime"] = json!({"rate":1});
    original["trimStart"] = json!(0);
    original["trimEnd"] = json!(0);
    original["params"]["audioSyncOffset"] = json!(0);
    s["tracks"]["main"]["elements"] = json!([]);
    let mut cameras = vec![];
    for camera in 0..2 {
        let elements = (0..cuts)
            .map(|i| {
                let mut e = original.clone();
                e["id"] = json!(format!("camera-{camera}-{i}"));
                e["startTime"] = json!(i as i64 * 60000);
                e["duration"] = json!(60000);
                e["trimStart"] = json!(i as i64 * 60000);
                e["enabled"] = json!(i % 2 == camera);
                e["params"]["volume"] = json!(0);
                e
            })
            .collect::<Vec<_>>();
        cameras.push(json!({"id":format!("camera-track-{camera}"),"type":"video","name":"Routed camera","muted":true,"hidden":false,"elements":elements}));
    }
    let words = (0..cuts * 2)
        .map(|i| json!({"text":format!("word{i}"),"start":i as f64*0.25,"end":i as f64*0.25+0.2}))
        .collect::<Vec<_>>();
    cameras.push(json!({"id":"captions","type":"text","name":"Captions","hidden":false,"elements":[],"captionSource":{"sourceId":"podcast-source","words":words,"settings":{}}}));
    s["tracks"]["overlay"] = json!(cameras);
    s["tracks"]["audio"] = json!([{"id":"voice","type":"audio","name":"Voice","muted":false,"elements":[{"id":"voice-clip","type":"audio","mediaId":"video-asset","startTime":0,"duration":cuts as i64*60000,"trimStart":240000,"trimEnd":0,"params":{"volume":0.8,"audioSyncOffset":0.1}}]}]);
    s["tracks"]["order"] = json!([
        "captions",
        "camera-track-0",
        "camera-track-1",
        "video-track",
        "voice"
    ]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    r
}
fn binding(s: &Value, ids: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":s["revision"],"elementIds":ids})
}
fn proposal(parts: Value) -> Value {
    json!({"title":"Concrete answer","openingHook":"An actual question","endingHook":"Specific payoff","confidence":0.9,"alternatives":[{"label":"Reviewed","reason":"Complete idea","parts":parts}]})
}
fn extraction(s: &Value, ids: Value, mode: &str, parts: Value) -> Value {
    let mut b = binding(s, ids);
    b["options"] = json!({"mode":mode,"minSeconds":20,"maxSeconds":90,"maxOutputs":1});
    b["videos"] = json!([proposal(parts)]);
    b
}
#[tokio::test]
async fn edited_overlay_multicam_whole_timeline_has_one_word_clock_and_preserves_camera_cuts_and_audio()
 {
    for mode in ["teaser", "highlights", "chronological"] {
        let r = setup(360).await;
        let before = state(&r).await;
        let b = binding(&before, json!([]));
        let src = call(&r, "timeline.classic.podcast.prepare", b.clone()).await;
        assert_eq!(src["words"].as_array().unwrap().len(), 720);
        assert_eq!(src["referenceRegions"].as_array().unwrap().len(), 1);
        assert_eq!(src["audioInputs"].as_array().unwrap().len(), 1);
        assert_eq!(
            src["audioInputs"][0]["clip"]["params"]["audioSyncOffset"],
            0
        );
        assert_eq!(src["words"][0]["clipId"], src["words"][719]["clipId"]);
        assert_eq!(state(&r).await, before);
        call(
            &r,
            "timeline.classic.podcast.extract",
            extraction(
                &before,
                json!([]),
                mode,
                json!([{"firstWord":80,"lastWord":179}]),
            ),
        )
        .await;
        let after = state(&r).await;
        let scenes = after["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap();
        assert_eq!(
            &scenes[..2],
            before["project"]["classic"]["document"]["scenes"]
                .as_array()
                .unwrap()
        );
        let output = scenes.last().unwrap();
        assert!(
            output["tracks"]["main"]["elements"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let camera_elements = output["tracks"]["overlay"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["type"] == "video")
            .flat_map(|t| t["elements"].as_array().unwrap())
            .collect::<Vec<_>>();
        assert!(camera_elements.len() >= 100);
        assert!(camera_elements.iter().any(|e| e["enabled"] == false));
        assert!(camera_elements.iter().any(|e| e["enabled"] == true));
        assert!(
            camera_elements
                .iter()
                .all(|e| e["trimStart"].as_i64().unwrap() >= 198 * 12000
                    && e["trimStart"].as_i64().unwrap() < 46 * 120000)
        );
        assert_eq!(
            output["tracks"]["audio"][0]["elements"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            output["tracks"]["audio"][0]["elements"][0]["params"]["volume"],
            0.8
        );
        assert_eq!(output["takeAssembly"]["version"], 3);
        let reopened = OpenCutRuntime::default();
        call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
        call(&r, "history.undo", json!({})).await;
        assert_eq!(state(&r).await["project"], before["project"]);
    }
}
#[tokio::test]
async fn sparse_selection_is_a_hard_reference_for_analysis_context_and_output_handles() {
    let r = setup(360).await;
    let before = state(&r).await;
    let ids = (0..60)
        .chain(120..180)
        .map(|i| json!(format!("camera-{}-{i}", i % 2)))
        .collect::<Vec<_>>();
    let src = call(
        &r,
        "timeline.classic.podcast.prepare",
        binding(&before, json!(ids)),
    )
    .await;
    assert_eq!(src["words"].as_array().unwrap().len(), 240);
    assert_eq!(src["referenceRegions"].as_array().unwrap().len(), 2);
    assert!(src["words"].as_array().unwrap().iter().all(|w| {
        let s = w["start"].as_i64().unwrap();
        let e = w["end"].as_i64().unwrap();
        (s >= 0 && e <= 30 * 120000) || (s >= 60 * 120000 && e <= 90 * 120000)
    }));
    for input in src["audioInputs"].as_array().unwrap() {
        let s = input["clip"]["startTime"].as_i64().unwrap();
        let e = s + input["clip"]["duration"].as_i64().unwrap();
        assert!((s >= 0 && e <= 30 * 120000) || (s >= 60 * 120000 && e <= 90 * 120000));
    }
    for mode in ["teaser", "highlights", "chronological"] {
        let mut input = extraction(
            &before,
            json!(ids),
            mode,
            json!([{"firstWord":0,"lastWord":239}]),
        );
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.podcast.review",
                    InvocationContext::default(),
                    input.clone()
                )
                .await
                .is_err()
        );
        input["videos"] = json!([proposal(
            json!([{"firstWord":0,"lastWord":59},{"firstWord":120,"lastWord":179}])
        )]);
        call(&r, "timeline.classic.podcast.review", input.clone()).await;
        if mode == "chronological" {
            call(&r, "timeline.classic.podcast.extract", input).await;
            let after = state(&r).await;
            let out = after["project"]["classic"]["document"]["scenes"]
                .as_array()
                .unwrap()
                .last()
                .unwrap();
            for t in out["takeAssembly"]["referenceRegions"].as_array().unwrap() {
                assert!(
                    t["end"].as_i64().unwrap() <= 30 * 120000
                        || t["start"].as_i64().unwrap() >= 60 * 120000
                );
            }
            for t in out["tracks"]["overlay"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| t["type"] == "video")
            {
                for e in t["elements"].as_array().unwrap() {
                    let a = e["trimStart"].as_i64().unwrap();
                    let b = a + e["duration"].as_i64().unwrap();
                    assert!(b <= 30 * 120000 || a >= 60 * 120000);
                }
            }
        }
    }
}
#[tokio::test]
async fn stale_selection_never_falls_back_to_whole_episode_and_scope_is_not_a_mutation() {
    let r = setup(120).await;
    let before = state(&r).await;
    let mut missing = binding(&before, json!(["deleted-clip"]));
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.podcast.scope",
                InvocationContext::default(),
                missing.clone()
            )
            .await
            .is_err()
    );
    missing["elementIds"] = json!(["voice-clip"]);
    let scope = call(&r, "timeline.classic.podcast.scope", missing.clone()).await;
    assert_eq!(scope["referenceRegions"][0]["end"], 60 * 120000);
    missing["expectedRevision"] = json!(999);
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.podcast.scope",
                InvocationContext::default(),
                missing
            )
            .await
            .is_err()
    );
    assert_eq!(state(&r).await, before);
}
#[tokio::test]
async fn selected_transcription_masks_media_skips_excluded_sections_and_filters_hallucinated_words()
{
    let r = setup(360).await;
    let mut classic = state(&r).await["project"]["classic"].clone();
    classic["document"]["scenes"][0]["tracks"]["overlay"][2]["captionSource"]["words"] = json!([]);
    let isolated = OpenCutRuntime::default();
    call(
        &isolated,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = state(&isolated).await;
    let ids = (240..300)
        .map(|i| json!(format!("camera-{}-{i}", i % 2)))
        .collect::<Vec<_>>();
    let scope = call(
        &isolated,
        "timeline.classic.podcast.scope",
        binding(&before, json!(ids)),
    )
    .await;
    assert_eq!(scope["hasTranscript"], false);
    let change = json!({"type":"start","referenceElementIds":ids,"sceneId":"main-scene","language":"he","settings":{"wordsPerRow":3,"rows":1},"defaults":{"element":{"type":"text","trimStart":0,"trimEnd":0,"params":{"opacity":1}},"bottomFadeOutEndOpacity":0.25},"totalDuration":180*120000});
    call(&isolated,"transcription.classic.edit",json!({"projectId":"classic-project","expectedRevision":before["revision"],"jobId":"selected-speech","change":change})).await;
    let started = state(&isolated).await;
    let job = &started["project"]["classic"]["document"]["transcriptionJobs"][0];
    assert_eq!(job["totalDuration"], 150 * 120000);
    assert_eq!(job["chunks"]["0"], json!([]));
    assert_eq!(job["chunks"]["1"], json!([]));
    for t in std::iter::once(&job["sourceTracks"]["main"])
        .chain(job["sourceTracks"]["overlay"].as_array().unwrap())
        .chain(job["sourceTracks"]["audio"].as_array().unwrap())
    {
        for e in t["elements"].as_array().unwrap() {
            let a = e["startTime"].as_i64().unwrap();
            let b = a + e["duration"].as_i64().unwrap();
            assert!(a >= 120 * 120000 && b <= 150 * 120000);
        }
    }
    assert_eq!(
        started["project"]["classic"]["document"]["scenes"],
        before["project"]["classic"]["document"]["scenes"]
    );
    let pending = call(
        &isolated,
        "timeline.classic.podcast.scope",
        binding(&started, json!(ids)),
    )
    .await;
    assert_eq!(pending["resumeJobId"], "selected-speech");
    call(&isolated,"transcription.classic.edit",json!({"projectId":"classic-project","expectedRevision":started["revision"],"jobId":"selected-speech","change":{"type":"append","index":2,"words":[{"text":"excluded-before","start":119.8,"end":120.1},{"text":"kept","start":121.0,"end":122.0},{"text":"excluded-after","start":149.9,"end":151.0}]}})).await;
    let done = state(&isolated).await;
    let words = &done["project"]["classic"]["document"]["transcriptionJobs"][0]["chunks"]["2"];
    assert_eq!(words.as_array().unwrap().len(), 1);
    assert_eq!(words[0]["text"], "kept");
    let ready = call(
        &isolated,
        "timeline.classic.podcast.scope",
        binding(&done, json!(ids)),
    )
    .await;
    assert_eq!(ready["hasTranscript"], true);
    let all = call(
        &isolated,
        "timeline.classic.podcast.scope",
        binding(&done, json!([])),
    )
    .await;
    assert_eq!(
        all["hasTranscript"], false,
        "A partial scoped transcript must never impersonate a full episode transcript"
    );
    let prepared = call(
        &isolated,
        "timeline.classic.podcast.prepare",
        binding(&done, json!(ids)),
    )
    .await;
    assert_eq!(prepared["words"].as_array().unwrap().len(), 1);
    assert_eq!(prepared["words"][0]["text"], "kept");
}
#[tokio::test]
async fn select_all_with_captions_and_caption_only_scopes_survive_compact_archives_and_alternative_selection()
 {
    for caption_only in [false, true] {
        let r = setup(120).await;
        let mut c = state(&r).await["project"]["classic"].clone();
        c["document"]["scenes"][0]["tracks"]["overlay"][2]["elements"] = json!([{"id":"cue-first","type":"text","name":"Early caption","startTime":0,"duration":30*120000,"trimStart":0,"trimEnd":0,"params":{"content":"Early","fontFamily":"Arial"}},{"id":"cue-late","type":"text","name":"Late caption","startTime":30*120000,"duration":30*120000,"trimStart":0,"trimEnd":0,"params":{"content":"Late","fontFamily":"Arial"}}]);
        let runtime = OpenCutRuntime::default();
        call(
            &runtime,
            "project.classic.session.attach",
            json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
        )
        .await;
        let before = state(&runtime).await;
        let ids = if caption_only {
            json!(["cue-late"])
        } else {
            json!(
                (0..120)
                    .map(|i| json!(format!("camera-{}-{i}", i % 2)))
                    .chain([json!("voice-clip"), json!("cue-first"), json!("cue-late")])
                    .collect::<Vec<_>>()
            )
        };
        let source = call(
            &runtime,
            "timeline.classic.podcast.prepare",
            binding(&before, ids.clone()),
        )
        .await;
        assert_eq!(
            source["referenceRegions"][0]["start"],
            if caption_only { 30 * 120000 } else { 0 }
        );
        call(
            &runtime,
            "timeline.classic.podcast.extract",
            extraction(
                &before,
                ids,
                "chronological",
                json!([{"firstWord":0,"lastWord":99}]),
            ),
        )
        .await;
        let after = state(&runtime).await;
        let scenes = after["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap();
        let output = scenes.last().unwrap();
        assert_eq!(
            &scenes[..2],
            before["project"]["classic"]["document"]["scenes"]
                .as_array()
                .unwrap()
        );
        assert_eq!(
            output["takeAssembly"]["sourceTracks"]["overlay"][2]["elements"]
                .as_array()
                .unwrap()
                .len(),
            if caption_only { 2 } else { 1 }
        );
        let target = output["id"].clone();
        call(&runtime,"timeline.classic.takes.edit",json!({"projectId":"classic-project","sceneId":target,"expectedRevision":after["revision"],"change":{"type":"select","groupIndex":0,"alternativeIndex":0}})).await;
        assert_eq!(
            state(&runtime).await["project"]["classic"]["document"]["scenes"][0],
            before["project"]["classic"]["document"]["scenes"][0]
        );
    }
}
#[tokio::test]
async fn out_of_scope_audio_evidence_rejects_atomically_and_missing_microphone_coverage_is_not_silence()
 {
    let r = setup(120).await;
    let before = state(&r).await;
    let source = call(
        &r,
        "timeline.classic.podcast.prepare",
        binding(&before, json!([])),
    )
    .await;
    let mut input = extraction(
        &before,
        json!([]),
        "highlights",
        json!([{"firstWord":20,"lastWord":119}]),
    );
    input["audioEvidence"] = json!([{"clipId":"unselected-recording","frames":[]}]);
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.podcast.extract",
                InvocationContext::default(),
                input.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(state(&r).await, before);
    let id = source["audioInputs"][0]["clip"]["id"].clone();
    input["audioEvidence"] = json!([{"clipId":id,"frames":[]}]);
    call(&r, "timeline.classic.podcast.extract", input).await;
    let after = state(&r).await;
    let output = after["project"]["classic"]["document"]["scenes"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert!(
        output["takeAssembly"]["quality"]["unverifiedBoundaries"]
            .as_u64()
            .unwrap()
            > 0
    );
}

#[tokio::test]
async fn compaction_rebinds_archive_indices_without_changing_model_ids_or_word_clocks() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/podcast-overlapping-words.json")).unwrap();
    for mode in ["teaser", "highlights", "chronological"] {
        let initial = setup(120).await;
        let mut classic = state(&initial).await["project"]["classic"].clone();
        let tracks = &mut classic["document"]["scenes"][0]["tracks"];
        tracks["overlay"]
            .as_array_mut()
            .unwrap()
            .retain(|t| t["type"] != "text");
        for (i, cues) in fixture["cues"].as_array().unwrap().iter().enumerate() {
            tracks["overlay"].as_array_mut().unwrap().push(json!({"id":format!("fixture-captions-{i}"),"type":"text","name":"Synthetic captions","hidden":false,"elements":cues,"captionSource":{"sourceId":"synthetic-clock","settings":{},"words":fixture["words"]}}));
        }
        tracks.as_object_mut().unwrap().remove("order");
        let r = OpenCutRuntime::default();
        call(
            &r,
            "project.classic.session.attach",
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await;
        let before = state(&r).await;
        let prepared = call(
            &r,
            "timeline.classic.podcast.prepare",
            binding(&before, json!([])),
        )
        .await;
        let words = prepared["words"].as_array().unwrap();
        assert!(
            words.iter().any(|w| w["id"] != w["sourceIndex"]),
            "Fixture must reproduce differing model/archive ordinals"
        );
        call(
            &r,
            "timeline.classic.podcast.extract",
            extraction(
                &before,
                json!([]),
                mode,
                json!([{"firstWord":0,"lastWord":words.len()-1}]),
            ),
        )
        .await;
        let after = state(&r).await;
        assert_eq!(
            &after["project"]["classic"]["document"]["scenes"]
                .as_array()
                .unwrap()[..2],
            before["project"]["classic"]["document"]["scenes"]
                .as_array()
                .unwrap()
        );
        let out = after["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        for (a, b) in words
            .iter()
            .zip(out["takeAssembly"]["sourceWords"].as_array().unwrap())
        {
            for field in ["id", "clipId", "text", "start", "end"] {
                assert_eq!(a[field], b[field]);
            }
        }
        let captions = out["tracks"]["overlay"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["captionSource"].is_object())
            .unwrap();
        assert_eq!(
            captions["captionSource"]["words"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w["text"].clone())
                .collect::<Vec<_>>(),
            words.iter().map(|w| w["text"].clone()).collect::<Vec<_>>()
        );
        let reopened = OpenCutRuntime::default();
        call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    }
}
