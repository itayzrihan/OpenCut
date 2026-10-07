use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_editor_image_generation, subscription_image_plan,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};

fn input(revision: u64) -> Value {
    json!({"projectId":"classic-project","expectedRevision":revision,"operationId":"image-operation","title":"Generated title","prompt":"A blue circle","transparentBackground":true,"referenceArtifactIds":[]})
}
async fn setup() -> (OpenCutRuntime, HostBridge) {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_editor_image_generation(&runtime, &host).unwrap();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    (runtime, host)
}
fn artifact(runtime: &OpenCutRuntime) -> opencut_editor_api::ArtifactRef {
    // Contract-level PNG header fixture; full pixel decode is host QA.
    let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    png.extend(1u32.to_be_bytes());
    png.extend(1u32.to_be_bytes());
    runtime
        .artifacts()
        .put(png, "image/png", Some(1), Some(1), None)
        .unwrap()
}
async fn generate(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
    mode: &str,
) -> Result<opencut_editor_api::InvocationReceipt, opencut_editor_api::RegistryError> {
    let context = InvocationContext::default();
    let cancel = context.cancellation.clone();
    let before = runtime.snapshot().unwrap().revision;
    let mut future = std::pin::pin!(runtime.registry().invoke(
        "imagegen.generate",
        context,
        input(before)
    ));
    assert!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "subscriptionImage");
    let mut reply = json!({"projectId":"classic-project","operationId":"image-operation","mediaId":"generated-image","fileName":"generated.png","lastModified":123,"artifact":artifact(runtime)});
    match mode {
        "wrong-scope" => reply["projectId"] = json!("foreign"),
        "wrong-hash" => reply["artifact"]["sha256"] = json!("0".repeat(64)),
        "cancelled" => cancel.cancel(),
        "stale" => {
            runtime.registry().invoke("app.state.patch",InvocationContext::default(),json!({"expectedRevision":before,"patch":[{"op":"add","path":"/extensions/newFeature","value":true}]})).await.unwrap();
        }
        _ => {}
    }
    host.settle(effect.id, HostEffectResult::Success { data: reply })
        .unwrap();
    future.await
}
#[tokio::test]
async fn image_host_registers_canonical_media_once_and_recovers_without_duplicate_history() {
    let (runtime, host) = setup().await;
    let before = runtime.snapshot().unwrap();
    let descriptor = runtime
        .registry()
        .descriptor("imagegen.generate")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(
        descriptor.open_world
            && descriptor.cancellable
            && descriptor.idempotent
            && !descriptor.transactional
    );
    let receipt = generate(&runtime, &host, "ok").await.unwrap();
    assert_eq!(receipt.result.artifacts.len(), 1);
    let generated = runtime.snapshot().unwrap();
    assert_eq!(generated.revision, before.revision + 1);
    let read = runtime
        .registry()
        .invoke(
            "app.state.read",
            InvocationContext::default(),
            json!({"pointer":"/project/classic/mediaAssets"}),
        )
        .await
        .unwrap();
    assert!(read.result.data.to_string().contains("generated-image"));
    let recovered = generate(&runtime, &host, "ok").await.unwrap();
    assert_eq!(runtime.snapshot().unwrap(), generated);
    assert_eq!(recovered.result.data["committed"], false);
    runtime
        .registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
    runtime
        .registry()
        .invoke("history.redo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().project, generated.project);
}
#[tokio::test]
async fn image_host_rejects_changed_scope_corrupted_artifact_cancel_and_stale_revision_atomically()
{
    for mode in ["wrong-scope", "wrong-hash", "cancelled", "stale"] {
        let (runtime, host) = setup().await;
        let before = runtime.snapshot().unwrap();
        assert!(generate(&runtime, &host, mode).await.is_err(), "{mode}");
        assert_eq!(runtime.snapshot().unwrap().project, before.project);
        assert!(host.pending().unwrap().is_empty());
    }
}
#[test]
fn durable_image_dispatch_policy_never_replays_uncertain_generation_and_excludes_revision_from_identity()
 {
    let request = input(2);
    let plan = subscription_image_plan(request.clone(), None, None, 10).unwrap();
    assert_eq!(plan["action"], "dispatch");
    assert_eq!(plan["providerBody"]["tools"][0]["type"], "image_generation");
    let journal = plan["journal"].clone();
    let mut fresh = request.clone();
    fresh["expectedRevision"] = json!(99);
    assert_eq!(
        subscription_image_plan(fresh.clone(), Some(journal.clone()), None, 20).unwrap()["action"],
        "uncertain"
    );
    let result = json!({"mediaId":plan["mediaId"],"fileName":plan["fileName"],"sha256":"a".repeat(64),"width":1024,"height":1024,"byteSize":1024,"lastModified":15});
    let completed = subscription_image_plan(
        request.clone(),
        Some(journal.clone()),
        Some(result.clone()),
        30,
    )
    .unwrap();
    let recovered =
        subscription_image_plan(fresh, Some(completed["journal"].clone()), None, 40).unwrap();
    assert_eq!(recovered["result"], result);
    assert_eq!(recovered["action"], "recover");
    let mut conflict = request.clone();
    conflict["prompt"] = json!("Different image");
    assert!(subscription_image_plan(conflict, Some(journal), None, 50).is_err());
    let mut foreign = completed["journal"].clone();
    foreign["projectId"] = json!("foreign");
    assert!(subscription_image_plan(request, Some(foreign), None, 60).is_err());
}
