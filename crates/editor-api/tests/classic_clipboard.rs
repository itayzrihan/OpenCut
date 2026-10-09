use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup(empty: bool) -> OpenCutRuntime {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0]["params"]["content"] =
        json!("שלום");
    let clips = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"];
    clips[0]["animations"] = json!({"opacity":{"keys":[{"id":"source-key","time":0,"value":0.5,"interpolation":"linear"}]}});
    let mut second = clips[0].clone();
    second["id"] = json!("second");
    second["startTime"] = json!(1200003);
    second["duration"] = json!(123);
    second.as_object_mut().unwrap().remove("animations");
    clips.as_array_mut().unwrap().push(second);
    if empty {
        *clips = json!([]);
    }
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    r
}
fn copy_input(r: &OpenCutRuntime) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"elements":[{"trackId":"video-track","elementId":"item-2"},{"trackId":"video-track","elementId":"second"}]})
}
fn paste_input(r: &OpenCutRuntime, items: Value, time: i64) -> Value {
    json!({"projectId":"classic-project","sourceProjectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"time":time,"items":items})
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
async fn clipboard_read_and_grouped_paste_preserve_ticks_fields_and_independent_identity_with_history()
 {
    let r = setup(false).await;
    let before = r.snapshot().unwrap();
    assert_eq!(r.registry().descriptor("clipboard.classic.elements.copy").unwrap().unwrap().access, AccessLevel::Read);
    let copy = r
        .registry()
        .invoke(
            "clipboard.classic.elements.copy",
			InvocationContext::default(),
            copy_input(&r),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(r.snapshot().unwrap(), before);
    assert_eq!(copy["sourceProjectId"], "classic-project");
    assert!(copy["items"][0]["element"].get("id").is_none());
    let pasted = call(
        &r,
        "timeline.classic.elements.paste",
        paste_input(&r, copy["items"].clone(), 7),
    )
    .await;
    let after = tracks(&r).await;
    let target = pasted["elements"][0]["trackId"].as_str().unwrap();
    assert_eq!(after["order"][0], target);
    let clips = &after["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == target)
        .unwrap()["elements"];
    assert_eq!(clips[0]["startTime"], 7);
    assert_eq!(clips[1]["startTime"], 1200010);
    assert_eq!(clips[0]["retime"], copy["items"][0]["element"]["retime"]);
    assert_eq!(clips[0]["masks"], copy["items"][0]["element"]["masks"]);
    assert_eq!(clips[0]["effects"], copy["items"][0]["element"]["effects"]);
    assert_ne!(
        clips[0]["animations"]["opacity"]["keys"][0]["id"],
        "source-key"
    );
    assert_ne!(clips[0]["id"], "item-2");
    assert_eq!(
        after["main"],
        before
            .project
            .as_ref()
            .unwrap()
            .classic
            .as_ref()
            .unwrap()
            .document["scenes"][0]["tracks"]["main"]
    );
    let reopened = OpenCutRuntime::full_access().unwrap();
    let archive = call(&r, "project.classic.session.archive", json!({"projectId":"classic-project","persistableOnly":true})).await;
    call(&reopened, "project.classic.session.restore", json!({"projectId":"classic-project","expectedRevision":0,"archive":archive})).await;
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(
        tracks(&reopened).await,
        before
            .project
            .as_ref()
            .unwrap()
            .classic
            .as_ref()
            .unwrap()
            .document["scenes"][0]["tracks"]
    );
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(tracks(&reopened).await, after);
    let empty = setup(true).await;
    let result = call(
        &empty,
        "timeline.classic.elements.paste",
        paste_input(&empty, copy["items"].clone(), 500),
    )
    .await;
    assert_eq!(result["elements"][0]["trackId"], "video-track");
    assert_eq!(tracks(&empty).await["main"]["elements"][0]["startTime"], 0);
    assert_eq!(
        tracks(&empty).await["main"]["elements"][1]["startTime"],
        1200003
    );
}
#[tokio::test]
async fn clipboard_rejects_scope_binary_handles_bad_media_fractional_ticks_overflow_and_partial_batch()
 {
    let r = setup(false).await;
    let copy = call(&r, "clipboard.classic.elements.copy", copy_input(&r)).await;
    let before = r.snapshot().unwrap();
    let baseline = paste_input(&r, copy["items"].clone(), 1);
    for (pointer, value) in [
        ("/sourceProjectId", json!("another-project")),
        ("/projectId", json!("wrong")),
        ("/sceneId", json!("missing")),
        ("/expectedRevision", json!(0)),
        ("/time", json!(1.5)),
        ("/time", json!(9007199254740991i64)),
        ("/items/1/element/mediaId", json!("foreign")),
        ("/items/1/element/duration", json!(-1)),
        ("/items/1/trackType", json!("text")),
    ] {
        let mut input = baseline.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.elements.paste",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err(),
            "{pointer}"
        );
        assert_eq!(r.snapshot().unwrap(), before);
    }
    for key in ["id", "file", "buffer"] {
        let mut input = baseline.clone();
        input["items"][1]["element"][key] = json!("forbidden");
        assert!(
            r.registry()
                .invoke(
                    "timeline.classic.elements.paste",
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
    let preview = r
        .registry()
        .invoke("timeline.classic.elements.paste", context, baseline.clone())
        .await
        .unwrap();
    assert_eq!(preview.result.data["committed"], false);
    assert_eq!(r.snapshot().unwrap(), before);
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        r.registry()
            .invoke("timeline.classic.elements.paste", context, baseline.clone())
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
    let mut oversized = baseline;
    oversized["items"][0]["element"]["name"] = json!("a".repeat(1024 * 1024));
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.elements.paste",
                InvocationContext::default(),
                oversized
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap(), before);
}
