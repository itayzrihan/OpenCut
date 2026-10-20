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
async fn setup() -> (OpenCutRuntime, Value) {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let s = &mut classic["document"]["scenes"][0];
    s["tracks"]["main"]["elements"][0]["duration"] = json!(650 * 120000);
    s["tracks"]["main"]["elements"][0]["retime"] = json!({"rate":1});
    s["tracks"]["overlay"][0]["elements"] = json!([]);
    s["tracks"]["overlay"][0]["captionSource"]["words"]=json!((0..210).map(|i|json!({"text":format!("מילה{i}"),"start":i as f64*3.0+0.1,"end":i as f64*3.0+1.5})).collect::<Vec<_>>());
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let state = call(&r, "app.state.read", json!({})).await["value"].clone();
    (r, state)
}
fn request(revision: &Value, mode: &str, responses: &Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,"elementIds":["item-2"],"options":{"mode":mode,"minSeconds":20,"maxSeconds":60,"maxOutputs":8},"responses":responses})
}
async fn inventories(r: &OpenCutRuntime, rev: &Value, mode: &str) -> Value {
    let mut responses = json!({});
    for _ in 0..10 {
        let step = call(
            r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        if step["requests"][0]["stage"] != "inventory" {
            return responses;
        }
        assert!(step["requests"].as_array().unwrap().len() <= 2);
        for job in step["requests"].as_array().unwrap() {
            let first = job["prompt"]["words"][0]["id"].as_u64().unwrap();
            responses[job["key"].as_str().unwrap()] = json!({"summary":"שאלה ודוגמה עם פתרון","candidates":[{"firstWord":first,"lastWord":first+10,"role":"תשובה","reason":"מנגנון ספציפי והסבר","contextRisk":"none"}]});
        }
    }
    panic!("unbounded source mapping")
}
fn short(parts: Value) -> Value {
    let beats=parts.as_array().unwrap().iter().map(|_|json!({"role":"הסבר","why":"דוגמה קונקרטית ולא סיסמה","connection":"התפתחות הגיונית למסקנה"})).collect::<Vec<_>>();
    json!({"premise":"איך לשנות שאלה כדי להבין צורך","audiencePromise":"שאלה מעשית וההסבר מדוע היא עובדת","beats":beats,"video":{"title":"שאלה שמבינה צורך","openingHook":"שאלה ספציפית","endingHook":"מסקנה מעשית","confidence":0.9,"alternatives":[{"label":"מומלץ","reason":"תשובה עם ערך עצמאי","parts":parts}]}})
}
fn draft(parts: Value) -> Value {
    json!({"selectionReason":"הדוגמה המסוימת החזקה בפרק; אין צורך למלא מכסה","shorts":[short(parts)]})
}
fn review(index: usize, pass: bool) -> Value {
    json!({"index":index,"standaloneOpening":true,"truthfulContext":true,"honestQuestionAnswers":true,"progression":true,"specificPayoff":pass,"cleanCuts":pass,"distinctIdea":true,"issues":if pass {vec![]}else{vec!["Ending cuts the actual answer; retain its conclusion"]},"evidence":"הפתיחה מגדירה נושא, החלק הבא מספק הסבר; יש לבדוק את סוף התשובה בהקשר המקורי. ".repeat(25)})
}
#[tokio::test]
async fn both_modes_map_all_windows_inspect_context_repair_and_append_scenes_without_touching_source()
 {
    for mode in ["highlights", "chronological"] {
        let (r, before) = setup().await;
        let rev = &before["revision"];
        let mut responses = inventories(&r, rev, mode).await;
        assert_eq!(responses.as_object().unwrap().len(), 3);
        responses["draft:0"] = json!({"contextRequests":[{"firstWord":90,"lastWord":115}]});
        let lookup = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(lookup["requests"][0]["key"], "draft:0:context");
        // Complete local answer crossing the old arbitrary300s bucket boundary.
        responses["draft:0:context"] = draft(json!([{"firstWord":95,"lastWord":104}]));
        let check = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(check["requests"][0]["key"], "critique:0:0");
        assert_eq!(
            check["requests"][0]["prompt"]["shorts"][0]["sourceEvidence"][0]["before"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        assert_eq!(call(&r, "app.state.read", json!({})).await["value"], before);
        responses["critique:0:0"] = json!({"reviews":[review(0,false)]});
        let fix = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(fix["requests"][0]["key"], "draft:1");
        assert!(
            fix["requests"][0]["prompt"]["feedback"]
                .to_string()
                .contains("retain its conclusion")
        );
        responses["draft:1"] = draft(json!([{"firstWord":95,"lastWord":105}]));
        responses["critique:1:0"] = json!({"reviews":[review(0,true)]});
        let done = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(done["complete"], true);
        assert_eq!(done["policyVersion"], "podcast-shorts-v2");
        assert_eq!(done["report"]["windowsReviewed"], 3);
        assert_eq!(done["report"]["rounds"], 2);
        let mut apply = request(rev, mode, &json!({}));
        apply.as_object_mut().unwrap().remove("responses");
        apply["videos"] = done["videos"].clone();
        call(&r, "timeline.classic.podcast.extract", apply).await;
        let after = call(&r, "app.state.read", json!({})).await["value"].clone();
        let original = before["project"]["classic"]["document"].clone();
        let current = &after["project"]["classic"]["document"];
        let old_scenes = original["scenes"].as_array().unwrap();
        assert_eq!(
            current["scenes"].as_array().unwrap().len(),
            old_scenes.len() + 1
        );
        for (i, scene) in old_scenes.iter().enumerate() {
            assert_eq!(current["scenes"][i], *scene);
        }
        assert_eq!(current["transcriptionJobs"], original["transcriptionJobs"]);
        assert_eq!(current["settings"], original["settings"]);
        call(&r, "history.undo", json!({})).await;
        assert_eq!(
            call(&r, "app.state.read", json!({})).await["value"]["project"],
            before["project"]
        );
    }
}
#[tokio::test]
async fn highlights_may_reorder_but_chronological_must_keep_local_source_and_output_order() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    for mode in ["highlights", "chronological"] {
        let mut responses = inventories(&r, rev, mode).await;
        responses["draft:0"] =
            draft(json!([{"firstWord":120,"lastWord":124},{"firstWord":40,"lastWord":44}]));
        let next = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(
            next["requests"][0]["key"],
            if mode == "highlights" {
                "critique:0:0"
            } else {
                "draft:1"
            }
        );
        responses["draft:0"] =
            draft(json!([{"firstWord":0,"lastWord":4},{"firstWord":120,"lastWord":124}]));
        let next = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(
            next["requests"][0]["key"],
            if mode == "highlights" {
                "critique:0:0"
            } else {
                "draft:1"
            }
        );
        let a = short(json!([{"firstWord":110,"lastWord":120}]));
        let b = short(json!([{"firstWord":10,"lastWord":20}]));
        responses["draft:0"] = json!({"selectionReason":"Distinct insights","shorts":[a,b]});
        let next = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, mode, &responses),
        )
        .await;
        assert_eq!(
            next["requests"][0]["key"],
            if mode == "highlights" {
                "critique:0:0"
            } else {
                "draft:1"
            }
        );
    }
    assert_eq!(call(&r, "app.state.read", json!({})).await["value"], before);
}
#[tokio::test]
async fn every_short_needs_its_own_review_and_collection_cannot_reuse_words_or_skip_failed_cuts() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    let mut responses = inventories(&r, rev, "highlights").await;
    let shorts = (0..5)
        .map(|i| short(json!([{"firstWord":i*30,"lastWord":i*30+9}])))
        .collect::<Vec<_>>();
    responses["draft:0"] = json!({"selectionReason":"Different specific examples","shorts":shorts});
    let check = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, "highlights", &responses),
    )
    .await;
    assert_eq!(check["requests"].as_array().unwrap().len(), 2);
    responses["critique:0:0"] =
        json!({"reviews":(0..4).map(|i|review(i,true)).collect::<Vec<_>>()});
    let pending = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, "highlights", &responses),
    )
    .await;
    assert_eq!(pending["requests"][0]["key"], "critique:0:1");
    assert_eq!(pending["complete"], false);
    // Wrong index cannot approve an unreviewed output.
    responses["critique:0:1"] = json!({"reviews":[review(0,true)]});
    let fix = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, "highlights", &responses),
    )
    .await;
    assert_eq!(fix["requests"][0]["key"], "draft:1");
    responses["draft:1"] = json!({"selectionReason":"Duplicate forbidden","shorts":[short(json!([{"firstWord":0,"lastWord":9}])),short(json!([{"firstWord":0,"lastWord":9}]))]});
    let fix = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, "highlights", &responses),
    )
    .await;
    assert_eq!(fix["requests"][0]["key"], "draft:2");
    responses["draft:2"] = draft(json!([{"firstWord":0,"lastWord":2}]));
    let end = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, "highlights", &responses),
    )
    .await;
    assert_eq!(end["complete"], false);
    assert!(end["report"]["error"].is_string());
    assert!(
        !end["report"]["resetKeys"]
            .to_string()
            .contains("inventory:")
    );
    assert_eq!(call(&r, "app.state.read", json!({})).await["value"], before);
}
