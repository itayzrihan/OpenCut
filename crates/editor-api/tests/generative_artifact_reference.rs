use base64::{Engine as _, engine::general_purpose::STANDARD};
use opencut_editor_api::{
    ArtifactRef, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_editor_image_generation, register_generative_host,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    task::{Context, Waker},
};
const PID: &str = "classic-project";
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=";
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value {
    rt.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
fn request(rt: &OpenCutRuntime, artifact_id: &str) -> Value {
    json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"operationId":"owned-image-import","operation":{"type":"importArtifactReference","artifactId":artifact_id,"name":"Generated hero.png","storyboard":false}})
}
fn reference(bytes: usize) -> Value {
    json!({"id":"a".repeat(32),"name":"Generated hero.png","mime":"image/png","kind":"image","bytes":bytes,"storyboard":false})
}
async fn setup() -> (OpenCutRuntime, HostBridge, ArtifactRef, Vec<u8>) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_editor_image_generation(&rt, &host).unwrap();
    register_generative_host(&rt, &host).unwrap();
    call(&rt,"project.classic.session.attach",json!({"projectId":PID,"expectedRevision":0,"classic":serde_json::from_str::<Value>(include_str!("fixtures/classic-project.json")).unwrap()})).await;
    let bytes = STANDARD.decode(PNG).unwrap();
    let artifact = rt
        .artifacts()
        .put(bytes.clone(), "image/png", Some(1), Some(1), None)
        .unwrap();
    let revision = rt.snapshot().unwrap().revision;
    {
        let mut generating=std::pin::pin!(rt.registry().invoke("imagegen.generate",InvocationContext::default(),json!({"projectId":PID,"expectedRevision":revision,"operationId":"human-reviewed-image","title":"Hero","prompt":"A synthetic one-pixel QA image","referenceArtifactIds":[]})));
        assert!(
            generating
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter, "subscriptionImage");
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":PID,"operationId":"human-reviewed-image","mediaId":"generated-hero","fileName":"hero.png","lastModified":123,"artifact":artifact})}).unwrap();
        generating.await.unwrap();
    }
    let pinned = rt.artifacts().get(&artifact.id).unwrap().metadata;
    (rt, host, pinned, bytes)
}

#[tokio::test]
async fn imagegen_artifact_transfers_exact_bytes_and_binds_only_the_intended_production_slot() {
    for recovered in [false, true] {
        let (rt, host, artifact, bytes) = setup().await;
        let imported = if recovered {
            rt.artifacts()
                .put(bytes.clone(), "image/png", Some(1), Some(1), None)
                .unwrap()
        } else {
            artifact.clone()
        };
        for slot in ["hero", "background"] {
            call(&rt,"project.production.edit",json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"change":{"type":"createReferenceSlot","slotId":slot,"label":slot}})).await;
        }
        let args = request(&rt, &imported.id);
        let mut context = InvocationContext::default();
        context
            .metadata
            .insert("opencut/idempotencyKey".into(), json!("attach-once"));
        let mut pending = std::pin::pin!(rt.registry().invoke(
            "project.generative.request",
            context.clone(),
            args.clone()
        ));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter, "generativeReview");
        assert_eq!(effect.request["operation"]["type"], "importReference");
        assert!(effect.request["operation"].get("artifactId").is_none());
        assert_eq!(
            STANDARD
                .decode(effect.request["operation"]["dataBase64"].as_str().unwrap())
                .unwrap(),
            bytes
        );
        assert_eq!(
            effect.request["operation"]["sha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(effect.request["operation"]["mime"], "image/png");
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":PID,"revision":args["expectedRevision"],"reference":reference(bytes.len()),"job":null,"jobs":[]})}).unwrap();
        let receipt = pending.await.unwrap();
        assert!(!receipt.result.data.to_string().contains("dataBase64"));
        assert!(!receipt.result.data.to_string().contains(PNG));
        assert_eq!(receipt.result.data["reference"], reference(bytes.len()));
        assert_eq!(
            rt.registry()
                .invoke("project.generative.request", context, args)
                .await
                .unwrap(),
            receipt
        );
        assert!(host.pending().unwrap().is_empty());
        call(&rt,"project.production.edit",json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"change":{"type":"addReferenceVersion","slotId":"hero","expectedSlotVersion":1,"referenceId":receipt.result.data["reference"]["id"],"source":"generated","caption":"The reviewed hero"}})).await;
        let workspace =
            call(&rt, "project.production.read", json!({"projectId":PID})).await["workspace"]
                .clone();
        assert_eq!(
            workspace["referenceSlots"][0]["versions"][0]["referenceId"],
            "a".repeat(32)
        );
        assert!(workspace["referenceSlots"][0]["approvedVersion"].is_null());
        assert!(
            workspace["referenceSlots"][1]["versions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            rt.artifacts().get(&artifact.id).unwrap().bytes.as_ref(),
            bytes.as_slice()
        );
    }
}

#[tokio::test]
async fn unowned_missing_wrong_mime_oversized_and_stale_imports_never_dispatch_host_io() {
    let (rt, host, artifact, bytes) = setup().await;
    let mut foreign_bytes = bytes.clone();
    foreign_bytes.push(1);
    let foreign = rt
        .artifacts()
        .put(foreign_bytes, "image/png", Some(1), Some(1), None)
        .unwrap();
    let wrong = rt
        .artifacts()
        .put(bytes.clone(), "application/pdf", None, None, None)
        .unwrap();
    let bad_png = rt
        .artifacts()
        .put(vec![0; 24], "image/png", None, None, None)
        .unwrap();
    let mut large = bytes;
    large.resize(12 * 1024 * 1024 + 1, 0);
    let large = rt
        .artifacts()
        .put(large, "image/png", Some(1), Some(1), None)
        .unwrap();
    for id in [
        &foreign.id,
        &wrong.id,
        &bad_png.id,
        &large.id,
        "artifact-missing",
        "/tmp/secret.png",
    ] {
        let before = rt.snapshot().unwrap();
        assert!(
            rt.registry()
                .invoke(
                    "project.generative.request",
                    InvocationContext::default(),
                    request(&rt, id)
                )
                .await
                .is_err(),
            "{id}"
        );
        assert!(host.pending().unwrap().is_empty());
        assert_eq!(rt.snapshot().unwrap(), before);
    }
    for mode in ["project", "revision", "scope", "dry", "path", "multibyte"] {
        let mut args = request(&rt, &artifact.id);
        let mut context = InvocationContext::default();
        match mode {
            "project" => args["projectId"] = json!("other"),
            "revision" => args["expectedRevision"] = json!(0),
            "scope" => {
                context
                    .metadata
                    .insert("opencut/projectId".into(), json!("other"));
            }
            "dry" => context.dry_run = true,
            "path" => args["operation"]["name"] = json!("../secret.png"),
            _ => args["operation"]["name"] = json!("א".repeat(151)),
        };
        let before = rt.snapshot().unwrap();
        assert!(
            rt.registry()
                .invoke("project.generative.request", context, args)
                .await
                .is_err(),
            "{mode}"
        );
        assert!(host.pending().unwrap().is_empty());
        assert_eq!(rt.snapshot().unwrap(), before);
    }
    // A checksum in unrelated project metadata is not a media ownership binding.
    call(&rt,"app.state.patch",json!({"expectedRevision":rt.snapshot().unwrap().revision,"patch":[{"op":"replace","path":"/project/classic/mediaAssets/1/generation/sha256","value":"f".repeat(64)}]})).await;
    assert!(
        rt.registry()
            .invoke(
                "project.generative.request",
                InvocationContext::default(),
                request(&rt, &artifact.id)
            )
            .await
            .is_err()
    );
    assert!(host.pending().unwrap().is_empty());
}

#[tokio::test]
async fn invalid_receipts_cancellation_or_changed_document_cannot_attach_the_imported_reference() {
    for mode in [
        "stale",
        "cancel",
        "mime",
        "bytes",
        "name",
        "kind",
        "storyboard",
        "missing-artifact",
    ] {
        let (rt, host, artifact, bytes) = setup().await;
        let args = request(&rt, &artifact.id);
        let context = InvocationContext::default();
        let cancel = context.cancellation.clone();
        let mut pending = std::pin::pin!(rt.registry().invoke(
            "project.generative.request",
            context,
            args.clone()
        ));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        let mut item = reference(bytes.len());
        match mode {
            "stale" => {
                call(&rt,"project.production.edit",json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"change":{"type":"createReferenceSlot","slotId":"concurrent","label":"Concurrent edit"}})).await;
            }
            "cancel" => cancel.cancel(),
            "mime" => item["mime"] = json!("image/jpeg"),
            "bytes" => item["bytes"] = json!(999),
            "name" => item["name"] = json!("Different.png"),
            "kind" => item["kind"] = json!("video"),
            "storyboard" => item["storyboard"] = json!(true),
            _ => {
                rt.artifacts().remove(&artifact.id).unwrap();
            }
        }
        let before = rt.snapshot().unwrap();
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":PID,"revision":args["expectedRevision"],"reference":item,"job":null,"jobs":[]})}).unwrap();
        assert!(pending.await.is_err(), "{mode}");
        assert_eq!(rt.snapshot().unwrap(), before);
        assert!(host.pending().unwrap().is_empty());
    }
}
