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
fn request(revision: &Value, responses: &Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,"elementIds":["item-2"],"options":{"mode":"teaser","minSeconds":60,"maxSeconds":90,"maxOutputs":1},"responses":responses})
}
fn bank(job: &Value) -> Value {
    let w = job["prompt"]["words"].as_array().unwrap();
    let first = w[0]["id"].as_u64().unwrap();
    json!({"summary":"מקור עם רעיונות ושאלות","candidates":[{"firstWord":first,"lastWord":first+3,"role":"שאלה","reason":"שאלה קצרה חשובה לשרשרת","contextRisk":"none"}]})
}
fn draft() -> Value {
    let parts = vec![
        (0, 5),
        (40, 44),
        (80, 84),
        (120, 124),
        (160, 164),
        (200, 204),
    ]
    .iter()
    .map(|(a, b)| json!({"firstWord":a,"lastWord":b}))
    .collect::<Vec<_>>();
    let beats=["hook","proof","question","contrast","stakes","open ending"].iter().map(|role|json!({"role":role,"why":"New information","connection":"Escalates the preceding idea"})).collect::<Vec<_>>();
    json!({"premise":"A connected argument","audiencePromise":"Learn the actual method","beats":beats,"videos":[{"title":"טיזר","openingHook":"פתיחה","endingHook":"שאלה","confidence":0.9,"alternatives":[{"label":"מומלץ","reason":"רצף נושאי","parts":parts}]}]})
}
fn critique(pass: bool) -> Value {
    json!({"standaloneOpening":true,"truthfulContext":pass,"honestQuestionAnswers":true,"progression":true,"specificPayoff":true,"earnedOpenEnding":true,"nonRepetitive":true,"issues":if pass{vec![]}else{vec!["Lost qualifier in beat 2"]},"evidence":"Beat 1 introduces the topic; beat 2 provides a specific result; verify the qualifier on beat 2 against the next sentence."})
}
async fn inventories(r: &OpenCutRuntime, revision: &Value) -> Value {
    let mut responses = json!({});
    for _ in 0..10 {
        let step = call(
            r,
            "timeline.classic.podcast.editorial",
            request(revision, &responses),
        )
        .await;
        if step["requests"][0]["stage"] != "inventory" {
            return responses;
        }
        assert!(step["requests"].as_array().unwrap().len() <= 2);
        for job in step["requests"].as_array().unwrap() {
            responses[job["key"].as_str().unwrap()] = bank(job);
        }
    }
    panic!("unbounded inventory")
}
#[tokio::test]
async fn global_inventory_context_tool_critique_repair_and_extract_preserve_source() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    let mut responses = inventories(&r, rev).await;
    assert_eq!(responses.as_object().unwrap().len(), 3);
    responses["draft:0"] = json!({"contextRequests":[{"firstWord":100,"lastWord":130}]});
    let lookup = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(lookup["requests"][0]["key"], "draft:0:context");
    assert_eq!(
        lookup["requests"][0]["prompt"]["requestedContext"][0]["selected"]
            .as_array()
            .unwrap()
            .len(),
        31
    );
    responses["draft:0:context"] = draft();
    let review = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(review["requests"][0]["stage"], "critique");
    assert!(
        review["requests"][0]["prompt"]["sourceEvidence"][0]["after"]
            .as_array()
            .unwrap()
            .len()
            > 0
    );
    responses["critique:0"] = critique(false);
    let repair = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(repair["requests"][0]["key"], "draft:1");
    assert!(
        repair["requests"][0]["prompt"]["feedback"]
            .to_string()
            .contains("Lost qualifier")
    );
    responses["draft:1"] = draft();
    responses["critique:1"] = critique(true);
    // A valid detailed Hebrew explanation must not be rejected at 2000 UTF-8
    // bytes and send an otherwise accepted narrative back for pointless edits.
    responses["critique:1"]["evidence"]=json!("הטענה ביחידה הראשונה נשמרת בהקשר המקורי, והיחידה הבאה מספקת דוגמה קונקרטית. ".repeat(25));
    let done = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(done["complete"], true);
    assert_eq!(done["report"]["rounds"], 2);
    assert_eq!(
        done["report"]["windowsReviewed"],
        done["report"]["windowsTotal"]
    );
    assert_eq!(call(&r, "app.state.read", json!({})).await["value"], before);
    let mut apply = request(rev, &json!({}));
    apply.as_object_mut().unwrap().remove("responses");
    apply["videos"] = done["videos"].clone();
    call(&r, "timeline.classic.podcast.extract", apply).await;
    let after = call(&r, "app.state.read", json!({})).await["value"].clone();
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][0],
        before["project"]["classic"]["document"]["scenes"][0]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap()
            .len(),
        before["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap()
            .len()
            + 1
    );
}
#[tokio::test]
async fn rejects_single_excerpt_and_adjacent_fake_montage_even_if_model_asserts_quality() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    for fake_montage in [false, true] {
        let mut responses = inventories(&r, rev).await;
        let mut d = draft();
        d["videos"][0]["alternatives"][0]["parts"] = if fake_montage {
            json!([{"firstWord":0,"lastWord":8},{"firstWord":9,"lastWord":17},{"firstWord":18,"lastWord":28}])
        } else {
            json!([{"firstWord":0,"lastWord":28}])
        };
        responses["draft:0"] = d;
        responses["critique:0"] = critique(true);
        let next = call(
            &r,
            "timeline.classic.podcast.editorial",
            request(rev, &responses),
        )
        .await;
        assert_eq!(next["complete"], false);
        assert_eq!(next["requests"][0]["key"], "draft:1");
        assert!(
            next["requests"][0]["prompt"]["feedback"]
                .to_string()
                .contains("effective source passages")
        );
    }
}
#[tokio::test]
async fn malformed_short_moments_repair_without_20_second_minimum_and_bounds_are_enforced() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    let first = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &json!({})),
    )
    .await;
    assert!(
        first["requests"][0]["instructions"]
            .as_str()
            .unwrap()
            .contains("No 20-second minimum")
    );
    let mut responses = json!({"inventory:0:0":{"summary":"חומר","candidates":[{"firstWord":900,"lastWord":905,"role":"hook","reason":"bad","contextRisk":"none"}]}});
    let next = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(next["requests"][0]["key"], "inventory:0:1");
    responses = inventories(&r, rev).await;
    responses["draft:0"] = json!({"contextRequests":[{"firstWord":0,"lastWord":209}]});
    let repaired = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(repaired["requests"][0]["key"], "draft:1");
    assert!(
        repaired["requests"][0]["prompt"]["feedback"]
            .to_string()
            .contains("201 words")
    );
    let mut stale = request(rev, &json!({}));
    stale["expectedRevision"] = json!(0);
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.podcast.editorial",
                InvocationContext::default(),
                stale
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn failed_semantic_review_never_returns_plan_after_three_drafts() {
    let (r, before) = setup().await;
    let rev = &before["revision"];
    let mut responses = inventories(&r, rev).await;
    for round in 0..3 {
        responses[format!("draft:{round}")] = draft();
        responses[format!("critique:{round}")] = critique(false);
    }
    let stopped = call(
        &r,
        "timeline.classic.podcast.editorial",
        request(rev, &responses),
    )
    .await;
    assert_eq!(stopped["complete"], false);
    assert!(
        stopped["report"]["error"]
            .as_str()
            .unwrap()
            .contains("three drafts")
    );
    assert_eq!(stopped["report"]["resetKeys"].as_array().unwrap().len(), 6);
    assert_eq!(call(&r, "app.state.read", json!({})).await["value"], before);
}
