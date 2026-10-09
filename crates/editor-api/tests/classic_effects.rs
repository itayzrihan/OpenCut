use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const EDIT: &str = "timeline.classic.effects.edit";
const CATALOG: &str = "effects.classic.catalog.read";
fn definitions() -> Vec<Value> {
    vec![
        json!({"type":"blur","name":"Blur","keywords":["soft"],"params":[{"key":"intensity","type":"number","default":15,"min":0,"max":100}]}),
        json!({"type":"custom-ai-effect","name":"Custom","params":[]}),
    ]
}
async fn call(r: &OpenCutRuntime, id: &str, value: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), value)
        .await
        .unwrap()
        .result
        .data
}
async fn read(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r.classic_effect_catalog().replace(definitions()).unwrap();
    r
}
fn request(state: &Value, change: Value) -> Value {
    let version = opencut_editor_api::ClassicEffectCatalog::default()
        .replace(definitions())
        .unwrap();
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"video-track","elementId":"item-2","expectedRevision":state["revision"],"catalogRevision":version,"change":change})
}
fn effects(state: &Value) -> &Value {
    &state["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["effects"]
}

#[tokio::test]
async fn effects_preserve_the_project_and_history_across_edit_variants() {
    let r = setup().await;
    let before = read(&r).await;
    let input = request(
        &before,
        json!({"type":"add","effectType":" Zoom_Blur ","params":{"intensity":23,"future":true}}),
    );
    let dry = r
        .registry()
        .invoke(
            EDIT,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("add-one"));
    let added = r
        .registry()
        .invoke(EDIT, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(EDIT, context, input).await.unwrap(),
        added
    );
    let id = &added.result.data["effectId"];
    assert_eq!(dry.result.data["effectId"], *id);
    let after = read(&r).await;
    let mut expected = before["project"]["classic"].clone();
    let effect =
        json!({"id":id,"type":"blur","enabled":true,"params":{"intensity":23,"future":true}});
    expected["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["effects"]
        .as_array_mut()
        .unwrap()
        .push(effect.clone());
    assert_eq!(after["project"]["classic"], expected);
    for change in [
        json!({"type":"update","effectId":id,"params":{"intensity":45}}),
        json!({"type":"toggle","effectId":id}),
        json!({"type":"setEnabled","effectId":id,"enabled":true}),
        json!({"type":"reorder","fromIndex":effects(&after).as_array().unwrap().len()-1,"toIndex":0}),
        json!({"type":"remove","effectId":id}),
    ] {
        let previous = read(&r).await;
        call(&r, EDIT, request(&previous, change)).await;
        let edited = read(&r).await;
        call(&r, "history.undo", json!({})).await;
        assert_eq!(read(&r).await["project"], previous["project"]);
        call(&r, "history.redo", json!({})).await;
        assert_eq!(read(&r).await["project"], edited["project"]);
    }
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let restored = OpenCutRuntime::default();
    call(
        &restored,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    call(&restored, "history.undo", json!({})).await;
    assert!(
        effects(&read(&restored).await)
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == *id)
    );
}

#[tokio::test]
async fn catalog_updates_are_live_and_stale_or_invalid_edits_cannot_commit() {
    let r = setup().await;
    let before = read(&r).await;
    let catalog = call(
        &r,
        CATALOG,
        json!({"projectId":"classic-project","query":"soft","includeParameters":true}),
    )
    .await;
    assert_eq!(catalog["definitions"][0]["params"][0]["default"], 15);
    assert!(
        call(&r, CATALOG, json!({"projectId":"classic-project"})).await["definitions"][0]
            .get("params")
            .is_none()
    );
    for change in [
        json!({"type":"add","effectType":"unknown"}),
        json!({"type":"add","effectType":"blur","params":{"intensity":{}}}),
        json!({"type":"toggle","effectId":"missing"}),
        json!({"type":"reorder","fromIndex":99,"toIndex":0}),
    ] {
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), request(&before, change))
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let valid = request(&before, json!({"type":"add","effectType":"blur"}));
    for (key, value) in [
        ("projectId", json!("elsewhere")),
        ("sceneId", json!("missing")),
        ("trackId", json!("missing")),
        ("elementId", json!("missing")),
        ("expectedRevision", json!(999)),
        ("catalogRevision", json!("stale")),
    ] {
        let mut input = valid.clone();
        input[key] = value;
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        r.registry()
            .invoke(EDIT, context, valid.clone())
            .await
            .is_err()
    );
    let mut next = definitions();
    next.push(json!({"type":"future","name":"Future effect","params":[{"key":"strength","type":"number","default":0.6}]}));
    let version = r.classic_effect_catalog().replace(next.clone()).unwrap();
    assert_ne!(version, catalog["catalogRevision"].as_str().unwrap());
    assert_eq!(
        r.classic_effect_catalog().replace(next.clone()).unwrap(),
        version
    );
    assert_eq!(
        opencut_editor_api::ClassicEffectCatalog::default()
            .replace(next)
            .unwrap(),
        version
    );
    assert!(
        r.classic_effect_catalog()
            .replace(vec![json!({"type":"broken"})])
            .is_err()
    );
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), valid)
            .await
            .is_err()
    );
    let mut future = request(&before, json!({"type":"add","effectType":"future"}));
    future["catalogRevision"] = json!(version);
    call(&r, EDIT, future).await;
    assert_eq!(
        effects(&read(&r).await).as_array().unwrap().last().unwrap()["params"]["strength"],
        0.6
    );
}

#[tokio::test]
async fn custom_fallback_is_explicit_and_preview_gestures_keep_one_durable_undo() {
    let r = setup().await;
    let id = call(
        &r,
        EDIT,
        request(
            &read(&r).await,
            json!({"type":"add","effectType":"unknown glow","allowCustomFallback":true}),
        ),
    )
    .await["effectId"]
        .clone();
    let initial = read(&r).await;
    let custom = effects(&initial).as_array().unwrap().last().unwrap();
    assert_eq!(custom["type"], "custom-ai-effect");
    assert_eq!(custom["params"]["requestedType"], "unknown glow");
    for intensity in [20, 40, 50] {
        let mut input = request(
            &read(&r).await,
            json!({"type":"update","effectId":id,"params":{"intensity":intensity}}),
        );
        input["historyGroup"] = json!("drag-one");
        call(&r, EDIT, input).await;
    }
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], initial["project"]);
}
