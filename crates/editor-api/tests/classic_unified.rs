use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
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
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    c["document"]["settings"]["fps"] = json!({"numerator":25,"denominator":1});
    c["mediaAssets"] = json!([
     {"id":"video-asset","name":"Long camera","type":"video","duration":3600,"hasAudio":true,"bindingRevision":3},
     {"id":"short","name":"Short camera","type":"video","duration":1800,"hasAudio":true,"bindingRevision":4},
     {"id":"unified","name":"Speaker angles","type":"video","duration":1800,"hasAudio":true,"unifiedAngles":{"version":1,"angleAssetIds":["short","video-asset"],"defaultAngleAssetId":"short","audioAssetId":"short"}}
    ]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    r
}
fn sources() -> Value {
    json!([
     {"id":"short","duration":1800,"start":50,"bindingRevision":4},
     {"id":"video-asset","duration":3600,"start":20,"bindingRevision":3}
    ])
}
async fn sync(r: &OpenCutRuntime) {
    let state = read(r).await;
    call(r,"media.classic.unified.sync",json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaId":"unified","sources":sources()})).await;
}
#[tokio::test]
async fn unified_audio_sync_preserves_long_camera_and_switches_only_overlapping_cuts() {
    let r = fixture().await;
    let before = read(&r).await;
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"mediaId":"unified","sources":sources()});
    r.registry()
        .invoke(
            "media.classic.unified.sync",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("sync-once"));
    let receipt = r
        .registry()
        .invoke("media.classic.unified.sync", ctx.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke("media.classic.unified.sync", ctx, input)
            .await
            .unwrap(),
        receipt
    );
    let state = read(&r).await;
    let asset = &state["project"]["classic"]["mediaAssets"][2];
    assert_eq!(asset["duration"], 3600.0);
    assert_eq!(asset["unifiedAngles"]["defaultAngleAssetId"], "video-asset");
    assert_eq!(asset["unifiedAngles"]["audioAssetId"], "video-asset");
    assert_eq!(asset["unifiedAngles"]["sync"]["method"], "audio");
    assert_eq!(asset["unifiedAngles"]["sync"]["sources"][0]["start"], 30.0);
    let settings = classic_podcast::podcast_multicam_defaults(
        classic_podcast::PodcastMulticamDefaultsOptions { quick: true },
    );
    call(&r,"timeline.classic.multicam.create",json!({"projectId":"classic-project","expectedRevision":state["revision"],"plan":{
  "settings":settings,"duration":3600,"channels":[{"id":"speaker","name":"Speaker","videoId":"unified","audioId":"video-asset","videoBindingRevision":1,"audioBindingRevision":3,"videoOffset":0,"audioOffset":0,"audioDelay":0}],
  "cuts":[{"timestamp":0,"duration":3600,"channelId":"speaker"}]
 }})).await;
    let state = read(&r).await;
    let scene = &state["project"]["classic"]["document"]["scenes"][2];
    let clips = scene["tracks"]["overlay"][0]["elements"]
        .as_array()
        .unwrap();
    assert_eq!(clips.len(), 3);
    assert_eq!(clips[2]["startTime"], 1830 * 120000);
    assert_eq!(clips[2]["duration"], 1770 * 120000);
    assert_eq!(clips[0]["mediaId"], "unified");
    let switch = |ids: Value, cycle: bool| json!({"projectId":"classic-project","expectedRevision":state["revision"],"sceneId":scene["id"],"mediaId":"unified","elementIds":ids,"angleAssetId":"short","cycle":cycle});
    for index in [0, 2] {
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.unified.switch",
                    InvocationContext::default(),
                    switch(json!([clips[index]["id"]]), false)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, state);
    }
    call(
        &r,
        "timeline.classic.unified.switch",
        switch(json!([clips[1]["id"]]), false),
    )
    .await;
    let switched = read(&r).await;
    assert_eq!(
        switched["project"]["classic"]["document"]["scenes"][2]["tracks"]["overlay"][0]["elements"]
            [1]["unifiedAngleId"],
        "short"
    );
    call(&r, "history.undo", json!({})).await;
    let undone = read(&r).await;
    assert_eq!(undone["project"], state["project"]);
    let mut cycling = switch(
        json!(clips.iter().map(|e| e["id"].clone()).collect::<Vec<_>>()),
        true,
    );
    cycling["expectedRevision"] = undone["revision"].clone();
    call(&r, "timeline.classic.unified.switch", cycling).await;
    let result = read(&r).await;
    let clips =
        &result["project"]["classic"]["document"]["scenes"][2]["tracks"]["overlay"][0]["elements"];
    assert_eq!(clips[0]["unifiedAngleId"], "video-asset");
    assert_eq!(clips[1]["unifiedAngleId"], "short");
    assert_eq!(clips[2]["unifiedAngleId"], "video-asset");
}
#[tokio::test]
async fn sync_rejects_stale_duplicate_or_partial_audio_results_atomically() {
    let r = fixture().await;
    let state = read(&r).await;
    for sources in [
        json!([sources()[0], sources()[0]]),
        json!([sources()[0]]),
        json!([{ "id":"short","duration":1800,"start":50,"bindingRevision":5},sources()[1]]),
    ] {
        assert!(r.registry().invoke("media.classic.unified.sync",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaId":"unified","sources":sources})).await.is_err());
        assert_eq!(read(&r).await, state);
    }
    sync(&r).await;
    let after = read(&r).await;
    assert!(r.registry().invoke("media.classic.remove",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":after["revision"],"mediaIds":["short"],"cascade":true})).await.is_err());
    assert_eq!(read(&r).await, after);
}
