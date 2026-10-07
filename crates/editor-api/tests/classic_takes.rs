use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
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
    scene["tracks"]["overlay"][0]["captionSource"]["words"] = json!(
        text.iter()
            .enumerate()
            .map(|(i, text)| json!({"text":text,"start":i as f64+0.1,"end":i as f64+0.85}))
            .collect::<Vec<_>>()
    );
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
        (2, 1.1, 1.1),           // Consecutive words must retain their original order.
        (5, 5.99999, 5.99999), // Clip edge: do not extend into the next clip.
        (7, 7.1, 7.1000001),     // Positive duration rounds to zero ticks.
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
        [
            "Welcome", "dear", "world", "Useful", "ending", "tail", "end"
        ]
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
    assert_eq!(s["tracks"]["main"]["elements"][0]["trimStart"], 645000); // 480000 + 1.1s * 1.25
    assert_eq!(s["tracks"]["main"]["elements"][2]["startTime"], 420000);
    assert_eq!(s["bookmarks"][0]["time"], 480000);
    assert_eq!(s["bookmarks"][1]["time"], 1980000);
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
        [
            "Welcome", "dear", "world", "Useful", "ending", "tail", "end"
        ]
    );
    assert_eq!(s["tracks"]["main"]["elements"].as_array().unwrap().len(), 4);
    assert_eq!(s["tracks"]["main"]["elements"][3]["startTime"], 510000);
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
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), request)
                .await
                .is_err()
        );
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
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                input(
                    &changed,
                    json!({"type":"select","groupIndex":0,"alternativeIndex":1})
                )
            )
            .await
            .is_err()
    );
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
    corrupt["document"]["scenes"][0]["takeAssembly"]["sourceTracks"]["main"]["elements"][0]["trimStart"] =
        json!(-1);
    let other = OpenCutRuntime::default();
    assert!(
        other
            .registry()
            .invoke(
                "project.classic.session.attach",
                InvocationContext::default(),
                json!({"projectId":"classic-project","expectedRevision":0,"classic":corrupt})
            )
            .await
            .is_err()
    );
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
    assert_eq!(clips[1]["trimStart"], 645000);
    assert_eq!(clips[2]["trimStart"], 492000); // word 10.1s within the later clip starting at 6s
    assert_eq!(clips[1]["takeGroup"], clips[2]["takeGroup"]);
}
