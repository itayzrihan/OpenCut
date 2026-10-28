use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const EDIT: &str = "render.queue.edit";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
fn revision(r: &OpenCutRuntime) -> u64 {
    r.snapshot().unwrap().revision
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let snapshot: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":snapshot}),
    )
    .await;
    r
}
fn options() -> Value {
    json!({"format":"mp4","quality":"high","preferences":{"resolution":"source","encoding":"compatible"},"fps":{"numerator":25,"denominator":1},"includeAudio":true})
}
fn request(r: &OpenCutRuntime, id: &str, change: Value, time: u64) -> Value {
    json!({"projectId":"classic-project","id":id,"expectedRevision":revision(r),"nowMs":time,"change":change})
}
async fn enqueue(r: &OpenCutRuntime, id: &str) -> Value {
    let captured=call(r,"project.classic.export.capture",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision(r)})).await;
    call(r,EDIT,request(r,id,json!({"type":"enqueue","snapshot":captured["snapshot"],"sourceRevision":captured["sourceRevision"],"sceneId":"main-scene","options":options()}),1000)).await
}
#[tokio::test]
async fn frozen_scene_recipe_dependency_graph_survive_edits_and_serialization() {
    let r = setup().await;
    let original = r.snapshot().unwrap().project.unwrap().classic.unwrap();
    let queued = enqueue(&r, "job-1").await;
    let hash = queued["job"]["snapshotHash"].clone();
    call(&r,"timeline.classic.crop",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision(&r),"edge":"start","time":120000})).await;
    let state = call(&r, "app.state.read", json!({})).await["value"].clone();
    assert_eq!(
        state["renderQueue"][0]["snapshot"],
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(state["renderQueue"][0]["options"], options());
    assert_eq!(state["renderQueue"][0]["snapshotHash"], hash);
    assert_ne!(
        state["renderQueue"][0]["snapshot"]["document"]["scenes"],
        state["project"]["classic"]["document"]["scenes"]
    );
    let bytes = r.serialize_application_state().unwrap();
    let restored = OpenCutRuntime::default();
    restored
        .restore_application_state_from_bytes(&bytes)
        .unwrap();
    assert_eq!(
        restored.snapshot().unwrap().render_queue,
        r.snapshot().unwrap().render_queue
    );
}
#[tokio::test]
async fn serial_fifo_and_worker_attempt_fences() {
    let r = setup().await;
    enqueue(&r, "first").await;
    enqueue(&r, "second").await;
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                request(&r, "second", json!({"type":"claim","attempt":"b"}), 2000)
            )
            .await
            .is_err()
    );
    call(
        &r,
        EDIT,
        request(&r, "first", json!({"type":"claim","attempt":"a"}), 2000),
    )
    .await;
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                request(&r, "second", json!({"type":"claim","attempt":"b"}), 2001)
            )
            .await
            .is_err()
    );
    assert!(r.registry().invoke(EDIT,InvocationContext::default(),request(&r,"first",json!({"type":"report","attempt":"wrong","progress":1,"message":"Done","status":"completed"}),2002)).await.is_err());
    call(&r,EDIT,request(&r,"first",json!({"type":"report","attempt":"a","progress":0.4,"message":"Rendering","status":"rendering"}),3000)).await;
    assert!(r.registry().invoke(EDIT,InvocationContext::default(),request(&r,"first",json!({"type":"report","attempt":"a","progress":0.3,"message":"Old progress","status":"rendering"}),3001)).await.is_err());
    let done=call(&r,EDIT,request(&r,"first",json!({"type":"report","attempt":"a","progress":1,"message":"Done","status":"completed"}),4000)).await;
    assert_eq!(done["job"]["outputId"], "first");
    call(
        &r,
        EDIT,
        request(&r, "second", json!({"type":"claim","attempt":"b"}), 4001),
    )
    .await;
}
#[tokio::test]
async fn cancellation_acknowledgment_and_retry_keep_exact_snapshot() {
    let r = setup().await;
    let original = enqueue(&r, "job").await["job"]["snapshotHash"].clone();
    call(
        &r,
        EDIT,
        request(&r, "job", json!({"type":"claim","attempt":"old"}), 2000),
    )
    .await;
    let cancelling = call(&r, EDIT, request(&r, "job", json!({"type":"cancel"}), 2100)).await;
    assert_eq!(cancelling["job"]["cancelRequested"], true);
    assert_eq!(cancelling["job"]["status"], "rendering");
    let stopped=call(&r,EDIT,request(&r,"job",json!({"type":"report","attempt":"old","progress":1,"message":"Done","status":"completed"}),2200)).await;
    assert_eq!(stopped["job"]["status"], "cancelled");
    assert!(stopped["job"]["outputId"].is_null());
    let retry = call(&r, EDIT, request(&r, "job", json!({"type":"retry"}), 2300)).await;
    assert_eq!(retry["job"]["snapshotHash"], original);
    call(
        &r,
        EDIT,
        request(&r, "job", json!({"type":"claim","attempt":"new"}), 2400),
    )
    .await;
    assert!(r.registry().invoke(EDIT,InvocationContext::default(),request(&r,"job",json!({"type":"report","attempt":"old","progress":1,"message":"Late","status":"completed"}),2500)).await.is_err());
}
#[tokio::test]
async fn disconnect_is_a_failed_boundary_and_late_completion_is_rejected() {
    let r = setup().await;
    enqueue(&r, "first").await;
    enqueue(&r, "second").await;
    call(
        &r,
        EDIT,
        request(&r, "first", json!({"type":"claim","attempt":"old"}), 2000),
    )
    .await;
    call(
        &r,
        EDIT,
        request(
            &r,
            "second",
            json!({"type":"claim","attempt":"next"}),
            123000,
        ),
    )
    .await;
    let s = r.snapshot().unwrap();
    assert_eq!(
        serde_json::to_value(&s.render_queue[0]).unwrap()["status"],
        "failed"
    );
    assert!(r.registry().invoke(EDIT,InvocationContext::default(),request(&r,"first",json!({"type":"report","attempt":"old","progress":1,"message":"Late","status":"completed"}),124000)).await.is_err());
}
#[tokio::test]
async fn dry_run_revision_idempotency_validation_and_undo() {
    let r = setup().await;
    let descriptor = r.registry().descriptor(EDIT).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.transactional && descriptor.supports_dry_run && !descriptor.open_world);
    let before = r.snapshot().unwrap();
    let snapshot = before.project.as_ref().unwrap().classic.as_ref().unwrap();
    let input = request(
        &r,
        "job",
        json!({"type":"enqueue","snapshot":snapshot,"sceneId":"main-scene","sourceRevision":before.revision,"options":options()}),
        1000,
    );
    let dry = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    r.registry().invoke(EDIT, dry, input.clone()).await.unwrap();
    assert_eq!(r.snapshot().unwrap(), before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("enqueue-once"));
    let receipt = r
        .registry()
        .invoke(EDIT, ctx.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(EDIT, ctx, input).await.unwrap(),
        receipt
    );
    assert_eq!(r.snapshot().unwrap().render_queue.len(), 1);
    call(&r, "history.undo", json!({})).await;
    assert!(r.snapshot().unwrap().render_queue.is_empty());
    let mut wrong = request(
        &r,
        "bad",
        json!({"type":"enqueue","snapshot":snapshot,"sceneId":"unknown","sourceRevision":before.revision,"options":options()}),
        2000,
    );
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), wrong.clone())
            .await
            .is_err()
    );
    wrong["change"]["sceneId"] = json!("main-scene");
    wrong["change"]["options"]["fps"]["numerator"] = json!(1000);
    assert!(
        r.registry()
            .invoke(EDIT, InvocationContext::default(), wrong)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn direct_exports_require_a_destination_and_do_not_publish_downloads_or_block_queued_fifo() {
    let r = setup().await;
    let captured=call(&r,"project.classic.export.capture",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision(&r)})).await;
    let mut change = json!({"type":"enqueue","snapshot":captured["snapshot"],"sourceRevision":captured["sourceRevision"],"sceneId":"main-scene","options":options(),"delivery":"direct"});
    let before = r.snapshot().unwrap();
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                request(&r, "direct", change.clone(), 1000)
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
    change["destinationName"] = json!("Podcast.mp4");
    call(&r, EDIT, request(&r, "direct", change, 1000)).await;
    enqueue(&r, "queue").await;
    // A waiting direct destination does not block the normal background lane.
    call(
        &r,
        EDIT,
        request(&r, "queue", json!({"type":"claim","attempt":"q"}), 2000),
    )
    .await;
    call(&r,EDIT,request(&r,"queue",json!({"type":"report","attempt":"q","progress":1,"message":"Done","status":"completed"}),3000)).await;
    call(
        &r,
        EDIT,
        request(&r, "direct", json!({"type":"claim","attempt":"d"}), 4000),
    )
    .await;
    let result=call(&r,EDIT,request(&r,"direct",json!({"type":"report","attempt":"d","progress":1,"message":"Saved Podcast.mp4","status":"completed"}),5000)).await;
    assert_eq!(result["job"]["status"], "completed");
    assert_eq!(result["job"]["destinationName"], "Podcast.mp4");
    assert!(result["job"]["outputId"].is_null());
    let state = call(&r, "app.state.read", json!({})).await["value"].clone();
    assert_eq!(state["renderQueue"][0]["delivery"], "direct");
    assert_eq!(
        state["project"],
        serde_json::to_value(before.project).unwrap()
    );
}

#[tokio::test]
async fn explicit_direct_claim_can_run_before_pending_background_jobs() {
    let r = setup().await;
    enqueue(&r, "background").await;
    let snapshot = r.snapshot().unwrap().project.unwrap().classic.unwrap();
    call(&r,EDIT,request(&r,"direct",json!({"type":"enqueue","snapshot":snapshot,"sourceRevision":1,"sceneId":"main-scene","options":options(),"delivery":"direct","destinationName":"Direct.webm"}),2000)).await;
    call(
        &r,
        EDIT,
        request(&r, "direct", json!({"type":"claim","attempt":"d"}), 3000),
    )
    .await;
    assert!(
        r.registry()
            .invoke(
                EDIT,
                InvocationContext::default(),
                request(
                    &r,
                    "background",
                    json!({"type":"claim","attempt":"q"}),
                    3001
                )
            )
            .await
            .is_err()
    );
    assert_eq!(
        r.snapshot().unwrap().render_queue[0].status,
        opencut_editor_api::QueueStatus::Queued
    );
}
