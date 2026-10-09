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
    serde_json::from_value(json!({"entryFile":"index.html","files":{"index.html":include_str!("fixtures/hyperframes-variables.html")},"resourceAssetIds":{}})).unwrap()
}
fn manifest(source: &HyperframesSource) -> Value {
    json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115","durationSeconds":4,"layers":[{"key":"dom/1/0/0","parentKey":null,"file":"index.html","elementId":"paint","label":"Paint","kind":"element","startSeconds":0,"durationSeconds":4,"trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null}],"diagnostics":[]})
}

#[tokio::test]
async fn editing_an_unshared_source_preserves_its_recovery_identity() {
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
    let imported = call(&runtime, "timeline.hyperframes.import", json!({"projectId":"classic-project","expectedRevision":1,"name":"Variables","importId":"recover-after-edit","source":source,"runtimeManifest":manifest(&source)})).await;
    let before = read(&runtime).await;
    let values = json!({"title":"Edited before retention"});
    let prepared: HyperframesSource = serde_json::from_value(
        call(
            &runtime,
            "hyperframes.variables.prepare",
            json!({"source":source,"values":values}),
        )
        .await,
    )
    .unwrap();
    call(&runtime, "hyperframes.variables.set", json!({"projectId":"classic-project","expectedRevision":before["revision"],"sceneId":scene,"elementId":imported["itemId"],"values":values,"manifest":manifest(&prepared)})).await;
    let after = read(&runtime).await;
    let composition = &after["project"]["classic"]["document"]["hyperframesCompositions"]
        [imported["assetId"].as_str().unwrap()];
    assert_eq!(composition["importId"], "recover-after-edit");
    assert_eq!(composition["source"]["variables"], values);
    let library = call(
        &runtime,
        "hyperframes.library.read",
        json!({"projectId":"classic-project","expectedRevision":after["revision"]}),
    )
    .await;
    assert!(
        library["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["importId"] == "recover-after-edit")
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn declared_values_are_bounded_and_do_not_change_legacy_fingerprints() {
    let runtime = OpenCutRuntime::default();
    let source = source();
    let before = serde_json::to_value(&source).unwrap();
    assert!(before.get("variables").is_none());
    let schema = call(
        &runtime,
        "hyperframes.variables.read",
        json!({"source":source}),
    )
    .await;
    assert_eq!(schema["declarations"].as_array().unwrap().len(), 5);
    let values =
        json!({"title":"Updated <title>","accent":"#00ff00","size":80,"show":false,"mode":"right"});
    let updated = call(
        &runtime,
        "hyperframes.variables.prepare",
        json!({"source":source,"values":values}),
    )
    .await;
    assert_eq!(updated["files"], before["files"]);
    assert_eq!(updated["variables"], values);
    let changed: HyperframesSource = serde_json::from_value(updated).unwrap();
    assert_ne!(changed.fingerprint(), source.fingerprint());
    assert_eq!(
        changed
            .with_variables(Default::default())
            .unwrap()
            .fingerprint(),
        source.fingerprint()
    );
    for values in [
        json!({"missing":1}),
        json!({"title":false}),
        json!({"title":"a".repeat(101)}),
        json!({"size":101}),
        json!({"size":19}),
        json!({"show":"false"}),
        json!({"mode":"other"}),
        json!({"__proto__":{}}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.variables.prepare",
                    InvocationContext::default(),
                    json!({"source":source,"values":values})
                )
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn variable_edit_is_independent_preflighted_atomic_and_undoable() {
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
    let imported = call(&runtime,"timeline.hyperframes.import",json!({"projectId":"classic-project","expectedRevision":1,"name":"Variables","importId":"variables-import","source":source,"runtimeManifest":manifest(&source)})).await;
    let mut classic = read(&runtime).await["project"]["classic"].clone();
    let track = classic["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == scene)
        .unwrap()["tracks"]["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["id"] == imported["trackId"])
        .unwrap();
    let mut other = track["elements"][0].clone();
    other["id"] = json!("other");
    track["elements"].as_array_mut().unwrap().push(other);
    call(
        &runtime,
        "project.classic.commit",
        json!({"projectId":"classic-project","expectedRevision":2,"classic":classic}),
    )
    .await;
    call(&runtime,"hyperframes.layer.opacity.set",json!({"projectId":"classic-project","expectedRevision":3,"sceneId":scene,"elementId":imported["itemId"],"layerKey":"dom/1/0/0","opacity":0.5})).await;
    let before = read(&runtime).await;
    let values = json!({"title":"New title","accent":"#00ff00"});
    let prepared: HyperframesSource = serde_json::from_value(
        call(
            &runtime,
            "hyperframes.variables.prepare",
            json!({"source":source,"values":values}),
        )
        .await,
    )
    .unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"sceneId":scene,"elementId":imported["itemId"],"values":values,"manifest":manifest(&prepared)});
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.variables.set")
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
        .insert("opencut/idempotencyKey".into(), json!("variables-once"));
    runtime
        .registry()
        .invoke("hyperframes.variables.set", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let committed = runtime
        .registry()
        .invoke("hyperframes.variables.set", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        committed,
        runtime
            .registry()
            .invoke("hyperframes.variables.set", context, input.clone())
            .await
            .unwrap()
    );
    let after = read(&runtime).await;
    let compositions = &after["project"]["classic"]["document"]["hyperframesCompositions"];
    assert_eq!(
        compositions[imported["assetId"].as_str().unwrap()],
        before["project"]["classic"]["document"]["hyperframesCompositions"]
            [imported["assetId"].as_str().unwrap()]
    );
    let changed = compositions
        .as_object()
        .unwrap()
        .values()
        .find(|c| c["source"]["variables"] == values)
        .unwrap();
    assert_eq!(
        compositions[imported["assetId"].as_str().unwrap()]["importId"],
        "variables-import"
    );
    assert!(changed.get("importId").is_none());
    assert_eq!(
        changed["source"]["files"],
        serde_json::to_value(&source).unwrap()["files"]
    );
    let projection=call(&runtime,"hyperframes.layers.timeline.read",json!({"projectId":"classic-project","sceneId":scene,"elementId":imported["itemId"],"expectedRevision":after["revision"]})).await;
    assert_eq!(projection["clip"]["controls"][0]["opacity"], 0.5);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
    for (key, value) in [
        ("projectId", json!("wrong")),
        ("sceneId", json!("wrong")),
        ("elementId", json!("wrong")),
        ("values", json!({"size":101})),
        ("manifest", manifest(&source)),
    ] {
        let current = read(&runtime).await;
        let mut bad = input.clone();
        bad["expectedRevision"] = current["revision"].clone();
        bad[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.variables.set",
                    InvocationContext::default(),
                    bad
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, current);
    }
    let current = read(&runtime).await;
    let mut fresh = input.clone();
    fresh["expectedRevision"] = current["revision"].clone();
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.variables.set", cancelled, fresh.clone())
            .await
            .is_err()
    );
    for kind in ["short", "structure"] {
        let mut bad = fresh.clone();
        if kind == "short" {
            bad["manifest"]["durationSeconds"] = json!(3);
            bad["manifest"]["layers"][0]["durationSeconds"] = json!(3);
        } else {
            bad["manifest"]["layers"][0]["elementId"] = json!("replaced");
        }
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.variables.set",
                    InvocationContext::default(),
                    bad
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, current);
    }
    let mut locked = current["project"]["classic"].clone();
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
    call(&runtime,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":current["revision"],"classic":locked})).await;
    let locked = read(&runtime).await;
    fresh["expectedRevision"] = locked["revision"].clone();
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.variables.set",
                InvocationContext::default(),
                fresh
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, locked);
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.variables.set",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
}
