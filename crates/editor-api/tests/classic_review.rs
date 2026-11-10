use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const SHARE: &str = "project.classic.review.share.record";
const IMPORT: &str = "project.classic.review.comments.import";
const ID: &str = "11111111-1111-4111-8111-111111111111";
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
async fn fixture() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
async fn request(r: &OpenCutRuntime, fields: Value) -> Value {
    let mut fields = fields;
    fields["projectId"] = json!("classic-project");
    fields["expectedRevision"] = read(r).await["revision"].clone();
    fields
}
fn share() -> Value {
    json!({"shareId":ID,"version":"render-v1","sceneId":"main-scene","durationTicks":1200000,"createdAt":"2026-11-10T00:00:00Z","title":"First preview"})
}
fn comment() -> Value {
    json!({"id":"22222222-2222-4222-8222-222222222222","shareId":ID,"shareVersion":"render-v1","sceneId":"main-scene","timeTicks":240000,"body":"Please tighten this opening","authorName":"Client","serverRevision":1,"resolved":false,"createdAt":"2026-11-10T00:01:00Z"})
}
fn import(comments: Vec<Value>) -> Value {
    json!({"shareId":ID,"shareVersion":"render-v1","comments":comments})
}

#[tokio::test]
async fn imported_feedback_is_revision_fenced_idempotent_local_projection_and_persists() {
    let r = fixture().await;
    call(&r, SHARE, request(&r, json!({"share":share()})).await).await;
    let state = read(&r).await;
    call(&r, SHARE, request(&r, json!({"share":share()})).await).await;
    assert_eq!(read(&r).await, state);
    let input = request(&r, import(vec![comment()])).await;
    r.registry()
        .invoke(
            IMPORT,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, state);
    call(&r, IMPORT, input).await;
    let imported = read(&r).await;
    assert_eq!(
        imported["project"]["classic"]["document"]["clientReview"]["comments"][0],
        comment()
    );
    call(&r, IMPORT, request(&r, import(vec![comment()])).await).await;
    assert_eq!(
        read(&r).await,
        imported,
        "duplicate imports create no undo entry or revision"
    );
    let mut resolved = comment();
    resolved["serverRevision"] = json!(2);
    resolved["resolved"] = json!(true);
    call(
        &r,
        IMPORT,
        request(&r, import(vec![resolved.clone()])).await,
    )
    .await;
    let updated = read(&r).await;
    assert_eq!(
        updated["project"]["classic"]["document"]["clientReview"]["comments"][0],
        resolved
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(
        read(&r).await["project"]["classic"]["document"]["clientReview"],
        imported["project"]["classic"]["document"]["clientReview"]
    );
    call(&r, "history.redo", json!({})).await;
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    call(&r, "project.close", json!({"projectId":"classic-project"})).await;
    let reopen = OpenCutRuntime::default();
    call(
        &reopen,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(
        read(&reopen).await["project"]["classic"]["document"]["clientReview"],
        updated["project"]["classic"]["document"]["clientReview"]
    );
    for id in [SHARE, IMPORT] {
        let d = r.registry().descriptor(id).unwrap().unwrap();
        assert_eq!(d.access, AccessLevel::Write);
        assert!(!d.open_world);
        assert!(d.transactional && d.supports_dry_run);
    }
    assert!(
        r.registry()
            .descriptor("project.classic.review.comments.resolve")
            .unwrap()
            .is_none(),
        "local imported feedback grants no remote write capability"
    );
}

#[tokio::test]
async fn invalid_and_stale_review_imports_cannot_rebind_feedback_or_partially_commit() {
    let r = fixture().await;
    call(&r, SHARE, request(&r, json!({"share":share()})).await).await;
    call(&r, IMPORT, request(&r, import(vec![comment()])).await).await;
    let before = read(&r).await;
    for (field, value) in [
        ("body", json!("Conflicting same server revision")),
        ("sceneId", json!("other-scene")),
        ("timeTicks", json!(1200001)),
        ("shareVersion", json!("wrong-render")),
    ] {
        let mut invalid = comment();
        invalid[field] = value;
        assert!(
            r.registry()
                .invoke(
                    IMPORT,
                    InvocationContext::default(),
                    request(&r, import(vec![invalid])).await
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let mut valid = comment();
    valid["id"] = json!("33333333-3333-4333-8333-333333333333");
    let mut invalid = comment();
    invalid["id"] = json!("44444444-4444-4444-8444-444444444444");
    invalid["timeTicks"] = json!(-1);
    assert!(
        r.registry()
            .invoke(
                IMPORT,
                InvocationContext::default(),
                request(&r, import(vec![valid, invalid])).await
            )
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    let mut changed_share = share();
    changed_share["durationTicks"] = json!(2400000);
    assert!(
        r.registry()
            .invoke(
                SHARE,
                InvocationContext::default(),
                request(&r, json!({"share":changed_share})).await
            )
            .await
            .is_err()
    );
    let mut resolved = comment();
    resolved["serverRevision"] = json!(2);
    resolved["resolved"] = json!(true);
    call(&r, IMPORT, request(&r, import(vec![resolved])).await).await;
    let after = read(&r).await;
    assert!(
        r.registry()
            .invoke(
                IMPORT,
                InvocationContext::default(),
                request(&r, import(vec![comment()])).await
            )
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, after);
}

#[tokio::test]
async fn rendered_review_provenance_survives_scene_deletion_and_later_feedback() {
    let r = fixture().await;
    call(&r, "project.classic.scenes.edit", request(&r, json!({"change":{"type":"create","sceneId":"preview-scene","mainTrackId":"preview-main-track","name":"Secondary"}})).await).await;
    let mut rendered = share();
    rendered["sceneId"] = json!("preview-scene");
    let mut feedback = comment();
    feedback["sceneId"] = json!("preview-scene");
    // Rendered duration is intentionally independent of the empty current scene.
    call(
        &r,
        SHARE,
        request(&r, json!({"share": rendered.clone()})).await,
    )
    .await;
    call(
        &r,
        IMPORT,
        request(&r, import(vec![feedback.clone()])).await,
    )
    .await;
    call(
        &r,
        "project.classic.scene.delete",
        request(&r, json!({"sceneId":"preview-scene"})).await,
    )
    .await;
    let deleted = read(&r).await;
    let classic = &deleted["project"]["classic"]["document"];
    assert!(
        !classic["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "preview-scene")
    );
    assert_eq!(classic["clientReview"]["shares"][0], rendered);
    assert_eq!(classic["clientReview"]["comments"][0], feedback);
    feedback["serverRevision"] = json!(2);
    feedback["resolved"] = json!(true);
    call(
        &r,
        IMPORT,
        request(&r, import(vec![feedback.clone()])).await,
    )
    .await;
    assert_eq!(
        read(&r).await["project"]["classic"]["document"]["clientReview"]["comments"][0],
        feedback
    );
    call(&r, "history.undo", json!({})).await;
    call(&r, "history.undo", json!({})).await;
    assert!(
        read(&r).await["project"]["classic"]["document"]["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "preview-scene")
    );
}
