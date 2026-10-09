use opencut_editor_api::{AccessLevel, HyperframesSource, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}

async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}

fn source() -> HyperframesSource {
    serde_json::from_value(json!({
        "entryFile":"index.html",
        "files":{
            "index.html":"<!doctype html><div data-composition-id=\"main\" data-width=\"320\" data-height=\"180\" data-duration=\"4\"><div id=\"paint\">Original</div></div>",
            "motion.js":"// Original animation\r\n",
            "unused.css":"/* old */"
        }
    })).unwrap()
}

fn manifest(source: &HyperframesSource) -> Value {
    json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115","durationSeconds":4,"layers":[{"key":"dom/1/0/0","parentKey":null,"file":"index.html","elementId":"paint","label":"Paint","kind":"element","startSeconds":0,"durationSeconds":4,"trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null}],"diagnostics":[]})
}

async fn fixture() -> (OpenCutRuntime, Value, Value, HyperframesSource) {
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
    let source = source();
    let imported = call(&runtime,"timeline.hyperframes.import",json!({"projectId":"classic-project","expectedRevision":1,"name":"Source edit","importId":"source-import","source":source,"runtimeManifest":manifest(&source)})).await;
    (runtime, scene, imported, source)
}

#[tokio::test]
async fn preparation_preserves_untouched_bytes_and_resource_bindings_and_bounds_changes() {
    let runtime = OpenCutRuntime::default();
    let mut source = source();
    source
        .resource_asset_ids
        .insert("font.woff2".into(), "font-asset".into());
    let changes = json!({"motion.js":"// שלום\r\n","new.css":"body{color:red}","unused.css":null});
    let prepared = call(
        &runtime,
        "hyperframes.source.prepare",
        json!({"source":source,"changes":changes}),
    )
    .await;
    assert_eq!(prepared["sourceFingerprint"], source.fingerprint());
    assert_eq!(
        prepared["source"]["resourceAssetIds"]["font.woff2"],
        "font-asset"
    );
    assert_eq!(
        prepared["source"]["files"]["index.html"],
        source.files["index.html"]
    );
    assert_eq!(prepared["source"]["files"]["motion.js"], "// שלום\r\n");
    assert_eq!(prepared["source"]["files"]["new.css"], "body{color:red}");
    assert!(prepared["source"]["files"].get("unused.css").is_none());
    for changes in [
        json!({}),
        json!({"../escape.js":""}),
        json!({"index.html":null}),
        json!({"missing.js":null}),
        json!({"font.woff2":"text"}),
        json!({"index.html":"no composition"}),
        json!({"large.js":"x".repeat(16*1024*1024)}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.source.prepare",
                    InvocationContext::default(),
                    json!({"source":source,"changes":changes})
                )
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn source_edit_detaches_one_occurrence_updates_geometry_and_supports_history_and_idempotency()
{
    let (runtime, scene, imported, source) = fixture().await;
    let other = call(&runtime,"timeline.hyperframes.insert",json!({"projectId":"classic-project","sceneId":scene,"expectedRevision":2,"assetId":imported["assetId"],"name":"Other","startSeconds":0})).await;
    call(&runtime,"hyperframes.layer.opacity.set",json!({"projectId":"classic-project","sceneId":scene,"expectedRevision":3,"elementId":imported["itemId"],"layerKey":"dom/1/0/0","opacity":0.5})).await;
    let before = read(&runtime).await;
    let changes = json!({"index.html":source.files["index.html"].replace("320","640").replace("Original","שלום"),"motion.js":"// New motion"});
    let prepared = call(
        &runtime,
        "hyperframes.source.prepare",
        json!({"source":source,"changes":changes}),
    )
    .await;
    let updated: HyperframesSource = serde_json::from_value(prepared["source"].clone()).unwrap();
    let input = json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":before["revision"],"sourceFingerprint":prepared["sourceFingerprint"],"changes":changes,"manifest":manifest(&updated)});
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.source.set")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.transactional && descriptor.cancellable && descriptor.supports_dry_run);
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("edit-source-once"));
    runtime
        .registry()
        .invoke("hyperframes.source.set", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let result = runtime
        .registry()
        .invoke("hyperframes.source.set", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        runtime
            .registry()
            .invoke("hyperframes.source.set", context, input)
            .await
            .unwrap()
    );
    let after = read(&runtime).await;
    let doc = &after["project"]["classic"]["document"];
    let compositions = &doc["hyperframesCompositions"];
    let changed = compositions
        .as_object()
        .unwrap()
        .values()
        .find(|c| c["width"] == 640)
        .unwrap();
    assert_eq!(
        changed["source"]["files"]["index.html"],
        changes["index.html"]
    );
    assert_eq!(
        changed["source"]["files"]["unused.css"],
        source.files["unused.css"]
    );
    assert!(changed.get("importId").is_none());
    assert_eq!(
        compositions[imported["assetId"].as_str().unwrap()],
        before["project"]["classic"]["document"]["hyperframesCompositions"]
            [imported["assetId"].as_str().unwrap()]
    );
    let projection=call(&runtime,"hyperframes.layers.timeline.read",json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":after["revision"]})).await;
    assert_eq!(projection["clip"]["controls"][0]["opacity"], 0.5);
    let scene_document = doc["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == scene)
        .unwrap();
    let clip = scene_document["tracks"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|track| track["elements"].as_array().unwrap())
        .find(|item| item["id"] == imported["itemId"])
        .unwrap();
    assert_eq!(clip["params"]["sourceWidth"], 640);
    assert_eq!(clip["params"]["sourceHeight"], 180);
    let library = call(
        &runtime,
        "hyperframes.library.read",
        json!({"projectId":"classic-project","expectedRevision":after["revision"]}),
    )
    .await;
    assert!(library["items"].as_array().unwrap().iter().any(|item| {
        item["assetId"] == imported["assetId"]
            && item["occurrences"]
                .as_array()
                .unwrap()
                .iter()
                .any(|occurrence| occurrence["elementId"] == other["itemId"])
    }));
    for (original, current) in before["project"]["classic"]["document"]["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .zip(doc["scenes"].as_array().unwrap())
    {
        assert_eq!(original["tracks"]["main"], current["tracks"]["main"]);
        assert_eq!(original["tracks"]["audio"], current["tracks"]["audio"]);
    }
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn stale_missing_locked_cancelled_short_or_incompatible_source_edits_are_atomic() {
    let (runtime, scene, imported, source) = fixture().await;
    call(&runtime,"hyperframes.layer.opacity.set",json!({"projectId":"classic-project","sceneId":scene,"expectedRevision":2,"elementId":imported["itemId"],"layerKey":"dom/1/0/0","opacity":0.5})).await;
    let before = read(&runtime).await;
    let changes = json!({"motion.js":"// edit"});
    let prepared = call(
        &runtime,
        "hyperframes.source.prepare",
        json!({"source":source,"changes":changes}),
    )
    .await;
    let updated: HyperframesSource = serde_json::from_value(prepared["source"].clone()).unwrap();
    let input = json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":before["revision"],"sourceFingerprint":source.fingerprint(),"changes":changes,"manifest":manifest(&updated)});
    let mut short = manifest(&updated);
    short["durationSeconds"] = json!(1);
    short["layers"][0]["durationSeconds"] = json!(1);
    let mut structure = manifest(&updated);
    structure["layers"][0]["elementId"] = json!("new-id");
    for (key, value) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("elementId", json!("wrong")),
        ("expectedRevision", json!(0)),
        ("sourceFingerprint", json!("old")),
        ("manifest", manifest(&source)),
        ("manifest", short),
        ("manifest", structure),
    ] {
        let mut bad = input.clone();
        bad[key] = value;
        assert!(
            runtime
                .registry()
                .invoke("hyperframes.source.set", InvocationContext::default(), bad)
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.source.set", cancelled, input.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    let mut locked = before["project"]["classic"].clone();
    locked["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == scene)
        .unwrap()["tracks"]["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["id"] == imported["trackId"])
        .unwrap()["locked"] = json!(true);
    call(&runtime,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":before["revision"],"classic":locked})).await;
    let locked = read(&runtime).await;
    let mut input = input;
    input["expectedRevision"] = locked["revision"].clone();
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.source.set",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, locked);
}
