use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const EDIT: &str = "timeline.classic.masks.edit";
fn definitions() -> Vec<Value> {
    vec![
        json!({"type":"square","name":"Square","defaultSizing":"square","features":{},
        "defaults":{"width":0.6,"height":0.6,"inverted":false,"feather":0,"label":"test"},
        "params":[{"key":"feather","type":"number","default":0}]}),
        json!({"type":"band","name":"Band","defaultSizing":"diagonal","features":{},
        "defaults":{"width":1.4142135623730951,"height":0.6},"params":[]}),
    ]
}

#[tokio::test]
async fn mask_catalog_creation_update_and_dry_preview_share_the_document_contract() {
    let r = setup().await;
    let signature = r.classic_mask_catalog().replace(definitions()).unwrap();
    let catalog = call(
        &r,
        "masks.classic.catalog.read",
        json!({"projectId":"classic-project","query":"square","includeParameters":true}),
    )
    .await;
    assert_eq!(catalog["catalogRevision"], signature);
    assert_eq!(catalog["definitions"].as_array().unwrap().len(), 1);
    for id in ["mask", "shape"] {
        let mut input = request(&read(&r).await, json!({"type":"remove"}));
        input["maskId"] = json!(id);
        call(&r, EDIT, input).await;
    }
    let before = read(&r).await;
    let mut input = request(
        &before,
        json!({"type":"create","maskType":"square","elementSize":{"width":1920,"height":1080},"params":{"feather":12}}),
    );
    input.as_object_mut().unwrap().remove("maskId");
    input["catalogRevision"] = json!(signature);
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
        .unwrap()
        .result
        .data;
    assert_eq!(read(&r).await, before);
    let added = call(&r, EDIT, input).await;
    assert_eq!(added["masks"], dry["masks"]);
    let after = read(&r).await;
    assert_eq!(masks(&after), &added["masks"]);
    assert!((masks(&after)[0]["params"]["width"].as_f64().unwrap() - 0.3375).abs() < 1e-12);
    assert_eq!(masks(&after)[0]["params"]["height"], 0.6);
    let mut update = request(
        &after,
        json!({"type":"update","params":{"label":"שלום","feather":7}}),
    );
    update["maskId"] = masks(&after)[0]["id"].clone();
    update["catalogRevision"] = json!(signature);
    for params in [json!({"unknown":1}), json!({"width":"large"})] {
        let mut invalid = update.clone();
        invalid["change"]["params"] = params;
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), invalid)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, after);
    }
    call(&r, EDIT, update).await;
    let edited = read(&r).await;
    assert_eq!(
        masks(&edited)[0]["params"]["width"],
        masks(&after)[0]["params"]["width"]
    );
    assert_eq!(masks(&edited)[0]["params"]["label"], "שלום");
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
}

#[tokio::test]
async fn mask_catalog_rejects_invalid_or_stale_updates_and_publishes_future_definitions() {
    let r = setup().await;
    let signature = r.classic_mask_catalog().replace(definitions()).unwrap();
    assert_eq!(
        opencut_editor_api::ClassicMaskCatalog::default()
            .replace(definitions())
            .unwrap(),
        signature
    );
    let before = read(&r).await;
    let mut create = request(&before, json!({"type":"create","maskType":"square"}));
    create.as_object_mut().unwrap().remove("maskId");
    create["catalogRevision"] = json!(signature);
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), create)
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    let mut defs = definitions();
    defs.push(json!({"type":"future-mask","name":"Future mask","defaultSizing":"fixed","params":[],"defaults":{"strength":0.8}}));
    let next = r.classic_mask_catalog().replace(defs.clone()).unwrap();
    assert_ne!(next, signature);
    let found = call(
        &r,
        "masks.classic.catalog.read",
        json!({"projectId":"classic-project","maskType":"future-mask","includeParameters":true}),
    )
    .await;
    assert_eq!(found["definitions"][0]["defaults"]["strength"], 0.8);
    defs.push(defs[0].clone());
    assert!(r.classic_mask_catalog().replace(defs).is_err());
    assert_eq!(
        call(
            &r,
            "masks.classic.catalog.read",
            json!({"projectId":"classic-project"})
        )
        .await["catalogRevision"],
        next
    );
    for params in [json!({"unknown":1}), json!({"width":"large"})] {
        let mut input = request(&before, json!({"type":"update","params":params}));
        input["catalogRevision"] = json!(next);
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let mut stale = request(&before, json!({"type":"update","params":{}}));
    stale["catalogRevision"] = json!(signature);
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), stale)
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
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
fn masks(state: &Value) -> &Value {
    &state["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["masks"]
}
fn request(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"video-track","elementId":"item-2","maskId":"shape","expectedRevision":state["revision"],"change":change})
}
fn insertion(segment: usize) -> Value {
    json!({"type":"insertPoint","segmentIndex":segment,"canvasPoint":{"x":960,"y":270},"bounds":{"cx":960,"cy":540,"width":1920,"height":1080,"rotation":0}})
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["masks"].as_array_mut().unwrap().push(json!({
        "id":"shape","type":"freeform","futureMask":{"hello":"שלום"},"params":{
            "closed":true,"centerX":0,"centerY":0,"rotation":0,"scale":1,"inverted":false,"feather":3,"futureParam":42,
            "path":[
                {"id":"a","x":-0.25,"y":-0.25,"inX":0,"inY":0,"outX":0,"outY":0,"futurePoint":true},
                {"id":"b","x":0.25,"y":-0.25,"inX":0,"inY":0,"outX":0,"outY":0},
                {"id":"c","x":0,"y":0.25,"inX":0,"inY":0,"outX":0,"outY":0}
            ]
        }
    }));
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}

#[tokio::test]
async fn masks_preserve_complete_project_with_dry_run_retry_history_and_reopen() {
    let r = setup().await;
    let before = read(&r).await;
    let input = request(&before, insertion(0));
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
        .insert("opencut/idempotencyKey".into(), json!("insert-point"));
    let receipt = r
        .registry()
        .invoke(EDIT, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(EDIT, context, input).await.unwrap(),
        receipt
    );
    let id = receipt.result.data["insertedPointId"].clone();
    assert_eq!(dry.result.data["insertedPointId"], id);
    let after = read(&r).await;
    assert_eq!(
        masks(&after)[1]["params"]["path"][1],
        json!({"id":id,"x":0.0,"y":0.0-0.25,"inX":0.0,"inY":0.0,"outX":0.0,"outY":0.0})
    );
    assert_eq!(masks(&after)[1]["params"]["path"][0]["futurePoint"], true);
    let mut expected = before["project"]["classic"].clone();
    expected["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["masks"] =
        masks(&after).clone();
    assert_eq!(after["project"]["classic"], expected);
    for change in [
        json!({"type":"toggleInverted"}),
        json!({"type":"setInverted","inverted":false}),
        json!({"type":"deletePoints","pointIds":[id,"b","absent","b"]}),
        json!({"type":"remove"}),
    ] {
        let previous = read(&r).await;
        let result = call(&r, EDIT, request(&previous, change.clone())).await;
        let edited = read(&r).await;
        if change["type"] == "deletePoints" {
            assert_eq!(result["removedPointIds"].as_array().unwrap().len(), 2);
            assert_eq!(masks(&edited)[1]["params"]["closed"], false);
        }
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
    assert_eq!(masks(&read(&restored).await)[1]["id"], "shape");
}

#[tokio::test]
async fn masks_reject_invalid_targets_geometry_and_cancel_without_mutation() {
    let r = setup().await;
    let before = read(&r).await;
    let valid = request(&before, insertion(0));
    for (key, value) in [
        ("projectId", json!("other")),
        ("sceneId", json!("other-scene")),
        ("trackId", json!("titles")),
        ("elementId", json!("missing")),
        ("maskId", json!("missing")),
        ("expectedRevision", json!(999)),
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
    for change in [
        insertion(99),
        json!({"type":"deletePoints","pointIds":[""]}),
        json!({"type":"setInverted","inverted":"true"}),
    ] {
        assert!(
            r.registry()
                .invoke(EDIT, InvocationContext::default(), request(&before, change))
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let mut invalid = valid.clone();
    invalid["change"]["bounds"]["width"] = json!(-1);
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), invalid)
            .await
            .is_err()
    );
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(EDIT, context, valid).await.is_err());
    assert_eq!(read(&r).await, before);
    // Removing an opaque legacy mask remains supported; unrelated legacy envelopes need no rewrite.
    let mut legacy = request(&before, json!({"type":"remove"}));
    legacy["maskId"] = json!("mask");
    call(&r, EDIT, legacy).await;
    assert_eq!(masks(&read(&r).await).as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn masks_handle_closing_segment_and_keep_unknown_point_metadata() {
    let r = setup().await;
    let before = read(&r).await;
    let result = call(&r, EDIT, request(&before, insertion(2))).await;
    let after = read(&r).await;
    let points = &masks(&after)[1]["params"]["path"];
    assert_eq!(points[0]["id"], result["insertedPointId"]);
    assert_eq!(points[1]["futurePoint"], true);
    assert_eq!(masks(&after)[0], masks(&before)[0]);
    call(
        &r,
        EDIT,
        request(&after, json!({"type":"deletePoints","pointIds":["a","b"]})),
    )
    .await;
    let open = read(&r).await;
    assert_eq!(masks(&open)[1]["params"]["closed"], false);
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                request(&open, insertion(1))
            )
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, open);
}
