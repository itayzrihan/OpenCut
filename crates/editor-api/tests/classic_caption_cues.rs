use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const ID: &str = "caption.classic.cues.read";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn attached() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let source = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0]["captionSource"];
    source["settings"] =
        json!({"wordsPerRow":1,"rows":1,"inPaddingPercent":100,"outPaddingPercent":100});
    source["words"] = json!([{"text":"שלום","start":0,"end":0.1,"confidence":0.9,"future":{"keep":true}},{"text":"manual","start":0.2,"end":0.3,"source":{"type":"text-layer","trackId":"manual","elementId":"manual-text","wordIndex":0}},{"text":"עולם","start":1,"end":1.1},{"text":"Again","start":2,"end":2.1}]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn request() -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","trackId":"titles","expectedRevision":1,"limit":1})
}
#[tokio::test]
async fn cue_read_preserves_extensions_and_pages_generated_words_without_state_changes() {
    let r = attached().await;
    let before = call(&r, "app.state.read", json!({})).await;
    let descriptor = r.registry().descriptor(ID).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Read);
    assert!(!descriptor.open_world);
    let mut input = request();
    let first = call(&r, ID, input.clone()).await;
    assert_eq!(first["total"], 3);
    assert_eq!(first["nextOffset"], 1);
    assert_eq!(first["cues"][0]["wordIndices"], json!([0]));
    assert_eq!(first["cues"][0]["words"][0]["future"], json!({"keep":true}));
    assert_eq!(first["cues"][0]["words"][0]["confidence"], 0.9);
    input["offset"] = json!(1);
    let second = call(&r, ID, input.clone()).await;
    assert_eq!(second["cues"][0]["wordIndices"], json!([2]));
    assert!(
        first["cues"][0]["startTime"].as_f64().unwrap()
            + first["cues"][0]["duration"].as_f64().unwrap()
            <= second["cues"][0]["startTime"].as_f64().unwrap()
    );
    input["offset"] = json!(99);
    let empty = call(&r, ID, input).await;
    assert_eq!(empty["cues"], json!([]));
    assert_eq!(empty["nextOffset"], Value::Null);
    assert_eq!(call(&r, "app.state.read", json!({})).await, before);
}
#[tokio::test]
async fn cue_reads_reject_scope_revision_and_bad_paging() {
    let r = attached().await;
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("sceneId", json!("other-scene")),
        ("trackId", json!("video-track")),
        ("expectedRevision", json!(0)),
        ("limit", json!(0)),
        ("limit", json!(501)),
    ] {
        let mut input = request();
        input[field] = value;
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), input)
                .await
                .is_err()
        );
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(r.registry().invoke(ID, cancelled, request()).await.is_err());
}
