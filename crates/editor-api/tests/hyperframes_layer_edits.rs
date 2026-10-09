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
async fn setup() -> (OpenCutRuntime, Value, Value, String) {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let source: HyperframesSource = serde_json::from_value(json!({"entryFile":"index.html","files":{"index.html":"<div data-composition-id='main' data-duration='6'></div>"},"resourceAssetIds":{}})).unwrap();
    let layer = |key: &str, kind: &str| json!({"key":key,"parentKey":null,"file":"index.html","elementId":"reused-id","label":key,"kind":kind,"startSeconds":0,"durationSeconds":6,"trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null});
    let manifest = json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115","durationSeconds":6,"layers":[layer("dom/1/0/0","element"),layer("dom/1/0/1","element"),layer("manifest/2","element"),layer("dom/1/0/2","audio")],"diagnostics":[]});
    let imported = call(&runtime,"timeline.hyperframes.import",json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"name":"Compound","source":source,"runtimeManifest":manifest})).await;
    let state = read(&runtime).await;
    let mut classic = state["project"]["classic"].clone();
    let scene_id = classic["document"]["currentSceneId"]
        .as_str()
        .unwrap()
        .to_owned();
    let scene = classic["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == scene_id)
        .unwrap();
    let track = scene["tracks"]["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["id"] == imported["trackId"])
        .unwrap();
    let mut duplicate = track["elements"][0].clone();
    duplicate["id"] = json!("duplicate-compound");
    track["elements"].as_array_mut().unwrap().push(duplicate);
    call(&runtime,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":state["revision"],"classic":classic})).await;
    (runtime, imported, manifest, scene_id)
}
fn element<'a>(state: &'a Value, id: &str) -> &'a Value {
    state["project"]["classic"]["document"]["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["tracks"]["overlay"].as_array().unwrap())
        .flat_map(|t| t["elements"].as_array().unwrap())
        .find(|e| e["id"] == id)
        .unwrap()
}
#[tokio::test]
async fn edits_are_scoped_undoable_idempotent_and_preserve_source_animation() {
    let (runtime, imported, manifest, scene_id) = setup().await;
    let before = read(&runtime).await;
    let id = imported["itemId"].as_str().unwrap();
    let input = json!({"projectId":"classic-project","sceneId":scene_id,"elementId":id,"layerKey":"dom/1/0/0","opacity":0.5,"expectedRevision":before["revision"]});
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.layer.opacity.set")
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
        .insert("opencut/idempotencyKey".into(), json!("layer-once"));
    let preview = runtime
        .registry()
        .invoke(
            "hyperframes.layer.opacity.set",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(preview.result.data["committed"], false);
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let commit = runtime
        .registry()
        .invoke(
            "hyperframes.layer.opacity.set",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    let retry = runtime
        .registry()
        .invoke("hyperframes.layer.opacity.set", context, input.clone())
        .await
        .unwrap();
    assert_eq!(commit, retry);
    let after = read(&runtime).await;
    assert_eq!(
        after["revision"].as_u64().unwrap(),
        before["revision"].as_u64().unwrap() + 1
    );
    assert_eq!(
        element(&after, id)["hyperframesLayerEdits"]["opacity"],
        json!({"dom/1/0/0":0.5})
    );
    assert_eq!(
        element(&after, "duplicate-compound"),
        element(&before, "duplicate-compound")
    );
    assert_eq!(
        after["project"]["classic"]["document"]["hyperframesCompositions"],
        before["project"]["classic"]["document"]["hyperframesCompositions"]
    );
    let source = after["project"]["classic"]["document"]["hyperframesCompositions"]
        [imported["assetId"].as_str().unwrap()]["source"]
        .clone();
    let prepared = call(&runtime,"hyperframes.layers.render.prepare",json!({"source":source,"manifest":manifest,"edits":element(&after,id)["hyperframesLayerEdits"]})).await;
    assert_eq!(
        prepared["layers"],
        json!([{"key":"dom/1/0/0","elementId":"reused-id","opacity":0.5}])
    );
    let rows = call(&runtime,"hyperframes.layers.timeline.read",json!({"projectId":"classic-project","sceneId":scene_id,"elementId":id,"expectedRevision":after["revision"]})).await;
    assert_eq!(
        rows["clip"]["controls"][0],
        json!({"key":"dom/1/0/0","editable":true,"opacity":0.5})
    );
    assert_eq!(rows["clip"]["controls"][2]["editable"], false);
    assert_eq!(rows["clip"]["controls"][3]["editable"], false);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
    let mut reset = input;
    reset["expectedRevision"] = json!(runtime.snapshot().unwrap().revision);
    reset["opacity"] = json!(1);
    call(&runtime, "hyperframes.layer.opacity.set", reset).await;
    assert!(
        element(&read(&runtime).await, id)
            .get("hyperframesLayerEdits")
            .is_none()
    );
}
#[tokio::test]
async fn rejects_invalid_targets_values_locks_and_stale_runtime_identity_atomically() {
    let (runtime, imported, _, scene_id) = setup().await;
    let before = read(&runtime).await;
    let input = json!({"projectId":"classic-project","sceneId":scene_id,"elementId":imported["itemId"],"layerKey":"dom/1/0/0","opacity":0,"expectedRevision":before["revision"]});
    for (key, value) in [
        ("projectId", json!("missing")),
        ("sceneId", json!("missing")),
        ("elementId", json!("missing")),
        ("layerKey", json!("manifest/2")),
        ("layerKey", json!("dom/1/0/2")),
        ("layerKey", json!("dom/1/99")),
        ("opacity", json!(-0.1)),
        ("opacity", json!(1.1)),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = input.clone();
        invalid[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.layer.opacity.set",
                    InvocationContext::default(),
                    invalid
                )
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
            .invoke("hyperframes.layer.opacity.set", cancelled, input.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(&runtime, "hyperframes.layer.opacity.set", input.clone()).await;
    let edited = read(&runtime).await;
    for variant in ["fingerprint", "manifest", "value", "ordinary"] {
        let mut classic = edited["project"]["classic"].clone();
        let scene = classic["document"]["scenes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["id"] == scene_id)
            .unwrap();
        let track = scene["tracks"]["overlay"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| t["id"] == imported["trackId"])
            .unwrap();
        let element = &mut track["elements"][0];
        match variant {
            "fingerprint" => {
                element["hyperframesLayerEdits"]["sourceFingerprint"] = json!("different")
            }
            "value" => element["hyperframesLayerEdits"]["opacity"]["dom/1/0/0"] = json!(2),
            "ordinary" => element["definitionId"] = json!("rectangle"),
            _ => {
                classic["document"]["hyperframesCompositions"]
                    [imported["assetId"].as_str().unwrap()]["runtimeManifest"]["layers"][0]["elementId"] =
                    json!("reordered");
            }
        }
        assert!(runtime.registry().invoke("project.classic.commit",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":edited["revision"],"classic":classic})).await.is_err());
        assert_eq!(read(&runtime).await, edited);
    }
    let mut classic = edited["project"]["classic"].clone();
    let scene = classic["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == scene_id)
        .unwrap();
    scene["tracks"]["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["id"] == imported["trackId"])
        .unwrap()["locked"] = json!(true);
    call(&runtime,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":edited["revision"],"classic":classic})).await;
    let locked = read(&runtime).await;
    let mut input = input;
    input["expectedRevision"] = locked["revision"].clone();
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.layer.opacity.set",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, locked);
}
