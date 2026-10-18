use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
fn kit() -> Value {
    json!({"id":"client-one","name":"לקוח ראשון","primaryColor":"#ffffff","secondaryColor":"#99ff00","backgroundColor":"#121512","style":"Warm and minimal","phrases":["המותג שלך"],"headingFont":"Arial","bodyFont":"Verdana","logo":{"assetId":"logo-one","width":400,"height":200},"musicIds":["music-one"],"sfxIds":["sfx-one"]})
}
async fn call(rt: &OpenCutRuntime, id: &str, value: Value) -> Value {
    rt.registry()
        .invoke(id, InvocationContext::default(), value)
        .await
        .unwrap()
        .result
        .data
}
async fn read(rt: &OpenCutRuntime) -> Value {
    call(rt, "app.state.read", json!({})).await["value"].clone()
}
async fn account() -> OpenCutRuntime {
    let rt = OpenCutRuntime::full_access().unwrap();
    call(&rt,"app.state.patch",json!({"patch":[{"op":"add","path":"/account","value":{"id":"alice","displayName":"Alice","storage":{"mode":"localOnly","destinationId":null,"devices":[]}}}]})).await;
    rt
}
#[tokio::test]
async fn kits_are_account_owned_validated_multiple_and_undoable_with_dry_run_and_retry() {
    let rt = account().await;
    let descriptor = rt
        .registry()
        .descriptor("account.brand_kits.edit")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.supports_dry_run && descriptor.transactional && !descriptor.open_world);
    let before = read(&rt).await;
    let input = json!({"accountId":"alice","expectedRevision":before["revision"],"change":{"type":"upsert","kit":kit()}});
    rt.registry()
        .invoke(
            "account.brand_kits.edit",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(before, read(&rt).await);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("brand-once"));
    let receipt = rt
        .registry()
        .invoke("account.brand_kits.edit", context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        receipt,
        rt.registry()
            .invoke("account.brand_kits.edit", context, input.clone())
            .await
            .unwrap()
    );
    let saved = read(&rt).await;
    assert_eq!(saved["account"]["brandKits"][0], kit());
    for mut invalid in [input.clone(), input.clone(), input.clone()] {
        invalid["expectedRevision"] = saved["revision"].clone();
        invalid["accountId"] = json!("bob");
        assert!(
            rt.registry()
                .invoke(
                    "account.brand_kits.edit",
                    InvocationContext::default(),
                    invalid
                )
                .await
                .is_err()
        );
    }
    let mut invalid = input.clone();
    invalid["expectedRevision"] = saved["revision"].clone();
    invalid["change"]["kit"]["primaryColor"] = json!("red");
    assert!(
        rt.registry()
            .invoke(
                "account.brand_kits.edit",
                InvocationContext::default(),
                invalid
            )
            .await
            .is_err()
    );
    assert_eq!(saved, read(&rt).await);
    let mut second = kit();
    second["id"] = json!("client-two");
    call(&rt,"account.brand_kits.edit",json!({"accountId":"alice","expectedRevision":saved["revision"],"change":{"type":"upsert","kit":second}})).await;
    assert_eq!(
        read(&rt).await["account"]["brandKits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(
        read(&rt).await["account"]["brandKits"],
        saved["account"]["brandKits"]
    );
    let current = read(&rt).await;
    call(
        &rt,
        "account.brand_kits.remove",
        json!({"accountId":"alice","expectedRevision":current["revision"],"kitId":"client-one"}),
    )
    .await;
    assert_eq!(read(&rt).await["account"]["brandKits"], json!([]));
    call(&rt, "history.undo", json!({})).await;
    let bytes = rt.serialize_application_state_with_history().unwrap();
    let reopened = OpenCutRuntime::full_access().unwrap();
    reopened
        .restore_application_state_from_bytes(&bytes)
        .unwrap();
    assert_eq!(read(&reopened).await, read(&rt).await);
}
#[tokio::test]
async fn full_auto_branding_is_atomic_editable_scene_scoped_and_preserves_speech_and_reopen() {
    let rt = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["audio"] = json!([{"id":"auto-sfx","type":"audio","name":"Auto SFX","muted":false,"elements":[{"id":"sound-1","type":"audio","name":"Typing","sourceType":"library","libraryAssetId":"old-sfx","startTime":0,"duration":60000,"trimStart":0,"trimEnd":0,"sourceDuration":60000,"automaticWordAnimationOwner":"automatic-word-animation-v1","params":{"volume":-5}}]}]);
    call(
        &rt,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&rt).await;
    let input = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"kit":kit(),"sfxDurationTicks":{"sfx-one":30000}});
    rt.registry()
        .invoke(
            "timeline.classic.brand_kit.apply",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&rt).await, before);
    for bad in [
        json!({"sceneId":"missing"}),
        json!({"projectId":"foreign"}),
        json!({"expectedRevision":0}),
        json!({"sfxDurationTicks":{}}),
    ] {
        let mut value = input.clone();
        for (k, v) in bad.as_object().unwrap() {
            value[k] = v.clone();
        }
        assert!(
            rt.registry()
                .invoke(
                    "timeline.classic.brand_kit.apply",
                    InvocationContext::default(),
                    value
                )
                .await
                .is_err()
        );
        assert_eq!(read(&rt).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        rt.registry()
            .invoke("timeline.classic.brand_kit.apply", cancelled, input.clone())
            .await
            .is_err()
    );
    call(&rt, "timeline.classic.brand_kit.apply", input).await;
    let after = read(&rt).await;
    let scene = &after["project"]["classic"]["document"]["scenes"][0];
    assert_eq!(scene["appliedBrandKit"], kit());
    assert_eq!(
        scene["tracks"]["main"],
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][1],
        before["project"]["classic"]["document"]["scenes"][1]
    );
    let overlays = scene["tracks"]["overlay"].as_array().unwrap();
    assert_eq!(overlays.len(), 3);
    let logo = overlays
        .iter()
        .find(|track| track["type"] == "graphic")
        .unwrap();
    assert!(
        logo["elements"][0]["params"]["transform.positionX"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    assert!(
        logo["elements"][0]["params"]["transform.positionY"]
            .as_f64()
            .unwrap()
            < 0.0
    );
    let captions = overlays.iter().find(|t| t["id"] == "titles").unwrap();
    assert_eq!(captions["elements"][0]["params"]["fontFamily"], "Verdana");
    assert_eq!(
        captions["captionSource"]["words"],
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][0]["captionSource"]
            ["words"]
    );
    assert_eq!(
        scene["tracks"]["audio"][0]["elements"][0]["duration"],
        30000
    );
    assert_eq!(
        scene["tracks"]["audio"][0]["elements"][0]["libraryAssetId"],
        "sfx-one"
    );
    call(&rt,"timeline.classic.brand_kit.apply",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":after["revision"],"kit":kit(),"sfxDurationTicks":{"sfx-one":30000}})).await;
    assert_eq!(
        read(&rt).await["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let bytes = rt.serialize_application_state_with_history().unwrap();
    let reopened = OpenCutRuntime::full_access().unwrap();
    reopened
        .restore_application_state_from_bytes(&bytes)
        .unwrap();
    assert_eq!(read(&reopened).await, read(&rt).await);
    call(&rt, "history.undo", json!({})).await;
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(read(&rt).await["project"], before["project"]);
}
