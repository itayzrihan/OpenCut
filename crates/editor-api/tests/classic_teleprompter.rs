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
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let s = &mut c["document"]["scenes"][0];
    s["tracks"]["main"]["elements"][0]["duration"] = json!(650 * 120000);
    s["tracks"]["main"]["elements"][0]["retime"] = json!({"rate":1});
    s["tracks"]["overlay"][0]["elements"] = json!([]);
    s["tracks"]["overlay"][0]["captionSource"]["words"]=json!((0..210).map(|i|json!({"text":match i {0|4=>"שלום".into(),1|5=>"לכולם".into(),2|6=>"היום".into(),3|7=>"נלמד".into(),8=>"יחד".into(),_=>format!("unique-{i}")},"start":i as f64*3.0+0.1,"end":i as f64*3.0+1.5})).collect::<Vec<_>>());
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
    assert_eq!(first["policyVersion"], "teleprompter-v1");
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
    assert_eq!(done["videos"][0]["groups"], videos()[0]["groups"]);
    assert_eq!(done["videos"][1]["groups"], videos()[1]["groups"]);
    assert_eq!(state(&r).await, before);
}
