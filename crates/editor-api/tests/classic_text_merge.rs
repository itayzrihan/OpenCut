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
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let track = &mut classic["document"]["scenes"][0]["tracks"]["overlay"][0];
    track["elements"][0]["params"]["content"] = json!("שלום");
    track["elements"][0]["wordRuns"][0]["startTime"] = json!(7);
    track["elements"][0]["wordRuns"][0]["endTime"] = json!(100003);
    track["elements"][0]["wordRuns"][0]["style"] = json!({"color":"red"});
    track["elements"][0]["textRowOverrides"] =
        json!([{"id":"row-source","lineIndex":0,"params":{"opacity":0.8}}]);
    track["elements"][0]["transitions"] =
        json!({"out":{"id":"out","presetId":"fade","duration":24000,"startTime":96000}});
    let mut second = track["elements"][0].clone();
    second["id"] = json!("second-text");
    second["startTime"] = json!(120003);
    second["duration"] = json!(120000);
    second["params"]["content"] = json!("עולם הבא");
    second.as_object_mut().unwrap().remove("wordRuns");
    track["elements"].as_array_mut().unwrap().push(second);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn input(r: &OpenCutRuntime, mode: &str) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"mode":mode,"elements":[{"trackId":"titles","elementId":"second-text"},{"trackId":"titles","elementId":"text-1"}]})
}
async fn tracks(r: &OpenCutRuntime) -> Value {
    call(
        r,
        "app.state.read",
        json!({"pointer":"/project/classic/document/scenes/0/tracks"}),
    )
    .await["value"]
        .clone()
}
#[tokio::test]
async fn merge_modes_preserve_styled_words_row_identity_generated_transcript_and_reopened_history()
{
    for mode in ["single-line", "multiline"] {
        let r = setup().await;
        let before = tracks(&r).await;
        let result = call(&r, "timeline.classic.text.merge", input(&r, mode)).await;
        assert_eq!(result["target"]["elementId"], "text-1");
        assert_eq!(result["removed"][0]["elementId"], "second-text");
        let after = tracks(&r).await;
        let merged = &after["overlay"][0]["elements"][0];
        assert_eq!(after["overlay"][0]["elements"].as_array().unwrap().len(), 1);
        assert_eq!(merged["duration"], 240003);
        assert_eq!(merged["wordRuns"][0]["id"], "word-0");
        assert_eq!(merged["wordRuns"][0]["style"]["color"], "red");
        assert_eq!(merged["textRowOverrides"][0]["id"], "row-0");
        assert_eq!(merged["transitions"]["out"]["startTime"], 216003);
        assert_eq!(
            after["overlay"][0]["captionSource"],
            before["overlay"][0]["captionSource"]
        );
        assert_eq!(after["main"], before["main"]);
        if mode == "single-line" {
            assert_eq!(merged["params"]["content"], "שלום עולם הבא");
            assert_eq!(merged["wordRuns"][0]["startTime"], 7);
            assert_eq!(merged["wordRuns"][1]["startTime"], 120003);
            assert_eq!(merged["wordRuns"][2]["endTime"], 240003);
        } else {
            assert_eq!(merged["params"]["content"], "שלום\nעולם הבא");
            assert!(merged["wordRuns"][0].get("startTime").is_none());
            assert_eq!(merged["captionWordAnimationId"], "none");
            assert_eq!(merged["captionRevealMode"], "row");
        }
        let archive = call(
            &r,
            "project.classic.session.archive",
            json!({"projectId":"classic-project","persistableOnly":true}),
        )
        .await;
        let reopened = OpenCutRuntime::full_access().unwrap();
        call(
            &reopened,
            "project.classic.session.restore",
            json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
        )
        .await;
        call(&reopened, "history.undo", json!({})).await;
        assert_eq!(tracks(&reopened).await, before);
        call(&reopened, "history.redo", json!({})).await;
        assert_eq!(tracks(&reopened).await, after);
    }
}
#[tokio::test]
async fn merge_rejects_invalid_batch_scope_revision_duplicates_and_cancel_without_partial_edit() {
    let r = setup().await;
    let before = r.snapshot().unwrap();
    let baseline = input(&r, "single-line");
    for (pointer, value) in [
        ("/projectId", json!("foreign")),
        ("/sceneId", json!("missing")),
        ("/expectedRevision", json!(0)),
        ("/elements/1/elementId", json!("missing")),
        ("/elements/1/elementId", json!("second-text")),
        ("/elements/1/trackId", json!("video-track")),
        ("/mode", json!("unknown")),
    ] {
        let mut input = baseline.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.text.merge",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
        assert_eq!(r.snapshot().unwrap(), before);
    }
    let context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    let result = r
        .registry()
        .invoke("timeline.classic.text.merge", context, baseline.clone())
        .await
        .unwrap();
    assert_eq!(result.result.data["committed"], false);
    assert_eq!(r.snapshot().unwrap(), before);
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        r.registry()
            .invoke("timeline.classic.text.merge", context, baseline)
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
}
