use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value {
    rt.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
#[tokio::test]
async fn audio_drafts_share_canonical_state_history_validation_and_revision() {
    let rt = OpenCutRuntime::full_access().unwrap();
    call(&rt, "project.create", json!({"name":"Audio production"})).await;
    let pid = rt.snapshot().unwrap().project.unwrap().id;
    let revision = rt.snapshot().unwrap().revision;
    let draft = json!({"id":"narration","version":1,"title":"שלום","kind":"speech","modelId":"eleven_multilingual_v2","text":"שלום עולם","voiceId":"voice_one","dialogue":[],"instrumental":false});
    let input = json!({"projectId":pid,"expectedRevision":revision,"expectedDraftVersion":null,"draft":draft});
    rt.registry()
        .invoke(
            "project.audio.draft.edit",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(rt.snapshot().unwrap().revision, revision);
    call(&rt, "project.audio.draft.edit", input.clone()).await;
    let state = call(
        &rt,
        "app.state.read",
        json!({"pointer":"/project/extensions/audioProduction/drafts/0"}),
    )
    .await;
    assert_eq!(state["value"]["text"], "שלום עולם");
    assert!(
        rt.registry()
            .invoke(
                "project.audio.draft.edit",
                InvocationContext::default(),
                input.clone()
            )
            .await
            .is_err()
    );
    let mut bad = input;
    bad["expectedRevision"] = json!(rt.snapshot().unwrap().revision);
    bad["draft"]["version"] = json!(2);
    bad["expectedDraftVersion"] = json!(1);
    bad["draft"]["voiceId"] = json!("../../key");
    assert!(
        rt.registry()
            .invoke(
                "project.audio.draft.edit",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err()
    );
    call(&rt, "history.undo", json!({})).await;
    assert!(
        call(&rt, "project.audio.read", json!({"projectId":pid})).await["drafts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
