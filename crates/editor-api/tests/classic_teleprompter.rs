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
async fn setup() -> (OpenCutRuntime, Value) {
    setup_count(210).await
}
async fn setup_count(count: usize) -> (OpenCutRuntime, Value) {
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let s = &mut c["document"]["scenes"][0];
    s["tracks"]["main"]["elements"][0]["duration"] = json!(650 * 120000);
    s["tracks"]["main"]["elements"][0]["retime"] = json!({"rate":1});
    s["tracks"]["overlay"][0]["elements"] = json!([]);
    s["tracks"]["overlay"][0]["captionSource"]["words"]=json!((0..count).map(|i|json!({"text":match i {0|4=>"שלום".into(),1|5=>"לכולם".into(),2|6=>"היום".into(),3|7=>"נלמד".into(),8=>"יחד".into(),_=>format!("unique-{i}")},"start":i as f64*(if count>210 {0.4}else{3.0})+0.1,"end":i as f64*(if count>210 {0.4}else{3.0})+(if count>210 {0.35}else{1.5})})).collect::<Vec<_>>());
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    let before = state(&r).await;
    (r, before)
}
fn alt(a: usize, b: usize) -> Value {
    json!({"label":"קריאה מלאה","reason":"כל המשפט הושלם ללא התחלה קטועה","parts":[{"firstWord":a,"lastWord":b}]})
}
fn group(alts: Vec<Value>) -> Value {
    json!({"label":"משפט בתסריט","confidence":0.8,"selected":0,"alternatives":alts})
}
fn script(groups: Vec<Value>) -> Value {
    json!({"title":"סרטון טלפרומפטר","openingHook":"משפט פתיחה מקורי","endingHook":"משפט סיום שלם","confidence":0.8,"alternatives":[],"groups":groups,"discarded":[]})
}
fn videos() -> Value {
    json!([
        script(vec![
            group(vec![alt(0, 3), alt(4, 8)]),
            group(vec![alt(9, 100)])
        ]),
        script(vec![group(vec![alt(101, 209)])])
    ])
}
fn input(before: &Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"elementIds":["item-2"],"options":{"mode":"teleprompter","minSeconds":0,"maxSeconds":0,"maxOutputs":32},"videos":videos()})
}
fn good_critique() -> Value {
    json!({"preservesUniqueContent":true,"interchangeableTakes":true,"sourceOrder":true,"completeScripts":true,"cleanCuts":true,"issues":[],"evidence":"Exact indexed source ranges accounted across the collection; unselected complete readings retained as alternatives."})
}
#[tokio::test]
async fn approved_hebrew_evidence_is_counted_as_characters_instead_of_utf8_bytes() {
    let (r, before) = setup().await;
    let mut base = input(&before);
    base.as_object_mut().unwrap().remove("videos");
    let mut all = videos()[0]["groups"].as_array().unwrap().clone();
    all.extend(videos()[1]["groups"].as_array().unwrap().clone());
    let mut good = good_critique();
    let evidence = "כל מילות המקור נשמרו והקטע החלקי זמין לבדיקה. ".repeat(30);
    assert!(evidence.len() > 2000 && evidence.chars().count() <= 2000);
    good["evidence"] = json!(evidence);
    base["responses"] = json!({"inventory:0:0":{"summary":"תסריטים","groups":all,"discarded":[],"scriptStarts":[]},"draft:0":{"videos":videos()},"critique:0:0":good,"critique:0:1":good});
    let done = call(&r, "timeline.classic.podcast.editorial", base).await;
    assert_eq!(done["complete"], true);
    assert!(done["requests"].as_array().unwrap().is_empty());
    assert_eq!(state(&r).await, before);
}
#[tokio::test]
async fn uncertain_fragment_is_archived_outside_playback_and_can_be_explicitly_added_with_undo() {
    let (r, before) = setup().await;
    let mut fragment = group(vec![alt(101, 105)]);
    fragment["reviewOnly"] = json!(true);
    let mut request = input(&before);
    request["videos"] = json!([script(vec![
        group(vec![alt(0, 100)]),
        fragment,
        group(vec![alt(106, 209)])
    ])]);
    let checked = call(&r, "timeline.classic.podcast.review", request.clone()).await;
    call(&r, "timeline.classic.podcast.extract", request).await;
    let after = state(&r).await;
    let output = &after["project"]["classic"]["document"]["scenes"][2];
    assert_eq!(
        output["takeAssembly"]["plan"]["groups"][1]["reviewOnly"],
        true
    );
    let caption_words = output["tracks"]["overlay"][0]["captionSource"]["words"]
        .as_array()
        .unwrap();
    assert!(!caption_words.iter().any(|w| w["text"] == "unique-101"));
    assert_eq!(caption_words.len(), 205);
    assert!(checked["durations"][0].as_f64().unwrap() < 625.);
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    call(&r,"timeline.classic.takes.edit",json!({"projectId":"classic-project","sceneId":output["id"],"expectedRevision":after["revision"],"change":{"type":"select","groupIndex":1,"alternativeIndex":0}})).await;
    let included = state(&r).await;
    let scene = &included["project"]["classic"]["document"]["scenes"][2];
    assert!(
        scene["takeAssembly"]["plan"]["groups"][1]
            .get("reviewOnly")
            .is_none()
    );
    assert_eq!(
        scene["tracks"]["overlay"][0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .len(),
        210
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(state(&r).await["project"], after["project"]);
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":after["project"]["classic"]})).await;
    assert_eq!(
        state(&reopened).await["project"]["classic"],
        after["project"]["classic"]
    );
}
#[tokio::test]
async fn mapped_sentence_references_reconcile_two_windows_without_rewriting_the_ledger() {
    let (r, before) = setup_count(1100).await;
    let mut base = input(&before);
    base.as_object_mut().unwrap().remove("videos");
    base["responses"] = json!({
        "inventory:0:0":{"summary":"פתיחה וחזרות","groups":[group(vec![alt(0,3),alt(4,8)]),group(vec![alt(9,799)]),group(vec![alt(800,815)])],"discarded":[],"scriptStarts":[]},
        "inventory:1:0":{"summary":"סיום עם הקשר חופף","groups":[group(vec![alt(784,799)]),group(vec![alt(800,1099)])],"discarded":[],"scriptStarts":[]}
    });
    let compose = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(compose["requests"][0]["key"], "draft:0");
    assert!(
        compose["requests"][0]["instructions"]
            .as_str()
            .unwrap()
            .contains("groupRefs")
    );
    base["responses"]["draft:0"] = json!({"videos":[{"title":"תסריט שלם","openingHook":"פתיחה","endingHook":"סיום","confidence":0.9,"groupRefs":[{"id":"0:0","selected":1},{"id":"0:1"},{"id":"1:1"}]}]});
    let critique = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(critique["requests"][0]["key"], "critique:0:0");
    assert_eq!(
        critique["requests"][0]["prompt"]["collection"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    base["responses"]["critique:0:0"] = good_critique();
    let done = call(&r, "timeline.classic.podcast.editorial", base).await;
    assert_eq!(done["complete"], true);
    assert_eq!(done["videos"][0]["groups"][0]["selected"], 1);
    assert_eq!(
        done["videos"][0]["groups"][0]["alternatives"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(state(&r).await, before);
    let mut extract = input(&before);
    extract["videos"] = done["videos"].clone();
    call(&r, "timeline.classic.podcast.extract", extract).await;
    let after = state(&r).await;
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
}
#[tokio::test]
async fn broken_inventory_is_repaired_before_compose_and_terminal_failure_explains_word_ids() {
    let (r, before) = setup().await;
    let mut base = input(&before);
    base.as_object_mut().unwrap().remove("videos");
    base["responses"] = json!({"inventory:0:0":{"summary":"מיפוי","groups":[group(vec![alt(0,100)]),group(vec![alt(100,209)])],"discarded":[],"scriptStarts":[]}});
    let repair = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(repair["requests"][0]["key"], "inventory:0:1");
    assert!(
        repair["requests"][0]["prompt"]["feedback"]
            .to_string()
            .contains("100")
    );
    base["responses"]["inventory:0:1"] = json!({"summary":"תוקן","groups":[group(vec![alt(0,209)])],"discarded":[],"scriptStarts":[]});
    for round in 0..6 {
        base["responses"][format!("draft:{round}")] =
            json!({"videos":[script(vec![group(vec![alt(1,209)])])]});
    }
    let failed = call(&r, "timeline.classic.podcast.editorial", base).await;
    assert_eq!(failed["complete"], false);
    assert_eq!(failed["report"]["failures"].as_array().unwrap().len(), 6);
    assert!(
        failed["report"]["error"]
            .as_str()
            .unwrap()
            .contains("missing words 0..0")
    );
    assert_eq!(state(&r).await, before);
}
#[tokio::test]
async fn later_pickup_for_earlier_script_does_not_reorder_scripts_or_lose_the_take() {
    let (r, before) = setup().await;
    let mut request = input(&before);
    request["videos"] = json!([
        script(vec![group(vec![alt(0, 3), alt(101, 108)])]),
        script(vec![group(vec![alt(4, 100)]), group(vec![alt(109, 209)])])
    ]);
    call(&r, "timeline.classic.podcast.review", request.clone()).await;
    call(&r, "timeline.classic.podcast.extract", request).await;
    let after = state(&r).await;
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][2]["takeAssembly"]["plan"]["groups"][0]["alternatives"]
            [1]["parts"][0]["firstWord"],
        101
    );
}
#[tokio::test]
async fn complete_long_scripts_keep_per_sentence_alternatives_source_captions_undo_and_reopen() {
    let (r, before) = setup().await;
    let input = input(&before);
    let checked = call(&r, "timeline.classic.podcast.review", input.clone()).await;
    assert!(checked["durations"][0].as_f64().unwrap() > 90.);
    assert_eq!(state(&r).await, before);
    let mut dry = InvocationContext::default();
    dry.dry_run = true;
    r.registry()
        .invoke("timeline.classic.podcast.extract", dry, input.clone())
        .await
        .unwrap();
    assert_eq!(state(&r).await, before);
    call(&r, "timeline.classic.podcast.extract", input).await;
    let after = state(&r).await;
    let d = &after["project"]["classic"]["document"];
    assert_eq!(d["scenes"].as_array().unwrap().len(), 4);
    for i in 0..2 {
        assert_eq!(
            d["scenes"][i],
            before["project"]["classic"]["document"]["scenes"][i]
        );
    }
    assert_eq!(
        d["transcriptionJobs"],
        before["project"]["classic"]["document"]["transcriptionJobs"]
    );
    let output = &d["scenes"][2];
    assert_eq!(
        output["takeAssembly"]["plan"]["groups"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        output["takeAssembly"]["plan"]["groups"][0]["alternatives"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        output["tracks"]["overlay"][0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .len(),
        96
    );
    call(&r,"timeline.classic.takes.edit",json!({"projectId":"classic-project","sceneId":output["id"],"expectedRevision":after["revision"],"change":{"type":"select","groupIndex":0,"alternativeIndex":1}})).await;
    let swapped = state(&r).await;
    let next = &swapped["project"]["classic"]["document"]["scenes"][2];
    assert_eq!(next["takeAssembly"]["plan"]["groups"][0]["selected"], 1);
    assert_eq!(
        next["tracks"]["overlay"][0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .len(),
        97
    );
    assert_eq!(
        next["tracks"]["overlay"][0]["captionSource"]["words"][4]["text"],
        "יחד"
    );
    assert_ne!(
        next["tracks"]["main"]["elements"][1]["startTime"],
        output["tracks"]["main"]["elements"][1]["startTime"]
    );
    assert_eq!(
        swapped["project"]["classic"]["document"]["scenes"][0],
        d["scenes"][0]
    );
    let reopened = OpenCutRuntime::default();
    call(&reopened,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":swapped["project"]["classic"]})).await;
    assert_eq!(
        state(&reopened).await["project"]["classic"],
        swapped["project"]["classic"]
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(state(&r).await["project"], after["project"]);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(state(&r).await["project"], before["project"]);
}
#[tokio::test]
async fn missing_unique_lines_duplicate_scripts_and_reordered_groups_are_atomic_errors() {
    let (r, before) = setup().await;
    let mut cases = vec![];
    let mut x = input(&before);
    x["videos"][0]["groups"][1]["alternatives"][0]["parts"][0]["firstWord"] = json!(10);
    cases.push(x);
    let mut x = input(&before);
    x["videos"][1] = x["videos"][0].clone();
    cases.push(x);
    let mut x = input(&before);
    x["videos"].as_array_mut().unwrap().reverse();
    cases.push(x);
    let mut x = input(&before);
    x["videos"][0]["groups"].as_array_mut().unwrap().reverse();
    cases.push(x);
    let mut x = input(&before);
    x["options"]["maxSeconds"] = json!(90);
    cases.push(x);
    for x in cases {
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.podcast.extract",
                    InvocationContext::default(),
                    x
                )
                .await
                .is_err()
        );
        assert_eq!(state(&r).await, before);
    }
}
#[tokio::test]
async fn teleprompter_maps_every_word_then_repairs_failed_semantic_review_before_extracting() {
    let (r, before) = setup().await;
    let mut base = input(&before);
    base.as_object_mut().unwrap().remove("videos");
    base["responses"] = json!({});
    let first = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(first["policyVersion"], "teleprompter-v4");
    assert_eq!(first["requests"][0]["stage"], "inventory");
    // Silent omission cannot advance to composition.
    base["responses"]["inventory:0:0"] = json!({"summary":"תסריטים","groups":[group(vec![alt(0,3)])],"discarded":[],"scriptStarts":[]});
    let repair = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(repair["requests"][0]["key"], "inventory:0:1");
    let mut all = videos()[0]["groups"].as_array().unwrap().clone();
    all.extend(videos()[1]["groups"].as_array().unwrap().clone());
    base["responses"]["inventory:0:1"] = json!({"summary":"שני תסריטים עם חזרה רק על משפט הפתיחה","groups":all,"discarded":[],"scriptStarts":[{"firstWord":0,"title":"ראשון","reason":"נושא ראשון"},{"firstWord":101,"title":"שני","reason":"פתיחה חדשה ונושא שונה"}]});
    let compose = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(compose["requests"][0]["key"], "draft:0");
    base["responses"]["draft:0"] = json!({"videos":videos()});
    let review = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(review["requests"].as_array().unwrap().len(), 2);
    let good = json!({"preservesUniqueContent":true,"interchangeableTakes":true,"sourceOrder":true,"completeScripts":true,"cleanCuts":true,"issues":[],"evidence":"Words0..3 and4..8 are two complete opening readings; unique words9..209 retained in two ordered complete scripts."});
    let mut bad = good.clone();
    bad["interchangeableTakes"] = json!(false);
    bad["issues"] =
        json!(["Check opening wording; do not treat rhetorical emphasis as a false start"]);
    base["responses"]["critique:0:0"] = bad;
    base["responses"]["critique:0:1"] = good.clone();
    let fix = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(fix["requests"][0]["key"], "draft:1");
    assert!(
        fix["requests"][0]["prompt"]["feedback"]
            .to_string()
            .contains("rhetorical")
    );
    base["responses"]["draft:1"] = json!({"videos":videos()});
    base["responses"]["critique:1:0"] = good.clone();
    base["responses"]["critique:1:1"] = good;
    let done = call(&r, "timeline.classic.podcast.editorial", base).await;
    assert_eq!(done["complete"], true);
    assert_eq!(done["report"]["rounds"], 2);
    // Script 1 was already approved and unchanged; script 0 was rejected.
    // A second provider review of script 1 is unnecessary.
    assert_eq!(done["videos"][0]["groups"], videos()[0]["groups"]);
    assert_eq!(done["videos"][1]["groups"], videos()[1]["groups"]);
    assert_eq!(state(&r).await, before);
}
#[tokio::test]
async fn repairs_reuse_approved_unchanged_scripts_but_moved_source_invalidates_reviews() {
    let (r, before) = setup().await;
    let mut base = input(&before);
    base.as_object_mut().unwrap().remove("videos");
    let scripts = json!([
        videos()[0],
        script(vec![group(vec![alt(101, 150)])]),
        script(vec![group(vec![alt(151, 209)])])
    ]);
    let all = scripts
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|v| v["groups"].as_array().unwrap().clone())
        .collect::<Vec<_>>();
    let good = good_critique();
    let mut bad = good.clone();
    bad["cleanCuts"] = json!(false);
    bad["issues"] = json!(["Repair the third script boundary"]);
    base["responses"] = json!({"inventory:0:0":{"summary":"שלושה תסריטים","groups":all,"discarded":[],"scriptStarts":[]},"draft:0":{"videos":scripts},"critique:0:0":good,"critique:0:1":good,"critique:0:2":bad,"draft:1":{"videos":scripts}});
    let next = call(&r, "timeline.classic.podcast.editorial", base.clone()).await;
    assert_eq!(next["requests"].as_array().unwrap().len(), 1);
    assert_eq!(next["requests"][0]["key"], "critique:1:2");
    assert_eq!(next["report"]["reusedReviews"], 2);
    // Script 0 itself stays exact. Moving source between scripts 1 and 2 still
    // invalidates its global collection context, so it must be reviewed again.
    base["responses"]["draft:1"]["videos"][1]["groups"][0]["alternatives"][0]["parts"][0]["lastWord"] =
        json!(151);
    base["responses"]["draft:1"]["videos"][2]["groups"][0]["alternatives"][0]["parts"][0]["firstWord"] =
        json!(152);
    let changed = call(&r, "timeline.classic.podcast.editorial", base).await;
    assert_eq!(changed["requests"][0]["key"], "critique:1:0");
    assert_eq!(changed["report"]["reusedReviews"], 0);
    assert_eq!(state(&r).await, before);
}
