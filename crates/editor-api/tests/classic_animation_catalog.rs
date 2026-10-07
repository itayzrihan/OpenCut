use opencut_editor_api::{ClassicAnimationGroup, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const READ: &str = "animation.classic.targets.read";
fn parameter(key: &str) -> Value {
    json!({"key":key,"label":format!("Label {key}"),"type":"number","default":2,"min":0,"max":10,"step":0.1,
        "channelLayout":{"kind":"leaf","easingMode":"independent","component":{"key":"value","valueKind":"scalar","defaultInterpolation":"linear"}}})
}
fn groups() -> Vec<ClassicAnimationGroup> {
    serde_json::from_value(json!([
        {"target":{"kind":"element","elementType":"video","pathPrefix":""},"params":[parameter("opacity"),parameter("future.value")]},
        {"target":{"kind":"effect","effectType":"future-effect","elementTypes":["video"]},"params":[parameter("amount")]},
        {"target":{"kind":"element","elementType":"graphic","definitionId":"future-graphic","pathPrefix":"params."},"params":[parameter("size")]},
        {"target":{"kind":"element","elementType":"effect","paramKind":"camera","pathPrefix":"params."},"params":[parameter("camera.x")]}
    ])).unwrap()
}
async fn call(r: &OpenCutRuntime, name: &str, input: Value) -> Value {
    r.registry()
        .invoke(name, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let clip = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    clip["params"]["future.value"] = json!(4);
    clip["effects"] = json!([
        {"id":"fx-a","type":"future-effect","enabled":true,"params":{"amount":5}},
        {"id":"fx-b","type":"future-effect","enabled":false,"params":{"amount":6}}
    ]);
    clip["animations"] =
        json!({"opacity":{"keys":[{"id":"k","time":0,"value":1,"segmentToNext":"linear"}]}});
    call(
        &r,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn request() -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"video-track","elementId":"item-2","includeParameters":true})
}

#[tokio::test]
async fn live_catalog_resolves_only_real_targets_with_bounded_discovery_and_no_document_edits() {
    let r = setup().await;
    assert!(
        r.registry()
            .invoke(READ, InvocationContext::default(), request())
            .await
            .is_err()
    );
    let before = call(&r, "app.state.read", json!({})).await;
    let revision = r.classic_animation_catalog().replace(groups()).unwrap();
    let all = call(&r, READ, request()).await;
    assert_eq!(all["catalogRevision"], revision);
    assert_eq!(all["revision"], before["value"]["revision"]);
    assert_eq!(all["total"], 4);
    assert_eq!(all["targets"][0]["propertyPath"], "opacity");
    assert_eq!(all["targets"][0]["animated"], true);
    assert_eq!(all["targets"][1]["baseValue"], 4);
    assert_eq!(all["targets"][1]["animated"], false);
    assert_eq!(
        all["targets"][2]["propertyPath"],
        "effects.fx-a.params.amount"
    );
    assert_eq!(all["targets"][2]["baseValue"], 5);
    assert_eq!(all["targets"][3]["baseValue"], 6);
    assert_eq!(all["targets"][3]["baseTarget"]["effectId"], "fx-b");
    let mut paged = request();
    paged["limit"] = json!(2);
    paged["includeParameters"] = json!(false);
    let first = call(&r, READ, paged.clone()).await;
    assert_eq!(first["nextOffset"], 2);
    assert!(first["targets"][0].get("parameter").is_none());
    assert_eq!(first["targets"][0]["label"], "Label opacity");
    paged["offset"] = first["nextOffset"].clone();
    let last = call(&r, READ, paged).await;
    assert_eq!(last["targets"].as_array().unwrap().len(), 2);
    assert!(last["nextOffset"].is_null());
    let mut query = request();
    query["query"] = json!("FX-B");
    assert_eq!(call(&r, READ, query).await["total"], 1);
    assert_eq!(call(&r, "app.state.read", json!({})).await, before);
}

#[tokio::test]
async fn definitions_update_atomically_with_stable_content_identity_and_scope_checks() {
    let r = setup().await;
    let mut definitions = groups();
    let original = r
        .classic_animation_catalog()
        .replace(definitions.clone())
        .unwrap();
    assert_eq!(
        original,
        r.classic_animation_catalog()
            .replace(definitions.clone())
            .unwrap()
    );
    let before = call(&r, READ, request()).await;
    definitions[0].params.push(parameter("added-after-attach"));
    let next = r
        .classic_animation_catalog()
        .replace(definitions.clone())
        .unwrap();
    assert_ne!(original, next);
    assert_eq!(call(&r, READ, request()).await["total"], 5);
    definitions[0].params.push(parameter("added-after-attach"));
    assert!(r.classic_animation_catalog().replace(definitions).is_err());
    assert_eq!(call(&r, READ, request()).await["catalogRevision"], next);
    for (key, value) in [
        ("projectId", json!("another-user-project")),
        ("sceneId", json!("missing")),
        ("trackId", json!("missing")),
        ("elementId", json!("missing")),
        ("limit", json!(101)),
        ("limit", json!(0)),
        ("expectedRevision", json!(999999)),
    ] {
        let mut input = request();
        input[key] = value;
        assert!(
            r.registry()
                .invoke(READ, InvocationContext::default(), input)
                .await
                .is_err(),
            "{key}"
        );
    }
    let mut input = request();
    input["expectedRevision"] = before["revision"].clone();
    input["propertyPath"] = json!("added-after-attach");
    assert_eq!(call(&r, READ, input).await["targets"][0]["baseValue"], 2);
}

#[tokio::test]
async fn selector_precedence_and_disabled_parameters_match_product_resolution() {
    let r = setup().await;
    let mut definitions = groups();
    definitions[0].params[1]["keyframable"] = json!(false);
    let mut special: ClassicAnimationGroup = serde_json::from_value(json!({
        "target":{"kind":"element","elementType":"video","paramKind":"special","pathPrefix":""},
        "params":[parameter("opacity")]
    }))
    .unwrap();
    special.params[0]["label"] = json!("Special opacity");
    // Unmatched selectors must not shadow the generic target.
    definitions.insert(0, special);
    r.classic_animation_catalog().replace(definitions).unwrap();
    let all = call(&r, READ, request()).await;
    assert_eq!(all["total"], 3);
    assert_eq!(all["targets"][0]["parameter"]["label"], "Label opacity");
    let mut invalid = groups();
    invalid[0].params[0]["channelLayout"]["component"]["key"] = json!("wrong");
    assert!(r.classic_animation_catalog().replace(invalid).is_err());
    assert_eq!(call(&r, READ, request()).await, all);
}
