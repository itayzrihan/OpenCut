use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.crop";
async fn call(r: &OpenCutRuntime, id: &str, v: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), v)
        .await
        .unwrap()
        .result
        .data
}
async fn read(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn fixture(locked: bool) -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let s = &mut c["document"]["scenes"][0];
    s["bookmarks"] = json!([{"time":120000,"note":"before"},{"time":720000,"note":"after"}]);
    s["tracks"]["main"]["locked"] = json!(locked);
    s["tracks"]["main"]["elements"][0]["animations"] = json!({"opacity":{"keys":[{"id":"a","time":0,"value":0,"segmentToNext":"linear"},{"id":"b","time":1200000,"value":1,"segmentToNext":"linear"}]}});
    let text = &mut s["tracks"]["overlay"][0]["elements"][0];
    text["duration"] = json!(1200000);
    text["params"]["content"] = json!("first second");
    text["wordRuns"] = json!([{"id":"w1","text":"first","startTime":0,"endTime":480000,"lineIndex":0},{"id":"w2","text":"second","startTime":720000,"endTime":1080000,"lineIndex":0}]);
    s["tracks"]["overlay"][0]["captionSource"]["words"] =
        json!([{"text":"first","start":0,"end":4},{"text":"second","start":6,"end":9}]);
    let mut audio = s["tracks"]["main"]["elements"][0].clone();
    audio["type"] = json!("audio");
    audio["sourceType"] = json!("upload");
    audio["id"] = json!("audio-1");
    s["tracks"]["audio"] =
        json!([{"id":"audio-track","name":"Audio","type":"audio","elements":[audio],"muted":true}]);
    s["tracks"]["order"]
        .as_array_mut()
        .unwrap()
        .push(json!("audio-track"));
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    r
}
fn input(r: &OpenCutRuntime, edge: &str, time: i64) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"edge":edge,"time":time})
}
#[tokio::test]
async fn all_tracks_sources_captions_curves_bookmarks_history_and_retry() {
    for edge in ["start", "end"] {
        let r = fixture(false).await;
        let before = read(&r).await;
        let request = input(&r, edge, 600000);
        let desc = r.registry().descriptor(ID).unwrap().unwrap();
        assert_eq!(desc.access, AccessLevel::Write);
        assert_eq!(desc.document_support, DocumentSupport::Classic);
        assert!(desc.transactional && desc.supports_dry_run && !desc.open_world);
        r.registry()
            .invoke(
                ID,
                InvocationContext {
                    dry_run: true,
                    ..Default::default()
                },
                request.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read(&r).await, before);
        let mut ctx = InvocationContext::default();
        ctx.metadata
            .insert("opencut/idempotencyKey".into(), json!("crop-once"));
        let result = r
            .registry()
            .invoke(ID, ctx.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(
            r.registry().invoke(ID, ctx, request.clone()).await.unwrap(),
            result
        );
        let after = read(&r).await;
        let scene = &after["project"]["classic"]["document"]["scenes"][0];
        let e = &scene["tracks"]["main"]["elements"][0];
        assert_eq!(e["duration"], 600000);
        assert_eq!(e["startTime"], 0);
        assert_eq!(e["mediaId"], "video-asset");
        assert_eq!(
            e["masks"],
            before["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]
                ["masks"]
        );
        assert_eq!(
            scene["tracks"]["audio"][0]["elements"][0]["duration"],
            600000
        );
        let text = &scene["tracks"]["overlay"][0]["elements"][0];
        if edge == "start" {
            assert_eq!(e["trimStart"], 1230000);
            assert_eq!(e["trimEnd"], 240000);
            assert_eq!(scene["bookmarks"][0]["time"], 120000);
            assert_eq!(text["params"]["content"], "second");
            assert_eq!(e["animations"]["opacity"]["keys"][0]["value"], 0.5);
            assert_eq!(
                scene["tracks"]["overlay"][0]["captionSource"]["words"][0]["start"],
                1.0
            );
        } else {
            assert_eq!(e["trimStart"], 480000);
            assert_eq!(e["trimEnd"], 990000);
            assert_eq!(text["params"]["content"], "first");
        }
        assert_eq!(scene["bookmarks"].as_array().unwrap().len(), 1);
        assert_eq!(
            after["project"]["classic"]["mediaAssets"],
            before["project"]["classic"]["mediaAssets"]
        );
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), request)
                .await
                .is_err()
        );
        call(&r, "history.undo", json!({})).await;
        assert_eq!(read(&r).await["project"], before["project"]);
        call(&r, "history.redo", json!({})).await;
        assert_eq!(read(&r).await["project"], after["project"]);
    }
}
#[tokio::test]
async fn locked_and_invalid_fail_atomically_and_boundaries_clear_or_keep() {
    let r = fixture(true).await;
    let before = read(&r).await;
    assert!(
        r.registry()
            .invoke(ID, InvocationContext::default(), input(&r, "start", 600000))
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    for (edge, time, empty) in [
        ("start", 0, false),
        ("end", 1200000, false),
        ("start", 1200000, true),
        ("end", 0, true),
        ("start", 9000000, true),
    ] {
        let r = fixture(false).await;
        let old = read(&r).await;
        call(&r, ID, input(&r, edge, time)).await;
        let new = read(&r).await;
        if empty {
            let t = &new["project"]["classic"]["document"]["scenes"][0]["tracks"];
            assert!(t["main"]["elements"].as_array().unwrap().is_empty());
            assert!(t["audio"][0]["elements"].as_array().unwrap().is_empty());
        } else {
            assert_eq!(old["project"], new["project"]);
        }
    }
    let r = fixture(false).await;
    let old = read(&r).await;
    for v in [
        input(&r, "start", -1),
        json!({"projectId":"wrong","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"edge":"end","time":5}),
    ] {
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), v)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, old);
    }
}
