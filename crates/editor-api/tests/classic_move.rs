use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.elements.move";
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
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["futureClip"] =
        json!({"linkedAudioId":"audio-42","retain":true});
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn input() -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":1,"moves":[{"sourceTrackId":"video-track","elementId":"item-2","targetTrackId":"new-video","newStartTime":120001}],"createTracks":[{"id":"new-video","type":"video","index":0}]})
}
#[tokio::test]
async fn move_is_atomic_exact_retryable_and_reopens_with_history() {
    let r = setup().await;
    let before = read(&r).await;
    let request = input();
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("move-once"));
    r.registry()
        .invoke(ID, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    context.dry_run = false;
    let receipt = r
        .registry()
        .invoke(ID, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry().invoke(ID, context, request).await.unwrap(),
        receipt
    );
    let after = read(&r).await;
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    assert!(tracks["main"]["elements"].as_array().unwrap().is_empty());
    let moved = &tracks["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "new-video")
        .unwrap()["elements"][0];
    let mut expected =
        before["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]
            .clone();
    expected["startTime"] = json!(120001);
    assert_eq!(*moved, expected);
    assert_eq!(tracks["order"][0], "new-video");
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
    assert_eq!(read(&reopened).await["project"], before["project"]);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], after["project"]);
}
#[tokio::test]
async fn bad_batch_stale_revision_and_global_identity_collisions_leave_no_changes() {
    let r = setup().await;
    let before = read(&r).await;
    let mut cases = vec![];
    let mut v = input();
    v["moves"].as_array_mut().unwrap().push(json!({"sourceTrackId":"titles","elementId":"text-1","targetTrackId":"new-video","newStartTime":0}));
    cases.push(v);
    let mut v = input();
    v["expectedRevision"] = json!(0);
    cases.push(v);
    let mut v = input();
    v["createTracks"][0]["id"] = json!("text-1");
    cases.push(v);
    let mut v = input();
    v["moves"][0]["newStartTime"] = json!(0.5);
    cases.push(v);
    let mut v = input();
    let m = v["moves"][0].clone();
    v["moves"].as_array_mut().unwrap().push(m);
    cases.push(v);
    for v in cases {
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), v)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
}
