use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{json, Value};
const EDIT: &str = "timeline.classic.takes.edit";
const PREPARE: &str = "timeline.classic.takes.prepare";
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
async fn setup() -> OpenCutRuntime {
    setup_with_word_times(&[]).await
}
async fn setup_with_word_times(times: &[(usize, f64, f64)]) -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let scene = &mut classic["document"]["scenes"][0];
    let mut first = scene["tracks"]["main"]["elements"][0].clone();
    first["duration"] = json!(720000);
    let mut second = first.clone();
    second["id"] = json!("second");
    second["startTime"] = json!(720000);
    second["trimStart"] = json!(0);
    second["retime"] = json!({"rate":1});
    let mut tail = second.clone();
    tail["id"] = json!("tail");
    tail["startTime"] = json!(1440000);
    tail["duration"] = json!(240000);
    scene["tracks"]["main"]["elements"] = json!([first, second, tail]);
    scene["tracks"]["audio"] = json!([{"id":"audio","type":"audio","name":"Audio","muted":false,"elements":[{"id":"bed","type":"audio","mediaId":"video-asset","startTime":0,"duration":1680000,"trimStart":0,"trimEnd":0,"params":{}}]}]);
    scene["tracks"]["order"] = json!(["titles", "video-track", "audio"]);
    let text = [
        "restart", "Hello", "world", "oops", "Useful", "ending", "again", "Welcome", "mistake",
        "dear", "world", "cut", "tail", "end",
    ];
    scene["tracks"]["overlay"][0]["captionSource"]["words"] = json!(text
        .iter()
        .enumerate()
        .map(|(i, text)| json!({"text":text,"start":i as f64+0.1,"end":i as f64+0.85}))
        .collect::<Vec<_>>());
    for &(index, start, end) in times {
        let word = &mut scene["tracks"]["overlay"][0]["captionSource"]["words"][index];
        word["start"] = json!(start);
        word["end"] = json!(end);
    }
    scene["bookmarks"] =
        json!([{"time":1500000,"note":"tail note"},{"time":3000000,"note":"After the footage"}]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn plan() -> Value {
    json!({"groups":[
    {"label":"Introduction","confidence":0.9,"selected":0,"alternatives":[
        {"label":"Continuous","reason":"Complete first sentence","parts":[{"firstWord":1,"lastWord":2}]},
        {"label":"Composite","reason":"Alternate wording recorded later","parts":[{"firstWord":7,"lastWord":7},{"firstWord":9,"lastWord":10}]}
    ]},
    {"label":"Conclusion","confidence":0.7,"selected":0,"alternatives":[{"label":"Ending","reason":"Preserve unique content","parts":[{"firstWord":4,"lastWord":5}]}]}
],"discarded":([0,3,6,8,11].iter().map(|i|json!({"firstWord":i,"lastWord":i,"reason":"Filming aside"})).collect::<Vec<_>>())})
}
fn input(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"change":change})
}
fn assemble(state: &Value) -> Value {
    input(
        state,
        json!({"type":"assemble","elementIds":["item-2","second"],"plan":plan()}),
    )
}
fn scene(state: &Value) -> &Value {
    &state["project"]["classic"]["document"]["scenes"][0]
}
fn transcript(scene: &Value) -> Vec<String> {
    scene["tracks"]["overlay"][0]["captionSource"]["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["text"].as_str().unwrap().into())
        .collect()
}

#[tokio::test]
async fn point_word_timings_survive_assembly_alternatives_reload_and_undo() {
    let r = setup_with_word_times(&[
        (1, 1.1, 1.1),
        (2, 1.1, 1.1),         // Consecutive words must retain their original order.
        (5, 5.99999, 5.99999), // Clip edge: do not extend into the next clip.
        (7, 7.1, 7.1000001),   // Positive duration rounds to zero ticks.
        (10, 10.1, 10.1),
        (13, 13.1, 13.1), // A word outside the selected footage must not block it.
    ])
    .await;
    let original = read(&r).await;
    let prepared = call(&r, PREPARE, json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":original["revision"],"elementIds":["item-2","second"]})).await;
    let words = prepared["words"].as_array().unwrap();
    assert_eq!(words.len(), 12);
    for (index, word) in words.iter().enumerate() {
        assert_eq!(word["sourceIndex"], index);
        assert!(word["end"].as_i64().unwrap() > word["start"].as_i64().unwrap());
        let clip_end = if word["clipId"] == "item-2" {
            720000
        } else {
            1440000
        };
        assert!(word["end"].as_i64().unwrap() <= clip_end);
    }
    assert_eq!(read(&r).await, original); // Preparation is read-only.
    call(&r, EDIT, assemble(&original)).await;
    let assembled = read(&r).await;
    assert_eq!(
        transcript(scene(&assembled)),
        ["Hello", "world", "Useful", "ending", "tail", "end"]
    );
    assert_eq!(
        scene(&assembled)["takeAssembly"]["sourceTracks"],
        scene(&original)["tracks"]
    );
    for word in scene(&assembled)["tracks"]["overlay"][0]["captionSource"]["words"]
        .as_array()
        .unwrap()
    {
        assert!(word["end"].as_f64().unwrap() > word["start"].as_f64().unwrap());
    }
    let reopened = OpenCutRuntime::default();
    call(&reopened, "project.classic.session.attach", json!({"projectId":"classic-project","expectedRevision":0,"classic":assembled["project"]["classic"]})).await;
    let restored = read(&reopened).await;
    call(
        &reopened,
        EDIT,
        input(
            &restored,
            json!({"type":"select","groupIndex":0,"alternativeIndex":1}),
        ),
    )
    .await;
    assert_eq!(
        transcript(scene(&read(&reopened).await)),
        ["Welcome", "dear", "world", "Useful", "ending", "tail", "end"]
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], original["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], assembled["project"]);
}

#[tokio::test]
async fn point_words_at_shared_and_final_clip_boundaries_have_one_owner() {
    let r = setup_with_word_times(&[(6, 6.0, 6.0), (13, 14.0, 14.0)]).await;
    let state = read(&r).await;
    let prepared = call(&r, PREPARE, json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"elementIds":["item-2","second","tail"]})).await;
    assert_eq!(prepared["words"].as_array().unwrap().len(), 14);
    assert_eq!(prepared["words"][6]["clipId"], "second");
    assert_eq!(prepared["words"][13]["clipId"], "tail");
    assert_eq!(prepared["words"][13]["start"], 1679880);
    assert_eq!(prepared["words"][13]["end"], 1680000);
    let partial = call(&r, PREPARE, json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"elementIds":["item-2"]})).await;
    assert_eq!(partial["words"].as_array().unwrap().len(), 6);
}

#[tokio::test]
async fn reversed_word_timings_are_rejected_without_mutation() {
    let r = setup_with_word_times(&[(1, 1.1, 1.0)]).await;
    let state = read(&r).await;
    for (id, request) in [
        (
            PREPARE,
            json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"elementIds":["item-2","second"]}),
        ),
        (EDIT, assemble(&state)),
    ] {
        let error = r
            .registry()
            .invoke(id, InvocationContext::default(), request)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("must not precede"));
        assert_eq!(read(&r).await, state);
    }
}
#[tokio::test]
async fn assembly_composites_retime_ripple_transcript_undo_and_reload() {
    let r = setup().await;
    let original = read(&r).await;
    let prepared=call(&r,PREPARE,json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":original["revision"],"elementIds":["second","item-2"]})).await;
    assert_eq!(prepared["words"].as_array().unwrap().len(), 12);
    assert_eq!(prepared["words"][7]["clipId"], "second");
    let request = assemble(&original);
    r.registry()
        .invoke(
            EDIT,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, original);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("assemble"));
    let result = r
        .registry()
        .invoke(EDIT, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(EDIT, context, request).await.unwrap(),
        result
    );
    let assembled = read(&r).await;
    let s = scene(&assembled);
    assert_eq!(
        transcript(s),
        ["Hello", "world", "Useful", "ending", "tail", "end"]
    );
    assert_eq!(s["tracks"]["main"]["elements"][0]["trimStart"], 633000); // 480000 + (1.1s - 80ms handle) * 1.25
    assert_eq!(s["tracks"]["main"]["elements"][2]["startTime"], 462600);
    assert_eq!(s["bookmarks"][0]["time"], 522600);
    assert_eq!(s["bookmarks"][1]["time"], 2022600);
    assert_eq!(
        s["takeAssembly"]["sourceTracks"],
        scene(&original)["tracks"]
    );
    assert_eq!(
        s["takeAssembly"]["plan"]["groups"][0]["alternatives"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s["tracks"]["audio"][0]["elements"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let choice = input(
        &assembled,
        json!({"type":"select","groupIndex":0,"alternativeIndex":1}),
    );
    call(&r, EDIT, choice).await;
    let selected = read(&r).await;
    let s = scene(&selected);
    assert_eq!(
        transcript(s),
        ["Welcome", "dear", "world", "Useful", "ending", "tail", "end"]
    );
    assert_eq!(s["tracks"]["main"]["elements"].as_array().unwrap().len(), 4);
    assert_eq!(s["tracks"]["main"]["elements"][3]["startTime"], 576600);
    assert_eq!(s["takeAssembly"]["recommendations"][0], 0);
    // Persisted state reopens with all source footage and alternatives.
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":selected["project"]["classic"]})).await;
    let restored = read(&reopened).await;
    call(
        &reopened,
        EDIT,
        input(
            &restored,
            json!({"type":"select","groupIndex":0,"alternativeIndex":0}),
        ),
    )
    .await;
    assert_eq!(
        transcript(scene(&read(&reopened).await)),
        transcript(scene(&assembled))
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], assembled["project"]);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], original["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], assembled["project"]);
}
#[tokio::test]
async fn malformed_stale_cancelled_and_partial_selection_never_modify_state() {
    let r = setup().await;
    let before = read(&r).await;
    let good = assemble(&before);
    let mut requests = vec![];
    let mut missing = good.clone();
    missing["change"]["plan"]["discarded"] = json!([]);
    requests.push(missing);
    let mut overlap = good.clone();
    overlap["change"]["plan"]["groups"][1]["alternatives"][0]["parts"][0] =
        json!({"firstWord":1,"lastWord":2});
    requests.push(overlap);
    let mut cross = good.clone();
    cross["change"]["plan"]["groups"][0]["alternatives"][0]["parts"][0] =
        json!({"firstWord":1,"lastWord":7});
    requests.push(cross);
    let mut invalid = good.clone();
    invalid["change"]["plan"]["groups"][0]["selected"] = json!(20);
    requests.push(invalid);
    let mut stale = good.clone();
    stale["expectedRevision"] = json!(0);
    requests.push(stale);
    let mut target = good.clone();
    target["projectId"] = json!("wrong");
    requests.push(target);
    let mut unknown = good.clone();
    unknown["change"]["elementIds"] = json!(["missing"]);
    requests.push(unknown);
    let mut skipped = good.clone();
    skipped["change"]["elementIds"] = json!(["item-2", "tail"]);
    requests.push(skipped);
    for request in requests {
        assert!(r
            .registry()
            .invoke(EDIT, InvocationContext::default(), request)
            .await
            .is_err());
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(EDIT, context, good).await.is_err());
    assert_eq!(read(&r).await, before);
}
#[tokio::test]
async fn timeline_edits_are_not_overwritten_by_alternative_selection() {
    let r = setup().await;
    let before = read(&r).await;
    call(&r, EDIT, assemble(&before)).await;
    let assembled = read(&r).await;
    call(&r,"timeline.classic.bookmarks.edit",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":assembled["revision"],"change":{"type":"replace","bookmarks":[]}})).await;
    let changed = read(&r).await;
    assert!(r
        .registry()
        .invoke(
            EDIT,
            InvocationContext::default(),
            input(
                &changed,
                json!({"type":"select","groupIndex":0,"alternativeIndex":1})
            )
        )
        .await
        .is_err());
    assert_eq!(read(&r).await, changed);
}

#[tokio::test]
async fn archived_alternatives_protect_media_even_when_cascade_is_requested() {
    let r = setup().await;
    let before = read(&r).await;
    call(&r, EDIT, assemble(&before)).await;
    let assembled = read(&r).await;
    assert!(r.registry().invoke("media.classic.remove",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":assembled["revision"],"mediaIds":["video-asset"],"cascade":true})).await.is_err());
    assert_eq!(read(&r).await, assembled);
    // The document validator also protects restore/admin patch, beyond the feature action.
    let mut corrupt = assembled["project"]["classic"].clone();
    corrupt["document"]["scenes"][0]["takeAssembly"]["sourceTracks"]["main"]["elements"][0]
        ["trimStart"] = json!(-1);
    let other = OpenCutRuntime::default();
    assert!(other
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":corrupt})
        )
        .await
        .is_err());
}

#[tokio::test]
async fn narrative_order_and_shared_half_take_composites_use_selected_source_words() {
    let r = setup().await;
    let before = read(&r).await;
    let mut request = assemble(&before);
    let groups = request["change"]["plan"]["groups"].as_array_mut().unwrap();
    groups[0]["alternatives"].as_array_mut().unwrap().push(json!({"label":"Half + half","reason":"Opening from the first recording, completion from the later recording","parts":[{"firstWord":1,"lastWord":1},{"firstWord":10,"lastWord":10}]}));
    groups[0]["selected"] = json!(2);
    groups.swap(0, 1); // Later-recorded ending intentionally placed first by the narrative plan.
    call(&r, EDIT, request).await;
    let state = read(&r).await;
    let s = scene(&state);
    assert_eq!(
        transcript(s),
        ["Useful", "ending", "Hello", "world", "tail", "end"]
    );
    let clips = s["tracks"]["main"]["elements"].as_array().unwrap();
    assert_eq!(clips.len(), 3); // Prefer the continuous performance over two isolated words.
    assert_eq!(clips[1]["trimStart"], 633000);
    assert_eq!(s["takeAssembly"]["plan"]["groups"][1]["selected"], 0);
    call(
        &r,
        EDIT,
        input(
            &state,
            json!({"type":"select","groupIndex":1,"alternativeIndex":2}),
        ),
    )
    .await;
    let selected = read(&r).await;
    let clips = scene(&selected)["tracks"]["main"]["elements"]
        .as_array()
        .unwrap();
    assert_eq!(clips.len(), 4); // The editor can still explicitly select the composite.
    assert_eq!(clips[1]["takeGroup"], clips[2]["takeGroup"]);
}

#[tokio::test]
async fn source_linked_caption_cues_are_rebuilt_instead_of_preserved_as_manual_overlays() {
    let r = setup().await;
    let original = read(&r).await;
    let mut classic = original["project"]["classic"].clone();
    // Source-linked captions can have older grouping, line wraps or timings
    // after transcript changes. They must not be copied as authored overlays.
    let track = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0];
    track["elements"] = json!([
        {"id":"stale-cue","type":"text","name":"Caption 1","startTime":0,"duration":360000,"trimStart":0,"trimEnd":0,
         "params":{"content":"restart Hello\nworld"},
         "wordRuns":[{"id":"cue-0","text":"restart","startTime":12000,"endTime":102000},{"id":"cue-1","text":"Hello","startTime":132000,"endTime":222000},{"id":"cue-2","text":"world","startTime":252000,"endTime":342000}]},
        {"id":"outside-cue","type":"text","name":"Authored tail","startTime":1500000,"duration":120000,"trimStart":0,"trimEnd":0,
         "params":{"content":"Keep authored tail"},"wordRuns":[{"id":"outside-word","text":"Keep authored tail","startTime":0,"endTime":120000}]}
    ]);
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&reopened).await;
    let request = assemble(&before);
    reopened
        .registry()
        .invoke(
            EDIT,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&reopened).await, before);
    call(&reopened, EDIT, request).await;
    let after = read(&reopened).await;
    let overlays = scene(&after)["tracks"]["overlay"].as_array().unwrap();
    let elements: Vec<_> = overlays
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
        .collect();
    assert!(!elements.iter().any(|e| e["id"] == "stale-cue"));
    let outside = elements.iter().find(|e| e["id"] == "outside-cue").unwrap();
    assert_eq!(outside["params"]["content"], "Keep authored tail");
    assert_eq!(outside["startTime"], 522600);
    assert_eq!(
        transcript(scene(&after)),
        ["Hello", "world", "Useful", "ending", "tail", "end"]
    );
    assert_eq!(
        scene(&after)["takeAssembly"]["sourceTracks"],
        scene(&before)["tracks"]
    );
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], before["project"]);
}

#[tokio::test]
async fn independent_authored_word_runs_still_block_a_partial_cut_atomically() {
    let r = setup().await;
    let mut classic = read(&r).await["project"]["classic"].clone();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    tracks["overlay"].as_array_mut().unwrap().push(json!({"id":"manual-overlay","type":"text","name":"Authored","elements":[
        {"id":"manual-clip","type":"text","startTime":0,"duration":360000,"trimStart":0,"trimEnd":0,"params":{"content":"Independent authored text"},"wordRuns":[{"id":"manual-word","text":"Independent authored text","startTime":0,"endTime":360000}]}
    ]}));
    tracks["order"]
        .as_array_mut()
        .unwrap()
        .push(json!("manual-overlay"));
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&reopened).await;
    let error = reopened
        .registry()
        .invoke(EDIT, InvocationContext::default(), assemble(&before))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("manually authored text"));
    assert_eq!(read(&reopened).await, before);
}

#[tokio::test]
async fn corrected_caption_clocks_survive_reordering_without_delayed_rows_or_cross_cut_cues() {
    let initial = setup().await;
    let mut classic = read(&initial).await["project"]["classic"].clone();
    let track = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0];
    track["elements"] = json!([
        {"id":"corrected","type":"text","startTime":144000,"duration":204000,"trimStart":0,"trimEnd":0,
        "params":{"content":"Hello world","color":"#ff1234"},
        "wordRuns":[{"id":"a","text":"Hello","startTime":0,"endTime":60000},{"id":"b","text":"world","startTime":192000,"endTime":204000}]}
    ]);
    let r = OpenCutRuntime::default();
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&r).await;
    let prepared=call(&r,PREPARE,json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elementIds":["item-2","second"]})).await;
    assert_eq!(prepared["words"][1]["start"], 144000);
    assert_eq!(prepared["words"][2]["start"], 336000);
    let mut request = assemble(&before);
    request["change"]["plan"]["groups"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    call(&r, EDIT, request).await;
    let state = read(&r).await;
    let s = scene(&state);
    let generated: Vec<_> = s["tracks"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["captionSource"].is_object())
        .collect();
    let words = generated[0]["captionSource"]["words"].as_array().unwrap();
    let mut runs = 0;
    for clip in generated
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
    {
        for run in clip["wordRuns"].as_array().unwrap() {
            runs += 1;
            let start = clip["startTime"].as_i64().unwrap() + run["startTime"].as_i64().unwrap();
            let end = clip["startTime"].as_i64().unwrap() + run["endTime"].as_i64().unwrap();
            assert!(words.iter().any(|w| w["text"] == run["text"]
                && (w["start"].as_f64().unwrap() * 120000.0 - start as f64).abs() < 1.0
                && (w["end"].as_f64().unwrap() * 120000.0 - end as f64).abs() < 1.0));
        }
        let content = clip["params"]["content"].as_str().unwrap();
        assert!(
            !(content.contains("ending") && content.contains("Hello")),
            "Caption must not straddle an edit"
        );
        if content == "Hello world" {
            assert_eq!(clip["wordRuns"][1]["startTime"], 192000); // No readability heuristic shifts the last word earlier.
            assert_eq!(clip["params"]["color"], "#ff1234");
        }
    }
    assert_eq!(runs, words.len());
    let hello = words.iter().find(|w| w["text"] == "Hello").unwrap();
    let clip = &s["tracks"]["main"]["elements"][1];
    let media_clock = clip["trimStart"].as_i64().unwrap() as f64
        + (hello["start"].as_f64().unwrap() * 120000.0
            - clip["startTime"].as_i64().unwrap() as f64)
            * 1.25;
    assert!((media_clock - (480000.0 + 144000.0 * 1.25)).abs() < 1.0);
}

#[tokio::test]
async fn audio_boundaries_include_syllable_tails_and_survive_reopen_and_manual_selection() {
    let r = setup_with_word_times(&[(1, 1.1, 1.5), (2, 2.1, 2.5)]).await;
    let before = read(&r).await;
    let mut request = assemble(&before);
    let frames:Vec<_>=(0..600).map(|i|{
        let start=i as f64/100.0;
        // Actual speech extends 140ms beyond the ASR word end.
        let active=(1.02..1.64).contains(&start)||(2.02..2.64).contains(&start)||(4.02..5.90).contains(&start);
        let energy=if active {0.15} else {0.001};
        json!({"start":start,"end":(i+1) as f64/100.0,"rms":energy,"peak":energy*1.4,"zeroCrossingRate":0.1})
    }).collect();
    request["change"]["audioEvidence"] = json!([{"clipId":"item-2","frames":frames}]);
    call(&r, EDIT, request).await;
    let after = read(&r).await;
    let s = scene(&after);
    let clip = &s["tracks"]["main"]["elements"][0];
    let diagnostics = &s["takeAssembly"]["quality"]["audioDiagnostics"][0];
    assert_eq!(diagnostics["framesAnalyzed"], 600);
    assert_eq!(diagnostics["safetyHoldReason"], Value::Null);
    assert!(diagnostics["quietRanges"].as_u64().unwrap() > 0);
    let source_end = (clip["trimStart"].as_f64().unwrap() - 480000.0) / 1.25
        + clip["duration"].as_f64().unwrap();
    assert!(
        source_end > 2.64 * 120000.0,
        "Cut must retain the audible tail, not stop at the ASR timestamp"
    );
    assert!(
        source_end < 3.1 * 120000.0,
        "Do not include the next discarded word"
    );
    assert!(!s["takeAssembly"]["audioGaps"][0]["ranges"]
        .as_array()
        .unwrap()
        .is_empty());
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    let state = read(&reopened).await;
    call(
        &reopened,
        EDIT,
        input(
            &state,
            json!({"type":"select","groupIndex":0,"alternativeIndex":0}),
        ),
    )
    .await;
    assert_eq!(
        scene(&read(&reopened).await)["tracks"]["main"]["elements"][0]["duration"],
        clip["duration"]
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
}

#[tokio::test]
async fn missing_audio_coverage_is_reported_without_claiming_safe_boundaries() {
    let r = setup().await;
    let before = read(&r).await;
    let mut request = assemble(&before);
    request["change"]["audioEvidence"] = json!([{"clipId":"item-2","frames":[]}]);
    call(&r, EDIT, request).await;
    let after = read(&r).await;
    let q = &scene(&after)["takeAssembly"]["quality"];
    assert_eq!(
        q["audioDiagnostics"][0]["safetyHoldReason"],
        "missing-audio-frames"
    );
    assert_eq!(q["audioDiagnostics"][0]["quietRanges"], 0);
    assert!(q["unverifiedBoundaries"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn consecutive_word_parts_are_rendered_as_one_continuous_clip() {
    let r = setup().await;
    let before = read(&r).await;
    let mut request = assemble(&before);
    request["change"]["plan"]["groups"][0]["alternatives"][0]["parts"] =
        json!([{"firstWord":1,"lastWord":1},{"firstWord":2,"lastWord":2}]);
    call(&r, EDIT, request).await;
    let after = read(&r).await;
    assert_eq!(
        scene(&after)["tracks"]["main"]["elements"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(scene(&after)["takeAssembly"]["quality"]["shortParts"], 0);
}

#[tokio::test]
async fn touching_parts_with_overlapping_asr_words_do_not_duplicate_or_clip_speech() {
    let r = setup_with_word_times(&[(1, 1.1, 2.3), (2, 2.1, 2.85)]).await;
    let before = read(&r).await;
    let mut request = assemble(&before);
    request["change"]["plan"]["groups"][0]["alternatives"][0]["parts"] =
        json!([{"firstWord":1,"lastWord":1},{"firstWord":2,"lastWord":2}]);
    call(&r, EDIT, request).await;
    let after = read(&r).await;
    assert_eq!(
        transcript(scene(&after)),
        ["Hello", "world", "Useful", "ending", "tail", "end"]
    );
    assert_eq!(
        scene(&after)["tracks"]["main"]["elements"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn corrected_caption_word_missing_from_stale_transcript_is_recovered_once() {
    let r = setup().await;
    let mut classic = read(&r).await["project"]["classic"].clone();
    let t = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0];
    t["elements"] = json!([{"id":"restored-words","type":"text","startTime":120000,"duration":240000,"trimStart":0,"trimEnd":0,"params":{"content":"Hello recovered world"},"wordRuns":[
        {"id":"a","text":"Hello","startTime":84000,"endTime":120000},
        {"id":"b","text":"recovered","startTime":120000,"endTime":126000},
        {"id":"c","text":"world","startTime":132000,"endTime":222000}
    ]}]);
    let opened = OpenCutRuntime::default();
    call(
        &opened,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let state = read(&opened).await;
    let prepared=call(&opened,PREPARE,json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"elementIds":["item-2","second"]})).await;
    let words = prepared["words"].as_array().unwrap();
    assert_eq!(words.iter().filter(|w| w["text"] == "Hello").count(), 1);
    assert_eq!(words.iter().filter(|w| w["text"] == "recovered").count(), 1);
    assert_eq!(
        words.iter().find(|w| w["text"] == "Hello").unwrap()["start"],
        204000
    );
    assert_eq!(read(&opened).await, state);
}

#[tokio::test]
async fn experimental_review_is_read_only_and_mode_metrics_survive_assembly_and_reopen() {
    let r = setup().await;
    let before = read(&r).await;
    let review_input = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elementIds":["item-2","second"],"plan":plan(),"selections":[{"groupIndex":0,"alternativeIndex":1}]});
    let reviewed = call(&r, "timeline.classic.takes.review", review_input).await;
    assert_eq!(reviewed["plan"]["groups"][0]["selected"], 1);
    assert_eq!(reviewed["story"][0]["dialogue"], "Welcome | dear world");
    assert_eq!(reviewed["groups"].as_array().unwrap().len(), 2);
    assert_eq!(read(&r).await, before);
    let mut request = assemble(&before);
    request["change"]["plan"] = reviewed["plan"].clone();
    request["change"]["mode"] = json!("experimental");
    request["change"]["runMetrics"] =
        json!({"elapsedMs":1200,"stages":[{"stage":"Focused review","durationMs":700}]});
    call(&r, EDIT, request).await;
    let after = read(&r).await;
    assert_eq!(scene(&after)["takeAssembly"]["mode"], "experimental");
    assert_eq!(
        scene(&after)["takeAssembly"]["runMetrics"]["elapsedMs"],
        1200
    );
    let reopened = OpenCutRuntime::default();
    call(&reopened, "project.classic.session.attach", json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    assert_eq!(
        scene(&read(&reopened).await)["takeAssembly"],
        scene(&after)["takeAssembly"]
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    let state = read(&r).await;
    call(&r, EDIT, assemble(&state)).await;
    assert_eq!(scene(&read(&r).await)["takeAssembly"]["mode"], "standard");
}

#[tokio::test]
async fn experimental_review_rejects_invalid_patches_and_stale_or_incomplete_evidence() {
    let r = setup().await;
    let before = read(&r).await;
    let base = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elementIds":["item-2","second"],"plan":plan()});
    let mut variants = vec![];
    let mut stale = base.clone();
    stale["expectedRevision"] = json!(999);
    variants.push(stale);
    let mut missing = base.clone();
    missing["plan"]["discarded"] = json!([]);
    variants.push(missing);
    let mut duplicate = base.clone();
    duplicate["selections"] =
        json!([{"groupIndex":0,"alternativeIndex":1},{"groupIndex":0,"alternativeIndex":0}]);
    variants.push(duplicate);
    let mut outside = base.clone();
    outside["selections"] = json!([{"groupIndex":0,"alternativeIndex":99}]);
    variants.push(outside);
    let mut clean = base.clone();
    clean["plan"] = json!({"groups":[{"label":"Whole","confidence":0.99,"selected":0,"alternatives":[{"label":"First","reason":"Complete","parts":[{"firstWord":0,"lastWord":5}]},{"label":"Second","reason":"Complete","parts":[{"firstWord":6,"lastWord":11}]}]}],"discarded":[]});
    let output = call(&r, "timeline.classic.takes.review", clean.clone()).await;
    assert!(output["groups"].as_array().unwrap().is_empty());
    assert_eq!(output["story"].as_array().unwrap().len(), 1);
    clean["selections"] = json!([{"groupIndex":0,"alternativeIndex":1}]);
    variants.push(clean);
    for v in variants {
        assert!(r
            .registry()
            .invoke(
                "timeline.classic.takes.review",
                InvocationContext::default(),
                v
            )
            .await
            .is_err());
        assert_eq!(read(&r).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(r
        .registry()
        .invoke("timeline.classic.takes.review", cancelled, base)
        .await
        .is_err());
    let mut invalid_mode = assemble(&before);
    invalid_mode["change"]["mode"] = json!("turbo");
    assert!(r
        .registry()
        .invoke(EDIT, InvocationContext::default(), invalid_mode)
        .await
        .is_err());
}
