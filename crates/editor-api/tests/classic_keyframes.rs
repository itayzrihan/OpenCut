use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const EDIT: &str = "timeline.classic.keyframes.edit";
const TARGET: &str = "/project/classic/document/scenes/0/tracks/main/elements/0";
const UPSERT: &str = "timeline.classic.keyframes.upsert";
const REMOVE: &str = "timeline.classic.keyframes.remove";
const COPY: &str = "animation.classic.keyframes.copy";
const PASTE: &str = "timeline.classic.keyframes.paste";

fn copy_request(state: &Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"video-track","elementId":"item-2","expectedRevision":state["revision"],
        "keyframes":[{"propertyPath":"opacity","keyframeId":"c"},{"propertyPath":"opacity","keyframeId":"a"},{"propertyPath":"params.future","keyframeId":"a"},{"propertyPath":"opacity","keyframeId":"missing"}]})
}
fn paste_request(state: &Value, catalog: &str, items: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"video-track","elementId":"item-2","expectedRevision":state["revision"],"catalogRevision":catalog,"time":300,"items":items})
}

#[tokio::test]
async fn clipboard_copy_is_revision_fenced_and_does_not_mutate_source() {
    let r = setup().await;
    let before = read(&r).await;
    let result = call(&r, COPY, copy_request(&before)).await;
    assert_eq!(read(&r).await, before);
    assert_eq!(result["revision"], before["revision"]);
    let items = result["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["timeOffset"], 0);
    assert_eq!(items[1]["timeOffset"], 200);
    assert_eq!(items[0]["value"], 0.0);
    assert_eq!(items[1]["value"], 2.0);
    assert_eq!(items[0]["interpolation"], "bezier");
    assert_eq!(
        items[0]["curvePatches"][0]["patch"]["rightHandle"],
        json!({"dt":80,"dv":0.5})
    );
    assert_eq!(
        items[0]["curvePatches"][0]["patch"]["leftHandle"],
        Value::Null
    );
    assert_eq!(result["skipped"].as_array().unwrap().len(), 2);
    for (field, value) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("trackId", json!("wrong")),
        ("elementId", json!("wrong")),
        ("expectedRevision", json!(0)),
    ] {
        let mut input = copy_request(&before);
        input[field] = value;
        assert!(
            r.registry()
                .invoke(COPY, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
}

#[tokio::test]
async fn clipboard_paste_shares_coercion_curve_order_retries_and_reopened_history() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let copied = call(&r, COPY, copy_request(&before)).await;
    let mut items = copied["items"].as_array().unwrap().clone();
    let mut unsupported = items[0].clone();
    unsupported["propertyPath"] = json!("unsupported.future");
    items.push(unsupported);
    items[1]["curvePatches"]
        .as_array_mut()
        .unwrap()
        .push(json!({"componentKey":"missing","patch":{"leftHandle":null}}));
    let input = paste_request(&before, &catalog, json!(items));
    let dry = r
        .registry()
        .invoke(
            PASTE,
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
        .insert("opencut/idempotencyKey".into(), json!("paste-keys"));
    let receipt = r
        .registry()
        .invoke(PASTE, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        receipt.result.data["keyframes"],
        dry.result.data["keyframes"]
    );
    assert_eq!(receipt.result.data["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(
        receipt.result.data["skippedCurves"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        r.registry().invoke(PASTE, context, input).await.unwrap(),
        receipt
    );
    let after = read(&r).await;
    let keys = animations(&after)["opacity"]["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 5);
    assert_eq!(keys[3]["time"], 300);
    assert_eq!(keys[4]["time"], 500);
    assert_eq!(keys[4]["value"], 1.0);
    assert_eq!(keys[3]["segmentToNext"], "bezier");
    assert!(keys[3].get("rightHandle").is_none()); // normalized while this key was the edge
    assert_eq!(keys[4]["leftHandle"]["dt"], -200);
    assert_eq!(
        animations(&after)["opaqueMetadata"],
        animations(&before)["opaqueMetadata"]
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(read(&reopened).await["project"], after["project"]);
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], before["project"]);
}

#[tokio::test]
async fn clipboard_paste_invalid_tail_rolls_back_edits_and_ids() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let copied = call(&r, COPY, copy_request(&before)).await;
    for bad in [
        json!({"propertyPath":"opacity","timeOffset":0,"value":"wrong","interpolation":"linear","curvePatches":[]}),
        json!({"propertyPath":"opacity","timeOffset":9007199254740992_i64,"value":0.4,"interpolation":"linear","curvePatches":[]}),
        json!({"propertyPath":"opacity","timeOffset":0,"value":0.4,"interpolation":"linear","curvePatches":[{"componentKey":"value","patch":{"leftHandle":{"dt":9007199254740992_i64,"dv":0}}}]}),
    ] {
        let input = paste_request(&before, &catalog, json!([copied["items"][0], bad]));
        assert!(
            r.registry()
                .invoke(PASTE, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let valid = paste_request(&before, &catalog, copied["items"].clone());
    for (field, bad) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("catalogRevision", json!("old")),
        ("expectedRevision", json!(0)),
    ] {
        let mut input = valid.clone();
        input[field] = bad;
        assert!(
            r.registry()
                .invoke(PASTE, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(PASTE, context, valid).await.is_err());
    assert_eq!(read(&r).await, before);
}

fn remove_key(path: &str, id: &str) -> Value {
    json!({"trackId":"video-track", "elementId":"item-2", "propertyPath":path,"keyframeId":id})
}
fn remove_request(state: &Value, catalog: &str, keys: Vec<Value>) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"catalogRevision":catalog,
        "playheadTime":50,"preserveAtPlayhead":true,"keyframes":keys})
}

#[tokio::test]
async fn deletion_samples_original_batch_and_preserves_metadata_receipts_and_reopened_undo() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let start = before.pointer(TARGET).unwrap()["startTime"]
        .as_i64()
        .unwrap();
    let mut input = remove_request(
        &before,
        &catalog,
        vec![
            remove_key("opacity", "a"),
            remove_key("opacity", "b"),
            remove_key("opacity", "c"),
        ],
    );
    input["playheadTime"] = json!(start + 50);
    let dry = r
        .registry()
        .invoke(
            REMOVE,
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
        .insert("opencut/idempotencyKey".into(), json!("remove-keys"));
    let result = r
        .registry()
        .invoke(REMOVE, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(result.result.data["revision"], dry.result.data["revision"]);
    assert_eq!(
        result.result.data["changedIds"],
        dry.result.data["changedIds"]
    );
    assert_eq!(dry.result.data["committed"], false);
    assert_eq!(result.result.data["committed"], true);
    assert_eq!(
        r.registry().invoke(REMOVE, context, input).await.unwrap(),
        result
    );
    let after = read(&r).await;
    assert!(animations(&after).get("opacity").is_none());
    // Original symmetric Bezier midpoint; later samples after removal would be 1 or 2.
    assert_eq!(after.pointer(TARGET).unwrap()["params"]["opacity"], 0.5);
    let mut expected = before["project"].clone();
    let element =
        &mut expected["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    element["params"]["opacity"] = json!(0.5);
    element["animations"]
        .as_object_mut()
        .unwrap()
        .remove("opacity");
    assert_eq!(after["project"], expected);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(read(&reopened).await["project"], after["project"]);
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], before["project"]);
}

#[tokio::test]
async fn deletion_validates_entire_batch_and_scope_before_commit() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let valid = remove_request(&before, &catalog, vec![remove_key("opacity", "a")]);
    for (field, bad) in [
        ("projectId", json!("other")),
        ("sceneId", json!("other")),
        ("expectedRevision", json!(0)),
        ("catalogRevision", json!("old")),
        ("playheadTime", json!(9007199254740992_i64)),
    ] {
        let mut input = valid.clone();
        input[field] = bad;
        assert!(
            r.registry()
                .invoke(REMOVE, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let bad = remove_request(
        &before,
        &catalog,
        vec![remove_key("opacity", "a"), remove_key("opacity", "missing")],
    );
    assert!(
        r.registry()
            .invoke(REMOVE, InvocationContext::default(), bad)
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(REMOVE, context, valid).await.is_err());
    assert_eq!(read(&r).await, before);
    let mut keep = remove_request(
        &before,
        &catalog,
        vec![
            remove_key("opacity", "a"),
            remove_key("opacity", "b"),
            remove_key("opacity", "c"),
            remove_key("opacity", "a"),
        ],
    );
    keep["preserveAtPlayhead"] = json!(false);
    call(&r, REMOVE, keep).await;
    assert_eq!(
        read(&r).await.pointer(TARGET).unwrap()["params"],
        before.pointer(TARGET).unwrap()["params"]
    );
}
fn channel() -> Value {
    json!({"customChannel":"keep", "extrapolation":{"before":"hold","after":"linear"},"keys":[
        {"id":"a","time":0,"value":0,"segmentToNext":"bezier","tangentMode":"broken","customKey":"keep","rightHandle":{"dt":80,"dv":0.5}},
        {"id":"b","time":100,"value":1,"segmentToNext":"linear","leftHandle":{"dt":-80,"dv":-0.5},"rightHandle":{"dt":500,"dv":1}},
        {"id":"c","time":200,"value":2,"segmentToNext":"linear","leftHandle":{"dt":-500,"dv":-1}}
    ]})
}
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
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"] = json!({
        "opacity":channel(), "params.future":{"x":channel(),"y":channel()},
        "effects.future.params.mode":{"keys":[{"id":"a","time":0,"value":"off"},{"id":"b","time":100,"value":"on"}]},
        "opaqueMetadata":{"keep":[1,2,3]}
    });
    call(
        &r,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}

#[tokio::test]
async fn invalid_sample_cannot_commit_earlier_removals() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let mut state = read(&r).await;
    // Simulate an old saved select value no longer in the product definition.
    let mut classic = state["project"]["classic"].clone();
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"]["mode"] =
        json!({"keys":[{"id":"old","time":0,"value":"removed-option"}]});
    call(&r, "project.classic.attach", json!({"projectId":"classic-project","expectedRevision":state["revision"],"classic":classic})).await;
    state = read(&r).await;
    let input = remove_request(
        &state,
        &catalog,
        vec![
            remove_key("opacity", "a"),
            remove_key("opacity", "b"),
            remove_key("opacity", "c"),
            remove_key("mode", "old"),
        ],
    );
    assert!(
        r.registry()
            .invoke(REMOVE, InvocationContext::default(), input)
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, state);
}
fn edit(path: &str, id: &str, change: Value) -> Value {
    json!({"trackId":"video-track","elementId":"item-2","propertyPath":path,"keyframeId":id,"change":change})
}
fn request(state: &Value, edits: Vec<Value>) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"edits":edits})
}
fn animations(state: &Value) -> &Value {
    &state.pointer(TARGET).unwrap()["animations"]
}

fn authoring_catalog(r: &OpenCutRuntime) -> String {
    let scalar = json!({"kind":"leaf","codec":"identity","easingMode":"independent","component":{"key":"value","valueKind":"scalar","defaultInterpolation":"linear"}});
    let discrete = json!({"kind":"leaf","codec":"identity","easingMode":"independent","component":{"key":"value","valueKind":"discrete","defaultInterpolation":"hold"}});
    let components = ["r", "g", "b", "a"]
        .map(|key| json!({"key":key,"valueKind":"scalar","defaultInterpolation":"linear"}));
    let color = json!({"kind":"composite","codec":"linearRgba","easingMode":"shared","components":components});
    r.classic_animation_catalog().replace(serde_json::from_value(json!([{
        "target":{"kind":"element","elementType":"video","pathPrefix":""},
        "params":[
            {"key":"opacity","label":"Opacity","type":"number","default":1,"min":0,"max":1,"step":0.1,"channelLayout":scalar},
            {"key":"color","label":"Color","type":"color","default":"white","channelLayout":color},
            {"key":"mode","label":"Mode","type":"select","default":"on","options":[{"value":"on","label":"On"},{"value":"off","label":"Off"}],"channelLayout":discrete},
            {"key":"enabled","label":"Enabled","type":"boolean","default":true,"channelLayout":discrete}
        ]
    }])).unwrap()).unwrap()
}
fn upsert(path: &str, value: Value, time: i64) -> Value {
    json!({"trackId":"video-track","elementId":"item-2","propertyPath":path,"value":value,"time":time})
}
fn upsert_request(state: &Value, catalog: &str, keyframes: Vec<Value>) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"catalogRevision":catalog,"keyframes":keyframes})
}

#[tokio::test]
async fn keyframe_authoring_preserves_values_curves_identity_and_atomic_reopened_history() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let mut edit = upsert("opacity", json!(0.62), 100);
    edit["interpolation"] = json!("bezier");
    let input = upsert_request(
        &before,
        &catalog,
        vec![
            edit,
            upsert("color", json!("#80402080"), -20),
            upsert("mode", json!("on"), 50),
            upsert("enabled", json!(false), 50),
        ],
    );
    let dry = r
        .registry()
        .invoke(
            UPSERT,
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
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("create-keys"));
    let receipt = r
        .registry()
        .invoke(UPSERT, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(receipt.result.data["keyframes"], dry["keyframes"]);
    assert_eq!(
        r.registry().invoke(UPSERT, context, input).await.unwrap(),
        receipt
    );
    let after = read(&r).await;
    let a = animations(&after);
    assert_eq!(a["opacity"]["keys"][1]["id"], "b");
    assert_eq!(a["opacity"]["keys"][1]["value"], 0.6);
    assert_eq!(a["opacity"]["keys"][1]["segmentToNext"], "bezier");
    assert_eq!(a["opacity"]["keys"][1]["leftHandle"]["dv"], -0.5);
    for component in ["r", "g", "b", "a"] {
        assert_eq!(
            a["color"][component]["keys"][0]["id"],
            dry["keyframes"][1]["keyframeId"]
        );
        assert_eq!(a["color"][component]["keys"][0]["time"], 0);
    }
    assert_eq!(a["color"]["a"]["keys"][0]["value"], 128.0 / 255.0);
    assert_eq!(a["mode"]["keys"][0]["value"], "on");
    assert_eq!(a["enabled"]["keys"][0]["value"], false);
    let mut expected = before["project"].clone();
    expected["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"] =
        a.clone();
    assert_eq!(after["project"], expected);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(read(&reopened).await["project"], after["project"]);
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], before["project"]);
}

#[tokio::test]
async fn invalid_authoring_rolls_back_earlier_keys_and_allocation_and_checks_catalog_scope() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    for invalid in [
        upsert("mode", json!("wrong"), 1),
        upsert("opacity", json!("wrong"), 1),
        upsert("color", json!("not-a-color"), 1),
        upsert("color", json!("color-mix(in srgb, red, blue)"), 1),
        upsert("unknown", json!(1), 1),
        upsert("enabled", json!(1), 1),
        upsert("opacity", json!(1), 9007199254740992_i64),
    ] {
        let input = upsert_request(
            &before,
            &catalog,
            vec![upsert("color", json!("red"), 50), invalid],
        );
        assert!(
            r.registry()
                .invoke(UPSERT, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    for (key, value) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("expectedRevision", json!(9999)),
        ("catalogRevision", json!("stale")),
    ] {
        let mut input = upsert_request(&before, &catalog, vec![upsert("color", json!("red"), 0)]);
        input[key] = value;
        assert!(
            r.registry()
                .invoke(UPSERT, InvocationContext::default(), input)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        r.registry()
            .invoke(
                UPSERT,
                context,
                upsert_request(&before, &catalog, vec![upsert("color", json!("red"), 0)])
            )
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
}

#[tokio::test]
async fn keyframe_authoring_reuses_exact_times_and_prioritizes_requested_ids() {
    let r = setup().await;
    let catalog = authoring_catalog(&r);
    let before = read(&r).await;
    let mut update = upsert("opacity", json!(0.4), 150);
    update["keyframeId"] = json!("b");
    call(
        &r,
        UPSERT,
        upsert_request(
            &before,
            &catalog,
            vec![
                update,
                upsert("opacity", json!(0.8), 150),
                upsert("color", json!("red"), 0),
                upsert("color", json!("blue"), 0),
            ],
        ),
    )
    .await;
    let state = read(&r).await;
    let a = animations(&state);
    assert_eq!(a["opacity"]["keys"].as_array().unwrap().len(), 3);
    assert_eq!(a["opacity"]["keys"][1]["id"], "b");
    assert_eq!(a["opacity"]["keys"][1]["time"], 150);
    assert_eq!(a["opacity"]["keys"][1]["value"], 0.8);
    for c in ["r", "g", "b", "a"] {
        assert_eq!(a["color"][c]["keys"].as_array().unwrap().len(), 1);
    }
    assert_eq!(a["color"]["b"]["keys"][0]["value"], 1.0);

    // Explicit IDs introduced after the first allocation must enter the same
    // batch's collision set before its next generated identity.
    let counter = state["nextId"].as_u64().unwrap();
    let mut explicit = upsert("mode", json!("on"), 20);
    explicit["keyframeId"] = json!(format!("classic-keyframe-{}", counter + 1));
    let result = call(
        &r,
        UPSERT,
        upsert_request(
            &state,
            &catalog,
            vec![
                upsert("enabled", json!(true), 20),
                explicit,
                upsert("color", json!("green"), 30),
            ],
        ),
    )
    .await;
    let ids: std::collections::HashSet<_> = result["keyframes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["keyframeId"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(format!("classic-keyframe-{}", counter + 2).as_str()));
}

#[tokio::test]
async fn batch_retime_and_curves_preserve_project_and_share_atomic_history() {
    let r = setup().await;
    let before = read(&r).await;
    let input = request(
        &before,
        vec![
            edit("opacity", "b", json!({"type":"retime","time":50})),
            edit("params.future", "b", json!({"type":"retime","time":300})),
            edit(
                "opacity",
                "b",
                json!({"type":"curve","componentKey":"value","patch":{"leftHandle":null,"rightHandle":{"dt":1000,"dv":2},"segmentToNext":"bezier","tangentMode":"aligned"}}),
            ),
            edit(
                "effects.future.params.mode",
                "b",
                json!({"type":"retime","time":-100}),
            ),
        ],
    );
    r.registry()
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
        .insert("opencut/idempotencyKey".into(), json!("batch-keys"));
    let result = r
        .registry()
        .invoke(EDIT, context.clone(), input.clone())
        .await
        .unwrap();
    let after = read(&r).await;
    assert_eq!(
        r.registry().invoke(EDIT, context, input).await.unwrap(),
        result
    );
    assert_eq!(read(&r).await, after);
    let a = animations(&after);
    assert_eq!(a["opacity"]["keys"][0]["rightHandle"]["dt"], 50);
    assert!(a["opacity"]["keys"][1].get("leftHandle").is_none());
    assert_eq!(a["opacity"]["keys"][1]["rightHandle"]["dt"], 150);
    assert_eq!(a["opacity"]["keys"][1]["segmentToNext"], "bezier");
    assert_eq!(a["opacity"]["customChannel"], "keep");
    for component in ["x", "y"] {
        assert_eq!(a["params.future"][component]["keys"][2]["id"], "b");
    }
    assert_eq!(a["effects.future.params.mode"]["keys"][1]["time"], 0);
    let mut expected = before["project"].clone();
    expected["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"] =
        a.clone();
    assert_eq!(after["project"], expected);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(read(&reopened).await["project"], after["project"]);
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], before["project"]);
}

#[tokio::test]
async fn invalid_batch_scope_time_shape_or_curve_cannot_partially_commit() {
    let r = setup().await;
    let before = read(&r).await;
    let valid = edit("opacity", "b", json!({"type":"retime","time":50}));
    for invalid in [
        edit("opacity", "missing", json!({"type":"retime","time":10})),
        edit("opacity", "b", json!({"type":"retime","time":0.5})),
        edit(
            "opacity",
            "b",
            json!({"type":"retime","time":9007199254740992_i64}),
        ),
        edit(
            "effects.future.params.mode",
            "b",
            json!({"type":"curve","componentKey":"value","patch":{"segmentToNext":"bezier"}}),
        ),
        edit(
            "opacity",
            "b",
            json!({"type":"curve","componentKey":"x","patch":{}}),
        ),
        edit(
            "opacity",
            "b",
            json!({"type":"curve","componentKey":"value","patch":{"leftHandle":{"dt":0.5,"dv":1}}}),
        ),
        edit(
            "params.future",
            "b",
            json!({"type":"curve","componentKey":"x","patch":{"segmentToNext":"wrong"}}),
        ),
        edit("missing", "b", json!({"type":"retime","time":10})),
    ] {
        assert!(
            r.registry()
                .invoke(
                    EDIT,
                    InvocationContext::default(),
                    request(&before, vec![valid.clone(), invalid])
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    for (field, value) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("expectedRevision", json!(0)),
    ] {
        let mut input = request(&before, vec![valid.clone()]);
        input[field] = value;
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
            .invoke(EDIT, context, request(&before, vec![valid]))
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
}

#[tokio::test]
async fn component_curve_updates_and_boundary_clamps_retain_other_components() {
    let r = setup().await;
    let before = read(&r).await;
    let duration = before.pointer(TARGET).unwrap()["duration"]
        .as_i64()
        .unwrap();
    call(&r,EDIT,request(&before,vec![
        edit("params.future","b",json!({"type":"curve","componentKey":"y","patch":{"leftHandle":{"dt":-1000,"dv":3},"rightHandle":null,"tangentMode":"broken"}})),
        edit("opacity","b",json!({"type":"retime","time":duration+100})),
    ])).await;
    let after = read(&r).await;
    assert_eq!(
        animations(&after)["params.future"]["x"],
        animations(&before)["params.future"]["x"]
    );
    assert_eq!(
        animations(&after)["params.future"]["y"]["keys"][1]["leftHandle"]["dt"],
        -100
    );
    assert!(
        animations(&after)["params.future"]["y"]["keys"][1]
            .get("rightHandle")
            .is_none()
    );
    assert_eq!(animations(&after)["opacity"]["keys"][2]["time"], duration);
}
