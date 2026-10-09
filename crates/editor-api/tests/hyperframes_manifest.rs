use opencut_editor_api::{
    HyperframesRuntimeManifest, HyperframesSource, InvocationContext, OpenCutRuntime,
};
use serde_json::{json, Value};

fn source() -> HyperframesSource {
    serde_json::from_value(json!({"entryFile":"index.html","files":{
        "index.html":"<div data-composition-id='main' data-duration='6'></div>",
        "child.html":"<template><div data-composition-id='child'></div></template>"
    },"resourceAssetIds":{"voice.wav":"voice"}}))
    .unwrap()
}

fn manifest(source: &HyperframesSource) -> Value {
    let mut layers = Vec::new();
    for (key, parent, start, kind) in [
        ("host/a", None, 0.0, "composition"),
        ("host/a/voice", Some("host/a"), 0.5, "audio"),
        ("host/b", None, 3.0, "composition"),
        ("host/b/voice", Some("host/b"), 3.5, "audio"),
    ] {
        layers.push(json!({"key":key,"parentKey":parent,"file":"child.html",
            "elementId":"repeated-author-id","label":"קריינות","kind":kind,
            "startSeconds":start,"durationSeconds":2.0,"trackIndex":0,
            "resourcePath":if kind == "audio" { Some("voice.wav") } else { None },
            "playbackStartSeconds":0.25,"playbackRate":1.0,
            "media":if kind == "audio" { json!({"sourceDurationSeconds":6.0,"muted":false,
                "looping":false,"attributes":{"data-volume":"0.5","data-fade-in":"0.2"}}) } else { Value::Null }}));
    }
    json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115",
        "durationSeconds":6.0,"layers":layers,"diagnostics":[]})
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

#[tokio::test]
async fn validates_occurrence_identity_and_rejects_stale_unbounded_or_invalid_observations() {
    let runtime = OpenCutRuntime::default();
    let source = source();
    let original = manifest(&source);
    let validated = call(
        &runtime,
        "hyperframes.manifest.validate",
        json!({"source":source,"manifest":original}),
    )
    .await;
    assert_eq!(validated, original);
    let cases = [
        ("/sourceFingerprint", json!("stale")),
        ("/durationSeconds", json!(0)),
        ("/layers/1/key", json!("host/a")),
        ("/layers/0/parentKey", json!("host/a/voice")),
        ("/layers/1/parentKey", json!("missing")),
        ("/layers/1/resourcePath", json!("C:/private.wav")),
        ("/layers/1/file", json!("missing.html")),
        ("/layers/1/durationSeconds", json!(-1)),
        ("/layers/1/playbackRate", json!(0)),
        ("/layers/1/playbackStartSeconds", json!(-1)),
        ("/layers/1/media/sourceDurationSeconds", json!(0)),
        ("/layers/1/media/attributes", json!({"onclick":"evil"})),
        ("/layers/1/label", json!("x".repeat(2049))),
    ];
    for (path, value) in cases {
        let mut bad = original.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.manifest.validate",
                    InvocationContext::default(),
                    json!({"source":source,"manifest":bad})
                )
                .await
                .is_err(),
            "accepted {path}"
        );
    }
    let mut oversized: HyperframesRuntimeManifest = serde_json::from_value(original).unwrap();
    oversized.layers = vec![oversized.layers[0].clone(); 20_001];
    assert!(oversized.validate(&source).is_err());
}

async fn classic_runtime() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"voice","name":"voice.wav",
        "type":"audio","size":12,"lastModified":1,"storageKind":"copied","duration":6}));
    call(
        &runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}

#[tokio::test]
async fn import_manifest_reads_back_through_app_state_and_survives_undo_and_reopen() {
    let runtime = classic_runtime().await;
    let source = source();
    let manifest = manifest(&source);
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,
        "name":"Runtime layers","source":source,"runtimeManifest":manifest});
    let imported = call(&runtime, "timeline.hyperframes.import", input).await;
    let after = call(&runtime, "app.state.read", json!({})).await["value"].clone();
    let id = imported["assetId"].as_str().unwrap();
    assert_eq!(
        after["project"]["classic"]["document"]["hyperframesCompositions"][id]["runtimeManifest"],
        manifest
    );
    call(&runtime, "history.undo", json!({})).await;
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(
        runtime.snapshot().unwrap().project,
        serde_json::from_value(after["project"].clone()).unwrap()
    );
    let reopened = OpenCutRuntime::default();
    reopened
        .restore_application_state_from_bytes(&runtime.serialize_application_state().unwrap())
        .unwrap();
    assert_eq!(reopened.snapshot().unwrap(), runtime.snapshot().unwrap());
}

#[tokio::test]
async fn refresh_is_atomic_revision_checked_and_undoable_and_rejects_source_drift() {
    let runtime = classic_runtime().await;
    let source = source();
    let imported = call(
        &runtime,
        "timeline.hyperframes.import",
        json!({"projectId":"classic-project",
        "expectedRevision":runtime.snapshot().unwrap().revision,"name":"Existing","source":source}),
    )
    .await;
    let before = runtime.snapshot().unwrap();
    let id = imported["assetId"].as_str().unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":before.revision,"assetId":id,"manifest":manifest(&source)});
    runtime
        .registry()
        .invoke(
            "hyperframes.manifest.set",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap(), before);
    for (field, value) in [
        ("expectedRevision", json!(0)),
        ("projectId", json!("wrong")),
        ("assetId", json!("missing")),
    ] {
        let mut bad = input.clone();
        bad[field] = value;
        assert!(runtime
            .registry()
            .invoke(
                "hyperframes.manifest.set",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err());
        assert_eq!(runtime.snapshot().unwrap(), before);
    }
    call(&runtime, "hyperframes.manifest.set", input).await;
    let updated = runtime.snapshot().unwrap();
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(runtime.snapshot().unwrap().project, updated.project);
    let bad = json!({"expectedRevision":runtime.snapshot().unwrap().revision,"patch":[{
        "op":"replace","path":format!("/project/classic/document/hyperframesCompositions/{id}/source/files/index.html"),
        "value":"<div data-composition-id='different' data-duration='6'></div>"}]});
    assert!(runtime
        .registry()
        .invoke("app.state.patch", InvocationContext::default(), bad)
        .await
        .is_err());
    assert_eq!(runtime.snapshot().unwrap().project, updated.project);
}

#[tokio::test]
async fn native_manifest_uses_the_same_transactional_cancellable_idempotent_contract() {
    let runtime = OpenCutRuntime::full_access().unwrap();
    call(&runtime, "project.create", json!({"name":"Layers"})).await;
    let voice = call(
        &runtime,
        "media.import",
        json!({"name":"Voice","source":"voice.wav","mediaType":"audio","durationSeconds":6}),
    )
    .await;
    let mut source = source();
    source.resource_asset_ids.insert(
        "voice.wav".into(),
        voice["changedIds"][0].as_str().unwrap().into(),
    );
    let project_id = runtime.snapshot().unwrap().project.unwrap().id;
    let imported = call(
        &runtime,
        "timeline.hyperframes.import",
        json!({"projectId":project_id,
        "expectedRevision":runtime.snapshot().unwrap().revision,"name":"Layers","source":source}),
    )
    .await;
    let before = runtime.snapshot().unwrap();
    let manifest = manifest(&source);
    let input = json!({"projectId":project_id,"expectedRevision":before.revision,"assetId":imported["assetId"],"manifest":manifest});
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.manifest.set")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, opencut_editor_api::AccessLevel::Write);
    assert!(descriptor.transactional && descriptor.cancellable && descriptor.supports_dry_run);
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(runtime
        .registry()
        .invoke("hyperframes.manifest.set", cancelled, input.clone())
        .await
        .is_err());
    assert_eq!(runtime.snapshot().unwrap(), before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("manifest-once"));
    let first = runtime
        .registry()
        .invoke("hyperframes.manifest.set", context.clone(), input.clone())
        .await
        .unwrap();
    let second = runtime
        .registry()
        .invoke("hyperframes.manifest.set", context, input)
        .await
        .unwrap();
    assert_eq!(first.result.data, second.result.data);
    let state = call(&runtime, "app.state.read", json!({})).await["value"].clone();
    let asset = state["project"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == imported["assetId"])
        .unwrap();
    assert_eq!(asset["hyperframes"]["runtimeManifest"], manifest);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
}
