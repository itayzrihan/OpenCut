use opencut_editor_api::{HyperframesSource, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}

#[tokio::test]
async fn layer_rows_follow_trim_nested_windows_and_history_without_mutating_state() {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let source: HyperframesSource = serde_json::from_value(json!({"entryFile":"index.html", "files":{"index.html":"<div data-composition-id='main' data-duration='6'></div>"},"resourceAssetIds":{}})).unwrap();
    let layer = |key: &str, parent: Option<&str>, start: f64, duration: f64| {
        json!({
            "key":key,"parentKey":parent,"file":"index.html","elementId":"reused-author-id",
            "label":key,"kind":"element","startSeconds":start,"durationSeconds":duration,
            "trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null
        })
    };
    // Deliberately list a child before its parent: source order is not hierarchy.
    let manifest = json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115","durationSeconds":6,"layers":[
        layer("a/child",Some("a"),0.5,4.0), layer("a",None,0.0,2.0),
        layer("b",None,3.0,2.0), layer("b/child",Some("b"),3.5,4.0),
        layer("before",None,-2.0,1.0)
    ],"diagnostics":[]});
    let imported = call(&runtime,"timeline.hyperframes.import",json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"name":"Compound","source":source,"runtimeManifest":manifest,"startSeconds":8})).await;
    let before = call(&runtime, "app.state.read", json!({})).await["value"].clone();
    let scene_id = before["project"]["classic"]["document"]["currentSceneId"].clone();
    let read = |revision: Value| json!({"projectId":"classic-project","sceneId":scene_id,"elementId":imported["itemId"],"expectedRevision":revision});
    let initial = call(
        &runtime,
        "hyperframes.layers.timeline.read",
        read(before["revision"].clone()),
    )
    .await;
    let rows = initial["clip"]["rows"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a", "a/child", "b", "b/child"]
    );
    assert_eq!(rows[0]["startTime"], 960_000);
    assert_eq!(rows[1]["startTime"], 1_020_000);
    assert_eq!(rows[1]["duration"], 180_000); // clipped to parent at source 2s
    assert_eq!(rows[1]["depth"], 1);
    assert_eq!(rows[3]["sourceEndSeconds"], 5.0);
    assert_eq!(initial["clip"]["trackId"], imported["trackId"]);
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"],
        before
    );

    let mut edited = before["project"]["classic"].clone();
    let scene = edited["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|scene| scene["id"] == scene_id)
        .unwrap();
    let track = scene["tracks"]["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|track| track["id"] == imported["trackId"])
        .unwrap();
    let element = &mut track["elements"][0];
    element["startTime"] = json!(240_000);
    element["trimStart"] = json!(180_000);
    element["duration"] = json!(240_000);
    element["trimEnd"] = json!(300_000);
    element["hidden"] = json!(true); // visibility does not hide the editable structure
    call(&runtime,"project.classic.commit",json!({"projectId":"classic-project","expectedRevision":before["revision"],"classic":edited})).await;
    let revision = json!(runtime.snapshot().unwrap().revision);
    let trimmed = call(
        &runtime,
        "hyperframes.layers.timeline.read",
        read(revision.clone()),
    )
    .await;
    let rows = trimmed["clip"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3); // b/child begins exactly at the clip's exclusive end
    assert_eq!(rows[0]["startTime"], 240_000);
    assert_eq!(rows[0]["duration"], 60_000);
    assert_eq!(rows[1]["startTime"], 240_000);
    assert_eq!(rows[1]["sourceStartSeconds"], 1.5);
    assert_eq!(rows[2]["startTime"], 420_000);
    assert_eq!(rows[2]["duration"], 60_000);
    for (field, value) in [
        ("projectId", json!("other")),
        ("sceneId", json!("missing")),
        ("elementId", json!("missing")),
        ("expectedRevision", before["revision"].clone()),
    ] {
        let mut input = read(revision.clone());
        input[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.layers.timeline.read",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
    }
    call(&runtime, "history.undo", json!({})).await;
    let undo = call(
        &runtime,
        "hyperframes.layers.timeline.read",
        read(json!(runtime.snapshot().unwrap().revision)),
    )
    .await;
    assert_eq!(undo["clip"], initial["clip"]);
    call(&runtime, "history.redo", json!({})).await;
    let redo = call(
        &runtime,
        "hyperframes.layers.timeline.read",
        read(json!(runtime.snapshot().unwrap().revision)),
    )
    .await;
    assert_eq!(redo["clip"], trimmed["clip"]);
}
