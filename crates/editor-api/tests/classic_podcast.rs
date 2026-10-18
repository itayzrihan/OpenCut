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
async fn state(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let scene = &mut classic["document"]["scenes"][0];
    scene["tracks"]["main"]["elements"][0]["duration"] = json!(650 * 120000);
    scene["tracks"]["main"]["elements"][0]["retime"] = json!({"rate":1});
    scene["tracks"]["overlay"][0]["elements"] = json!([]);
    scene["tracks"]["overlay"][0]["captionSource"]["words"]=json!((0..210).map(|i|json!({"text":format!("word{i}"),"start":i as f64*3.0+0.1,"end":i as f64*3.0+1.5})).collect::<Vec<_>>());
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn video(parts: Value) -> Value {
    json!({"title":"A strong idea","openingHook":"A surprising question","endingHook":"The answer is about to begin","confidence":0.9,"alternatives":[{"label":"Complete clauses","reason":"Coherent insight","parts":parts}]})
}
fn request(s: &Value, mode: &str, videos: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","elementIds":["item-2"],"expectedRevision":s["revision"],"options":{"mode":mode,"minSeconds":20,"maxSeconds":90,"maxOutputs":8},"videos":videos})
}

#[tokio::test]
async fn seven_extract_archives_keep_corrected_words_without_copying_every_caption_cue() {
    let r = setup().await;
    let mut classic = state(&r).await["project"]["classic"].clone();
    classic["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"] = json!((0..210).map(|i| {
        json!({"id":format!("cue-{i}"),"type":"text","name":"Caption","startTime":i*3*120000,
            "duration":180000,"trimStart":0,"trimEnd":0,"params":{"content":format!("word{i}"),"fontFamily":"My font"},
            "wordRuns":[{"id":format!("run-{i}"),"text":format!("word{i}"),"startTime":24000,"endTime":156000}]})
    }).collect::<Vec<_>>());
    call(&r,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":state(&r).await["revision"],"classic":classic})).await;
    let before = state(&r).await;
    let prepared = call(&r,"timeline.classic.podcast.prepare",json!({"projectId":"classic-project","sceneId":"main-scene","elementIds":["item-2"],"expectedRevision":before["revision"]})).await;
    let videos = json!((0..7).map(|i| video(json!([{"firstWord":i*20,"lastWord":i*20+7}]))).collect::<Vec<_>>());
    call(&r,"timeline.classic.podcast.extract",request(&before,"highlights",videos)).await;
    let after = state(&r).await;
    let scenes = after["project"]["classic"]["document"]["scenes"].as_array().unwrap();
    assert_eq!(scenes.len(), 9);
    assert_eq!(scenes[0], before["project"]["classic"]["document"]["scenes"][0]);
    for scene in &scenes[2..] {
        let archive = &scene["takeAssembly"];
        assert_eq!(archive["sourceTracks"]["overlay"][0]["elements"].as_array().unwrap().len(), 1);
        assert_eq!(archive["sourceWords"], prepared["words"]);
        assert_eq!(archive["sourceWords"][0]["start"], 24000);
    }
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    call(&r,"history.undo",json!({})).await;
    assert_eq!(state(&r).await["project"],before["project"]);
    call(&r,"history.redo",json!({})).await;
    assert_eq!(state(&r).await["project"],after["project"]);
}
#[tokio::test]
async fn extracts_are_new_scenes_with_exact_transcripts_archives_and_undo() {
    let r = setup().await;
    let before = state(&r).await;
    let prepared=call(&r,"timeline.classic.podcast.prepare",json!({"projectId":"classic-project","sceneId":"main-scene","elementIds":["item-2"],"expectedRevision":before["revision"]})).await;
    assert_eq!(prepared["words"].as_array().unwrap().len(), 210);
    assert_eq!(prepared["windows"].as_array().unwrap().len(), 3);
    let input = request(
        &before,
        "teaser",
        json!([video(
            json!([{"firstWord":110,"lastWord":115},{"firstWord":10,"lastWord":15}])
        )]),
    );
    call(&r, "timeline.classic.podcast.review", input.clone()).await;
    assert_eq!(state(&r).await, before);
    let mut dry = InvocationContext::default();
    dry.dry_run = true;
    r.registry()
        .invoke("timeline.classic.podcast.extract", dry, input.clone())
        .await
        .unwrap();
    assert_eq!(state(&r).await, before);
    call(&r, "timeline.classic.podcast.extract", input.clone()).await;
    let after = state(&r).await;
    let doc = &after["project"]["classic"]["document"];
    assert_eq!(
        doc["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    let output = &doc["scenes"][2];
    assert_eq!(doc["currentSceneId"], output["id"]);
    assert_eq!(output["podcastExtract"]["options"]["mode"], "teaser");
    assert_eq!(
        output["tracks"]["main"]["elements"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let words = output["tracks"]["overlay"][0]["captionSource"]["words"]
        .as_array()
        .unwrap();
    assert_eq!(words.len(), 12);
    assert_eq!(words[0]["text"], "word110");
    assert_eq!(words[6]["text"], "word10");
    assert!(
        words
            .iter()
            .all(|w| w["end"].as_f64().unwrap() > w["start"].as_f64().unwrap())
    );
    assert!(words[6]["start"].as_f64().unwrap() > words[5]["end"].as_f64().unwrap());
    // Both caption endpoints must use exactly the same source-to-output clock
    // as the video, including the protective audio handles and original trim.
    for (part_index, first_word) in [110usize, 10].into_iter().enumerate() {
        let clip = &output["tracks"]["main"]["elements"][part_index];
        let from = clip["trimStart"].as_i64().unwrap() - 480000;
        let destination = clip["startTime"].as_i64().unwrap();
        for offset in 0..6 {
            let source = &prepared["words"][first_word + offset];
            let caption = &words[part_index * 6 + offset];
            for endpoint in ["start", "end"] {
                let caption_tick = (caption[endpoint].as_f64().unwrap() * 120000.0).round() as i64;
                assert_eq!(
                    caption_tick,
                    source[endpoint].as_i64().unwrap() - from + destination
                );
            }
        }
    }
    assert_eq!(output["tracks"]["main"]["elements"][0]["startTime"], 0);
    assert!(
        output["takeAssembly"]["quality"]["unverifiedBoundaries"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.podcast.extract",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    call(&r, "history.undo", json!({})).await;
    assert_eq!(state(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(state(&r).await["project"], after["project"]);
}
#[tokio::test]
async fn chronology_window_duration_duplicates_and_word_bounds_are_enforced_atomically() {
    let r = setup().await;
    let before = state(&r).await;
    let invalid = [
        request(
            &before,
            "chronological",
            json!([video(
                json!([{"firstWord":20,"lastWord":25},{"firstWord":10,"lastWord":15}])
            )]),
        ),
        request(
            &before,
            "highlights",
            json!([video(json!([{"firstWord":95,"lastWord":108}]))]),
        ),
        request(
            &before,
            "highlights",
            json!([video(json!([{"firstWord":0,"lastWord":40}]))]),
        ),
        request(
            &before,
            "teaser",
            json!([video(json!([{"firstWord":0,"lastWord":2}]))]),
        ),
        request(
            &before,
            "teaser",
            json!([video(json!([{"firstWord":210,"lastWord":220}]))]),
        ),
        request(
            &before,
            "highlights",
            json!([
                video(json!([{"firstWord":0,"lastWord":10}])),
                video(json!([{"firstWord":5,"lastWord":15}]))
            ]),
        ),
        request(
            &before,
            "chronological",
            json!([
                video(json!([{"firstWord":110,"lastWord":120}])),
                video(json!([{"firstWord":10,"lastWord":20}]))
            ]),
        ),
    ];
    for input in invalid {
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.podcast.extract",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
        assert_eq!(state(&r).await, before);
    }
    let valid = request(
        &before,
        "chronological",
        json!([
            video(json!([{"firstWord":10,"lastWord":20}])),
            video(json!([{"firstWord":110,"lastWord":120}]))
        ]),
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        r.registry()
            .invoke("timeline.classic.podcast.extract", cancelled, valid.clone())
            .await
            .is_err()
    );
    assert_eq!(state(&r).await, before);
    call(&r, "timeline.classic.podcast.extract", valid).await;
    assert_eq!(
        state(&r).await["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}
#[tokio::test]
async fn switching_podcast_versions_never_restores_the_unselected_episode() {
    let r = setup().await;
    let before = state(&r).await;
    let mut v = video(json!([{"firstWord":10,"lastWord":20}]));
    v["alternatives"].as_array_mut().unwrap().push(json!({"label":"Another complete version","reason":"A fluent alternative","parts":[{"firstWord":30,"lastWord":43}]}));
    call(
        &r,
        "timeline.classic.podcast.extract",
        request(&before, "highlights", json!([v])),
    )
    .await;
    let after = state(&r).await;
    let id = after["project"]["classic"]["document"]["currentSceneId"].clone();
    call(&r,"timeline.classic.takes.edit",json!({"projectId":"classic-project","sceneId":id,"expectedRevision":after["revision"],"change":{"type":"select","groupIndex":0,"alternativeIndex":1}})).await;
    let selected = state(&r).await;
    let output = &selected["project"]["classic"]["document"]["scenes"][2];
    assert_eq!(
        output["tracks"]["main"]["elements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        output["tracks"]["overlay"][0]["captionSource"]["words"][0]["text"],
        "word30"
    );
    assert_eq!(
        output["tracks"]["overlay"][0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .len(),
        14
    );
    assert_eq!(
        selected["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
}

#[tokio::test]
async fn repeated_teasers_and_both_short_modes_preserve_source_and_previous_outputs() {
    let r = setup().await;
    // Keep a completed, source-bound job alongside the corrected caption source.
    // Silence-only sections are valid and must not replace existing captions.
    call(&r,"transcription.classic.edit",json!({"projectId":"classic-project","expectedRevision":state(&r).await["revision"],"jobId":"completed-job","change":{"type":"start","sceneId":"main-scene","language":"he","settings":{"wordsPerRow":3,"rows":1},"defaults":{"element":{"type":"text","trimStart":0,"trimEnd":0,"params":{"opacity":1}},"bottomFadeOutEndOpacity":0.25},"totalDuration":650*120000}})).await;
    for index in 0..11 {
        call(&r,"transcription.classic.edit",json!({"projectId":"classic-project","expectedRevision":state(&r).await["revision"],"jobId":"completed-job","change":{"type":"append","index":index,"words":[]}})).await;
    }
    let before = state(&r).await;
    assert_eq!(before["project"]["classic"]["document"]["transcriptionJobs"][0]["status"],"complete");
    let source = before["project"]["classic"]["document"]["scenes"].clone();
    let mut previous = source.as_array().unwrap().clone();
    // Each generation starts from Main, even when the previous output remains
    // the viewer's active scene. Earlier extracts must stay editable and exact.
    for mode in ["teaser", "highlights", "chronological", "teaser", "chronological", "highlights"] {
        let current = state(&r).await;
        let input = request(&current, mode, json!([video(json!([{"firstWord":10,"lastWord":20}]))]));
        let result = call(&r, "timeline.classic.podcast.extract", input).await;
        let after = state(&r).await;
        let doc = &after["project"]["classic"]["document"];
        let scenes = doc["scenes"].as_array().unwrap();
        assert_eq!(&scenes[..previous.len()], previous.as_slice());
        assert_eq!(scenes.len(), previous.len() + 1);
        assert_eq!(scenes[0], source[0]);
        assert_eq!(scenes.last().unwrap()["podcastExtract"]["options"]["mode"], mode);
        assert_eq!(doc["transcriptionJobs"], before["project"]["classic"]["document"]["transcriptionJobs"]);
        assert!(result["revision"].as_u64().unwrap() > current["revision"].as_u64().unwrap());
        previous = scenes.clone();
    }
    let archive = call(&r, "project.classic.session.archive", json!({"projectId":"classic-project","compact":true,"chained":true})).await;
    let reopened = OpenCutRuntime::default();
    call(&reopened, "project.classic.session.restore", json!({"projectId":"classic-project","expectedRevision":0,"archive":archive})).await;
    assert_eq!(state(&reopened).await["project"]["classic"], state(&r).await["project"]["classic"]);
    // Undo and Redo never remove or change the Main transcript.
    call(&r,"history.undo",json!({})).await;
    assert_eq!(state(&r).await["project"]["classic"]["document"]["scenes"][0],source[0]);
    call(&r,"history.redo",json!({})).await;
    assert_eq!(state(&r).await["project"]["classic"]["document"]["scenes"],json!(previous));
}
