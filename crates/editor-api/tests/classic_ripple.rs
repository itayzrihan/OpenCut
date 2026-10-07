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
async fn state(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
fn input() -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":1,"beforeTracks":[{"id":"video-track","elements":[{"id":"removed-a","startTime":0,"duration":100001},{"id":"removed-b","startTime":50000,"duration":100001},{"id":"item-2","startTime":150001,"duration":1200000}]},{"id":"titles","elements":[{"id":"text-1","startTime":150001,"duration":120000},{"id":"moved","startTime":0,"duration":20000}]}]})
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    tracks["main"]["elements"][0]["startTime"] = json!(150001);
    // Joined spans subtract occupied space from the coalesced removed range.
    let mut joined = tracks["main"]["elements"][0].clone();
    joined["id"] = json!("joined");
    joined["startTime"] = json!(50000);
    joined["duration"] = json!(20001);
    tracks["main"]["elements"]
        .as_array_mut()
        .unwrap()
        .push(joined);
    tracks["overlay"][0]["elements"][0]["startTime"] = json!(150001);
    let mut moved = tracks["main"]["elements"][0].clone();
    moved["id"] = json!("moved");
    moved["startTime"] = json!(3000000);
    moved["duration"] = json!(20000);
    tracks["main"]["elements"]
        .as_array_mut()
        .unwrap()
        .push(moved);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
#[tokio::test]
async fn ripple_unions_subtracts_joined_and_excludes_moved_clips_with_exact_ticks_and_history() {
    let r = setup().await;
    let before = state(&r).await;
    let request = input();
    let plan = call(&r, "timeline.classic.ripple.plan", request.clone()).await;
    assert_eq!(
        plan["adjustments"],
        json!([{"trackId":"video-track","afterTime":50000,"shiftAmount":50000},{"trackId":"video-track","afterTime":150001,"shiftAmount":80000}])
    );
    assert_eq!(state(&r).await, before);
    let dry = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    r.registry()
        .invoke("timeline.classic.ripple.apply", dry, request.clone())
        .await
        .unwrap();
    assert_eq!(state(&r).await, before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("ripple-once"));
    let receipt = r
        .registry()
        .invoke(
            "timeline.classic.ripple.apply",
            context.clone(),
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke("timeline.classic.ripple.apply", context, request)
            .await
            .unwrap(),
        receipt
    );
    let after = state(&r).await;
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    assert_eq!(tracks["main"]["elements"][0]["startTime"], 20001);
    assert_eq!(tracks["main"]["elements"][1]["startTime"], 0);
    assert_eq!(tracks["main"]["elements"][2]["startTime"], 2870000);
    assert_eq!(tracks["overlay"][0]["elements"][0]["startTime"], 150001);
    let mut preserved =
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]
            .clone();
    preserved["startTime"] = json!(20001);
    assert_eq!(tracks["main"]["elements"][0], preserved);
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","persistableOnly":true}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(state(&reopened).await["project"], before["project"]);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(state(&reopened).await["project"], after["project"]);
}
#[tokio::test]
async fn ripple_rejects_bad_scope_stale_unsafe_duplicate_and_cancelled_snapshots_without_changes() {
    let r = setup().await;
    let before = state(&r).await;
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("sceneId", json!("missing")),
        ("expectedRevision", json!(0)),
        ("beforeTracks", json!([])),
    ] {
        let mut v = input();
        v[field] = value;
        for id in [
            "timeline.classic.ripple.plan",
            "timeline.classic.ripple.apply",
        ] {
            assert!(
                r.registry()
                    .invoke(id, InvocationContext::default(), v.clone())
                    .await
                    .is_err()
            );
        }
    }
    for value in [json!(-1), json!(0.5), json!(9_007_199_254_740_992_i64)] {
        let mut v = input();
        v["beforeTracks"][0]["elements"][0]["startTime"] = value;
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.ripple.apply",
                    InvocationContext::default(),
                    v
                )
                .await
                .is_err()
        );
    }
    let mut v = input();
    v["beforeTracks"][0]["elements"][1]["id"] = json!("removed-a");
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.ripple.apply",
                InvocationContext::default(),
                v
            )
            .await
            .is_err()
    );
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        r.registry()
            .invoke("timeline.classic.ripple.apply", context, input())
            .await
            .is_err()
    );
    assert_eq!(state(&r).await, before);
}
