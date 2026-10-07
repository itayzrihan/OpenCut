use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    owned_media_transfer_plan, owned_project_read, register_owned_project_capabilities,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap()
}
fn read(revision: u64) -> Value {
    json!({"projectId":"classic-project","expectedRevision":revision,"sourceProjectId":"source","limit":1})
}
fn transfer(revision: u64) -> Value {
    json!({"projectId":"classic-project","expectedRevision":revision,"sourceProjectId":"source","mediaId":"video-asset","operationId":"copy-1","sourceFingerprint":"b".repeat(64)})
}
fn media() -> Value {
    json!({"id":"video-asset","name":"Video","type":"video","fileName":"video.mp4","mimeType":"video/mp4","size":20,"lastModified":123,"width":1920,"height":1080,"duration":10,"sourcePath":"C:/private/video.mp4","storedPath":"private","buffer":"private"})
}
async fn setup() -> (OpenCutRuntime, HostBridge) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_owned_project_capabilities(&rt, &host).unwrap();
    rt.registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":fixture()}),
        )
        .await
        .unwrap();
    (rt, host)
}
#[test]
fn saved_projection_pages_clips_and_does_not_leak_private_material() {
    let f = fixture();
    let mut project = f["document"].clone();
    project["metadata"]["id"] = json!("source");
    project["__opencutEditorSession"] = json!("private");
    project["credentials"] = json!("private");
    let mut assets = f["mediaAssets"].clone();
    assets[0]["sourcePath"] = json!("private");
    let summary = owned_project_read(read(2), Some(project.clone()), assets.clone()).unwrap();
    assert_eq!(summary["data"]["mediaAssets"].as_array().unwrap().len(), 1);
    let mut page = read(2);
    page["sceneId"] = json!("main-scene");
    page["offset"] = json!(1);
    let clips = owned_project_read(page, Some(project.clone()), assets.clone()).unwrap();
    assert_eq!(clips["data"]["elements"][0]["element"]["id"], "item-2");
    assert_eq!(clips["data"]["elements"][0]["element"]["duration"], 1200000);
    assert_eq!(clips["sourceFingerprint"], summary["sourceFingerprint"]);
    assert!(!clips.to_string().contains("private"));
    assert!(!summary.to_string().contains("private"));
    project["metadata"]["id"] = json!("foreign");
    assert!(owned_project_read(read(2), Some(project), assets).is_err());
}
#[test]
fn local_transfer_policy_is_scoped_bounded_and_revision_independent() {
    let a = owned_media_transfer_plan(transfer(2), media(), &"a".repeat(64), 20).unwrap();
    assert!(!a.to_string().contains("private"));
    assert_eq!(
        a["reply"]["media"]["origin"]["sourceMediaId"],
        "video-asset"
    );
    assert_eq!(
        a,
        owned_media_transfer_plan(transfer(99), media(), &"a".repeat(64), 20).unwrap()
    );
    let mut changed = transfer(2);
    changed["mediaId"] = json!("other");
    let mut other = media();
    other["id"] = json!("other");
    let b = owned_media_transfer_plan(changed, other, &"a".repeat(64), 20).unwrap();
    assert_eq!(a["key"], b["key"]);
    assert_ne!(a["digest"], b["digest"]);
    for size in [0, 268_435_457] {
        assert!(owned_media_transfer_plan(transfer(2), media(), &"a".repeat(64), size).is_err());
    }
    let mut compound = media();
    compound["unifiedAngles"] = json!({"angleAssetIds":["one"]});
    assert!(owned_media_transfer_plan(transfer(2), compound, &"a".repeat(64), 20).is_err());
    let mut path = media();
    path["fileName"] = json!("../private.mp4");
    assert!(owned_media_transfer_plan(transfer(2), path, &"a".repeat(64), 20).is_err());
}
async fn copy(
    rt: &OpenCutRuntime,
    host: &HostBridge,
    mode: &str,
) -> Result<opencut_editor_api::InvocationReceipt, opencut_editor_api::RegistryError> {
    let input = transfer(rt.snapshot().unwrap().revision);
    let ctx = InvocationContext::default();
    let cancel = ctx.cancellation.clone();
    let mut pending = std::pin::pin!(rt.registry().invoke(
        "projects.owned.media.copy",
        ctx,
        input.clone()
    ));
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "ownedMediaTransfer");
    let mut reply = owned_media_transfer_plan(input.clone(), media(), &"a".repeat(64), 20).unwrap()
        ["reply"]
        .clone();
    match mode {
        "foreign" => reply["sourceProjectId"] = json!("foreign"),
        "identity" => reply["media"]["id"] = json!("arbitrary"),
        "path" => reply["media"]["sourcePath"] = json!("private"),
        "private-field" => reply["media"]["credentials"] = json!("private"),
        "cancel" => cancel.cancel(),
        "stale" => {
            rt.registry().invoke("app.state.patch",InvocationContext::default(),json!({"expectedRevision":input["expectedRevision"],"patch":[{"op":"add","path":"/extensions/unrelated","value":1}]})).await.unwrap();
        }
        _ => {}
    }
    host.settle(effect.id, HostEffectResult::Success { data: reply })
        .unwrap();
    pending.await
}
#[tokio::test]
async fn owned_media_copy_registers_via_registry_reads_undoes_redoes_and_retries_once() {
    let (rt, host) = setup().await;
    let before = rt.snapshot().unwrap();
    let cap = rt
        .registry()
        .descriptor("projects.owned.media.copy")
        .unwrap()
        .unwrap();
    assert_eq!(cap.access, AccessLevel::Write);
    assert!(cap.open_world && cap.idempotent && cap.cancellable && !cap.transactional);
    let result = copy(&rt, &host, "ok").await.unwrap();
    let after = rt.snapshot().unwrap();
    assert_eq!(after.revision, before.revision + 1);
    let read = rt
        .registry()
        .invoke(
            "app.state.read",
            InvocationContext::default(),
            json!({"pointer":"/project/classic/mediaAssets"}),
        )
        .await
        .unwrap();
    assert!(
        read.result
            .data
            .to_string()
            .contains(result.result.data["mediaId"].as_str().unwrap())
    );
    let retry = copy(&rt, &host, "ok").await.unwrap();
    assert_eq!(retry.result.data["committed"], false);
    assert_eq!(rt.snapshot().unwrap(), after);
    rt.registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(rt.snapshot().unwrap().project, before.project);
    rt.registry()
        .invoke("history.redo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(rt.snapshot().unwrap().project, after.project);
}
#[tokio::test]
async fn owned_copy_rejects_foreign_reply_path_cancel_identity_and_stale_state_atomically() {
    for mode in [
        "foreign",
        "path",
        "private-field",
        "cancel",
        "identity",
        "stale",
    ] {
        let (rt, host) = setup().await;
        let before = rt.snapshot().unwrap();
        assert!(copy(&rt, &host, mode).await.is_err(), "{mode}");
        assert_eq!(rt.snapshot().unwrap().project, before.project);
        assert!(host.pending().unwrap().is_empty());
    }
}
#[tokio::test]
async fn owned_read_rejects_active_scope_changes_during_host_io() {
    let (rt, host) = setup().await;
    let rev = rt.snapshot().unwrap().revision;
    let ctx = InvocationContext::default();
    let cancel = ctx.cancellation.clone();
    let mut pending = std::pin::pin!(rt.registry().invoke("projects.owned.read", ctx, read(rev)));
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    cancel.cancel();
    host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":"classic-project","revision":rev,"sourceProjectId":"source","sourceFingerprint":"b".repeat(64),"data":{}})}).unwrap();
    assert!(pending.await.is_err());
    assert_eq!(rt.snapshot().unwrap().revision, rev);
}
