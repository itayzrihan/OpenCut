use opencut_editor_api::{
    HyperframesLayerKind, HyperframesLayerMoveStrategy, HyperframesLayerMoveTiming,
    HyperframesRuntimeManifest, HyperframesSource, InvocationContext, OpenCutRuntime,
    plan_hyperframes_layer_move, prepare_hyperframes_layer_move,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn source() -> HyperframesSource {
    serde_json::from_value(json!({"entryFile":"index.html","files":{
        "index.html":"<!doctype html><div data-composition-id=main data-width=320 data-height=180 data-duration=10>\r\n<!-- שלום 😀 --><div id='paint' data-start='1' data-duration='2' data-end='3' title='1 > 0'></div><div id='other' data-start=0 data-duration=10></div></div><script>const tl=gsap.timeline({paused:true});tl.to('#paint',{x:100,duration:2},1);</script><script src='motion.js'></script>",
        "motion.js":"// external source\r\n"
    }})).unwrap()
}

fn grouped_source() -> (HyperframesSource, HyperframesRuntimeManifest) {
    let mut source = source();
    let insertion = source.files["index.html"]
        .find("title='1 > 0'></div>")
        .unwrap()
        + "title='1 > 0'>".len();
    source
        .files
        .get_mut("index.html")
        .unwrap()
        .insert_str(insertion, "<img id='photo'>");
    let mut manifest = manifest(&source);
    let mut image = manifest.layers[1].clone();
    image.key = "dom/1/0/0/0".into();
    image.parent_key = Some("dom/1/0/0".into());
    image.element_id = Some("photo".into());
    image.kind = HyperframesLayerKind::Image;
    manifest.layers.push(image);
    (source, manifest)
}

#[test]
fn runtime_groups_preserve_untimed_images_and_reject_independent_clocks() {
    let (source, manifest) = grouped_source();
    let timing = HyperframesLayerMoveTiming {
        start_seconds: 3.123456,
        strategy: HyperframesLayerMoveStrategy::Auto,
    };
    let plan = plan_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", timing).unwrap();
    assert!(!plan.generated);
    assert_eq!(plan.strategy, HyperframesLayerMoveStrategy::Runtime);
    assert!(plan.html.starts_with(&source.files["index.html"]));
    assert_eq!(plan.local_end_seconds, Some(5.123456));
    assert!(
        plan_hyperframes_layer_move(
            &source,
            &manifest,
            "dom/1/0/0",
            HyperframesLayerMoveTiming {
                strategy: HyperframesLayerMoveStrategy::Source,
                ..timing
            }
        )
        .is_err()
    );
    for child in [
        "<img id='photo' data-start='0'>",
        "<img id='photo' data-end='5'>",
        "<video id='photo'></video>",
        "<canvas id='photo'></canvas>",
        "<iframe id='photo'></iframe>",
        "<div id='photo' data-composition-src='child.html'></div>",
    ] {
        let mut nested = source.clone();
        nested
            .files
            .get_mut("index.html")
            .unwrap()
            .clone_from(&source.files["index.html"].replace("<img id='photo'>", child));
        let mut current = manifest.clone();
        current.source_fingerprint = nested.fingerprint();
        assert!(
            plan_hyperframes_layer_move(&nested, &current, "dom/1/0/0", timing).is_err(),
            "{child}"
        );
    }
    for (start, duration) in [(1.0, 10.0), (0.0, 2.0)] {
        let mut current = manifest.clone();
        current.layers[2].start_seconds = start;
        current.layers[2].duration_seconds = duration;
        assert!(plan_hyperframes_layer_move(&source, &current, "dom/1/0/0", timing).is_err());
    }
}

fn manifest(source: &HyperframesSource) -> HyperframesRuntimeManifest {
    serde_json::from_value(json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115","durationSeconds":10,
        "layers":[
            {"key":"dom/1/0/0","parentKey":null,"file":"index.html","elementId":"paint","label":"paint","kind":"element","startSeconds":1,"durationSeconds":2,"trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null},
            {"key":"dom/1/0/1","parentKey":null,"file":"index.html","elementId":"other","label":"other","kind":"element","startSeconds":0,"durationSeconds":10,"trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null}
        ]})).unwrap()
}

fn compiled(plan: &opencut_editor_api::HyperframesLayerMovePlan) -> BTreeMap<String, String> {
    plan.scripts
        .iter()
        .map(|script| {
            (
                script.key.clone(),
                script.content.replace("duration:2},1)", "duration:2},3)"),
            )
        })
        .collect()
}

async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}

#[test]
fn source_planning_preserves_unrelated_bytes_and_rejects_partial_or_shared_compiler_results() {
    let source = source();
    let original = source.clone();
    let manifest = manifest(&source);
    let plan = plan_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", 3.0).unwrap();
    assert_eq!(plan.delta_seconds, 2.0);
    assert!(plan.html.contains("<!-- שלום 😀 -->"));
    assert!(plan.html.contains("data-start=\"3\""));
    assert!(plan.html.contains("data-end=\"5\""));
    assert_eq!(plan.scripts.len(), 2);
    let scripts = compiled(&plan);
    let prepared =
        prepare_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", 3.0, &scripts).unwrap();
    assert!(prepared.files["index.html"].contains("duration:2},3)"));
    assert_eq!(prepared.files["motion.js"], source.files["motion.js"]);
    assert_eq!(source, original);
    assert!(
        prepare_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", 3.0, &BTreeMap::new())
            .is_err()
    );
    let mut shared = source.clone();
    shared.files.insert(
        "other.html".into(),
        "<script src=motion.js></script>".into(),
    );
    let mut shared_manifest = manifest.clone();
    shared_manifest.source_fingerprint = shared.fingerprint();
    let shared_plan =
        plan_hyperframes_layer_move(&shared, &shared_manifest, "dom/1/0/0", 3.0).unwrap();
    let mut changed = compiled(&shared_plan);
    changed.insert("motion.js".into(), "// changed shared script".into());
    assert!(
        prepare_hyperframes_layer_move(&shared, &shared_manifest, "dom/1/0/0", 3.0, &changed)
            .is_err()
    );
    for start in [-1.0, 9.0, f64::NAN, 3.000001] {
        assert!(plan_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", start).is_err());
    }
    let mut grouped = manifest.clone();
    grouped.layers[1].parent_key = Some("dom/1/0/0".into());
    assert!(plan_hyperframes_layer_move(&source, &grouped, "dom/1/0/0", 3.0).is_err());
}

#[test]
fn source_planning_handles_script_eof_and_declines_unowned_clocks() {
    let mut source = source();
    source
        .files
        .get_mut("index.html")
        .unwrap()
        .push_str("<script type='text/ecmascript'>const extra = 1;");
    let plan = plan_hyperframes_layer_move(&source, &manifest(&source), "dom/1/0/0", 3.0).unwrap();
    assert_eq!(plan.scripts.last().unwrap().content, "const extra = 1;");
    let original = source.clone();
    for prefix in [
        "<template data-composition-id='nested'>",
        "<div data-composition-id='nested' data-duration='10'>",
    ] {
        let mut nested = original.clone();
        nested
            .files
            .get_mut("index.html")
            .unwrap()
            .insert_str(0, prefix);
        assert!(
            plan_hyperframes_layer_move(&nested, &manifest(&nested), "dom/1/0/0", 3.0).is_err()
        );
    }
    let mut svg = original.clone();
    svg.files.insert("index.html".into(), "<div data-composition-id='main' data-duration='10'><svg><g id='paint' data-start='1' data-duration='2'><animate attributeName='opacity' from='0' to='1' dur='2s'/></g></svg></div>".into());
    assert!(plan_hyperframes_layer_move(&svg, &manifest(&svg), "dom/1/0/0", 3.0).is_err());
}

#[test]
fn generated_layer_plan_uses_a_tail_slot_and_rejects_ambiguous_or_async_sources() {
    let mut source = source();
    source.files.insert("index.html".into(), "<!doctype html><html><body><div data-composition-id=main data-width=320 data-height=180 data-duration=10></div><script src='motion.js'></script><!-- שלום --></body></html>".into());
    source.files.insert(
        "motion.js".into(),
        "const tl=gsap.timeline({paused:true});/* generated DOM */".into(),
    );
    let manifest = manifest(&source);
    let plan = plan_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", 3.0).unwrap();
    assert!(plan.generated);
    assert_eq!(plan.delta_seconds, 2.0);
    assert_eq!(plan.scripts.len(), 2);
    assert_eq!(plan.scripts[0].content, source.files["motion.js"]);
    assert!(!plan.scripts[0].runtime_library);
    assert!(plan.scripts[1].content.is_empty());
    assert!(
        plan.html
            .contains("<!-- שלום --><script data-opencut-generated-layer-move></script></body>")
    );
    let mut scripts = compiled(&plan);
    scripts.insert(
        plan.scripts[1].key.clone(),
        "/* checked runtime move */".into(),
    );
    let next =
        prepare_hyperframes_layer_move(&source, &manifest, "dom/1/0/0", 3.0, &scripts).unwrap();
    assert_eq!(next.files["motion.js"], source.files["motion.js"]);
    assert!(next.files["index.html"].contains("/* checked runtime move */"));
    let mut duplicate = manifest.clone();
    duplicate.layers[1].element_id = duplicate.layers[0].element_id.clone();
    assert!(plan_hyperframes_layer_move(&source, &duplicate, "dom/1/0/0", 3.0).is_err());
    for attribute in ["async", "defer", "type=module"] {
        let mut unsupported = source.clone();
        unsupported
            .files
            .get_mut("index.html")
            .unwrap()
            .replace_range(
                0..0,
                &format!("<script {attribute} src='motion.js'></script>"),
            );
        let mut current = manifest.clone();
        current.source_fingerprint = unsupported.fingerprint();
        assert!(plan_hyperframes_layer_move(&unsupported, &current, "dom/1/0/0", 3.0).is_err());
    }
}

#[tokio::test]
async fn move_is_preflighted_atomic_detached_undoable_dry_run_and_idempotent() {
    verify_move_history(false).await;
    verify_move_history(true).await;
}

async fn verify_move_history(grouped: bool) {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let scene = classic["document"]["currentSceneId"].clone();
    call(
        &runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let (source, old_manifest) = if grouped {
        grouped_source()
    } else {
        let source = source();
        let manifest = manifest(&source);
        (source, manifest)
    };
    let imported=call(&runtime,"timeline.hyperframes.import",json!({"projectId":"classic-project","expectedRevision":1,"name":"Move test","source":source,"runtimeManifest":old_manifest})).await;
    call(&runtime,"timeline.hyperframes.insert",json!({"projectId":"classic-project","sceneId":scene,"expectedRevision":2,"assetId":imported["assetId"],"name":"Other occurrence","startSeconds":0})).await;
    call(&runtime,"hyperframes.layer.opacity.set",json!({"projectId":"classic-project","sceneId":scene,"expectedRevision":3,"elementId":imported["itemId"],"layerKey":"dom/1/0/0","opacity":0.5})).await;
    let before = call(&runtime, "app.state.read", json!({})).await["value"].clone();
    let input =
        json!({"source":source,"manifest":old_manifest,"layerKey":"dom/1/0/0","startSeconds":3});
    let plan: opencut_editor_api::HyperframesLayerMovePlan =
        serde_json::from_value(call(&runtime, "hyperframes.layer.move.plan", input.clone()).await)
            .unwrap();
    let scripts = compiled(&plan);
    let mut preparation = input;
    preparation["scripts"] = json!(scripts);
    let updated: HyperframesSource =
        serde_json::from_value(call(&runtime, "hyperframes.layer.move.prepare", preparation).await)
            .unwrap();
    let mut new_manifest = old_manifest.clone();
    new_manifest.source_fingerprint = updated.fingerprint();
    new_manifest.layers[0].start_seconds = 3.0;
    // Manifest ordering is not identity: preserve opacity across a reordered observation.
    new_manifest.layers.reverse();
    let input = json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":before["revision"],"sourceFingerprint":source.fingerprint(),"layerKey":"dom/1/0/0","startSeconds":3,"scripts":scripts,"manifest":new_manifest});
    for (field, value) in [
        ("projectId", json!("other-project")),
        ("sourceFingerprint", json!("stale")),
        ("expectedRevision", json!(0)),
    ] {
        let mut stale = input.clone();
        stale[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.layer.move",
                    InvocationContext::default(),
                    stale
                )
                .await
                .is_err()
        );
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.layer.move", cancelled, input.clone())
            .await
            .is_err()
    );
    let mut bad = input.clone();
    bad["manifest"]["layers"][0]["startSeconds"] = json!(1);
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.layer.move", InvocationContext::default(), bad)
            .await
            .is_err()
    );
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"],
        before
    );
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("move-once"));
    runtime
        .registry()
        .invoke("hyperframes.layer.move", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"],
        before
    );
    context.dry_run = false;
    let result = runtime
        .registry()
        .invoke("hyperframes.layer.move", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        runtime
            .registry()
            .invoke("hyperframes.layer.move", context, input)
            .await
            .unwrap()
    );
    let after = call(&runtime, "app.state.read", json!({})).await["value"].clone();
    let compositions = &after["project"]["classic"]["document"]["hyperframesCompositions"];
    assert_eq!(
        compositions[imported["assetId"].as_str().unwrap()]["source"],
        serde_json::to_value(&source).unwrap()
    );
    assert!(
        compositions
            .as_object()
            .unwrap()
            .values()
            .any(|c| c["source"] == serde_json::to_value(&updated).unwrap())
    );
    let rows=call(&runtime,"hyperframes.layers.timeline.read",json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":after["revision"]})).await;
    assert!(
        rows["clip"]["controls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|control| control["key"] == "dom/1/0/0" && control["opacity"] == 0.5)
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"]["project"],
        before["project"]
    );
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"]["project"],
        after["project"]
    );
}
