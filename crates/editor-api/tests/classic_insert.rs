use opencut_editor_api::{
    AccessLevel, ClassicAnimationGroup, DocumentSupport, InvocationContext, OpenCutRuntime,
};
use serde_json::{Value, json};
const ID: &str = "timeline.classic.elements.insert";
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
async fn attached(empty: bool) -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"][0]["width"] = json!(1280);
    classic["mediaAssets"][0]["height"] = json!(720);
    classic["mediaAssets"][0]["fps"] = json!(29.97);
    classic["mediaAssets"].as_array_mut().unwrap().push(json!({"id":"image-asset","name":"Image","type":"image","width":800,"height":600,"missing":true}));
    if empty {
        classic["document"]["scenes"][0]["tracks"]["main"]["elements"] = json!([]);
        classic["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"] = json!([]);
    }
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let groups:Vec<ClassicAnimationGroup>=serde_json::from_value(json!([{"target":{"kind":"element","elementType":"graphic","definitionId":"future-graphic","pathPrefix":"params."},"params":[]}])).unwrap();
    r.classic_animation_catalog().replace(groups).unwrap();
    r
}
fn request(state: &Value, clips: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"clips":clips})
}
fn draft(kind: &str) -> Value {
    let mut value = json!({"type":kind,"name":format!("New {kind}"),"startTime":240000,"params":{},"future":{"keep":true}});
    match kind {
        "video" => value["mediaId"] = json!("video-asset"),
        "image" => value["mediaId"] = json!("image-asset"),
        "audio" => {
            value["sourceType"] = json!("library");
            value["libraryAssetId"] = json!("song");
        }
        "text" => value["params"]["content"] = json!("שלום עולם"),
        "sticker" => value["stickerId"] = json!("icon:test"),
        "graphic" => value["definitionId"] = json!("future-graphic"),
        "effect" => value["effectType"] = json!("future-effect"),
        _ => {}
    }
    value
}
#[tokio::test]
async fn all_clip_types_insert_read_back_with_atomic_batch_preview_retries_and_undo() {
    let r = attached(false).await;
    let before = read(&r).await;
    let catalog = call(
        &r,
        "timeline.classic.elements.catalog",
        json!({"projectId":"classic-project","expectedRevision":before["revision"]}),
    )
    .await;
    assert_eq!(catalog["graphics"][0]["definitionId"], "future-graphic");
    assert_eq!(read(&r).await, before);
    let mut input = request(
        &before,
        json!(
            [
                "video", "image", "audio", "text", "sticker", "graphic", "effect"
            ]
            .map(|kind| json!({"element":draft(kind),"placement":{"mode":"auto"}}))
        ),
    );
    input["catalogRevision"] = catalog["catalogRevision"].clone();
    let descriptor = r.registry().descriptor(ID).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(descriptor.transactional && descriptor.supports_dry_run && !descriptor.open_world);
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("insert-once"));
    let preview = r
        .registry()
        .invoke(ID, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(preview.result.data["elements"].as_array().unwrap().len(), 7);
    assert_eq!(read(&r).await, before);
    context.dry_run = false;
    let receipt = r
        .registry()
        .invoke(ID, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke(ID, context, input.clone())
            .await
            .unwrap(),
        receipt
    );
    let after = read(&r).await;
    let refs = receipt.result.data["elements"].as_array().unwrap();
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    for reference in refs {
        let track = tracks["overlay"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&tracks["main"]))
            .chain(tracks["audio"].as_array().unwrap())
            .find(|t| t["id"] == reference["trackId"])
            .unwrap();
        let clip = track["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == reference["elementId"])
            .unwrap();
        assert_eq!(clip["duration"], 600000);
        assert_eq!(clip["trimStart"], 0);
        assert_eq!(clip["future"], json!({"keep":true}));
    }
    assert_eq!(
        after["project"]["classic"]["mediaAssets"],
        before["project"]["classic"]["mediaAssets"]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][1],
        before["project"]["classic"]["document"]["scenes"][1]
    );
    assert!(
        r.registry()
            .invoke(ID, InvocationContext::default(), input)
            .await
            .is_err()
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
}
#[tokio::test]
async fn first_visual_clip_adopts_canvas_and_fps_as_one_undoable_edit() {
    for kind in ["video", "image"] {
        let r = attached(true).await;
        let before = read(&r).await;
        let input = request(
            &before,
            json!([{"element":draft(kind),"placement":{"mode":"explicit","trackId":"video-track"}}]),
        );
        call(&r, ID, input).await;
        let after = read(&r).await;
        let doc = &after["project"]["classic"]["document"];
        assert_eq!(
            doc["scenes"][0]["tracks"]["main"]["elements"][0]["startTime"],
            0
        );
        let size = if kind == "video" {
            json!({"width":1280,"height":720})
        } else {
            json!({"width":800,"height":600})
        };
        assert_eq!(doc["settings"]["canvasSize"], size);
        assert_eq!(doc["settings"]["originalCanvasSize"], size);
        assert_eq!(
            doc["settings"]["fps"],
            if kind == "video" {
                json!({"numerator":30000,"denominator":1001})
            } else {
                before["project"]["classic"]["document"]["settings"]["fps"].clone()
            }
        );
        call(&r, "history.undo", json!({})).await;
        assert_eq!(read(&r).await["project"], before["project"]);
    }
}
#[tokio::test]
async fn insertion_rejects_bad_tail_scope_timing_bindings_and_stale_graphic_catalog_atomically() {
    let r = attached(false).await;
    let before = read(&r).await;
    let valid = json!({"element":draft("video"),"placement":{"mode":"auto"}});
    for invalid in [
        json!({"element":draft("video"),"placement":{"mode":"explicit","trackId":"titles"}}),
        json!({"element":draft("graphic"),"placement":{"mode":"auto"}}),
        json!({"element":{"type":"text","name":"Bad","startTime":0,"params":{}},"placement":{"mode":"auto"}}),
        json!({"element":{"type":"video","name":"Missing","mediaId":"missing","startTime":0},"placement":{"mode":"auto"}}),
        json!({"element":{"type":"sticker","name":"Bad","startTime":-1,"stickerId":"icon:test"},"placement":{"mode":"auto"}}),
        json!({"element":{"type":"sticker","name":"Bad","startTime":0.5,"stickerId":"icon:test"},"placement":{"mode":"auto"}}),
        json!({"element":{"type":"sticker","name":"Bad","startTime":0,"id":"external","stickerId":"icon:test"},"placement":{"mode":"auto"}}),
    ] {
        assert!(
            r.registry()
                .invoke(
                    ID,
                    InvocationContext::default(),
                    request(&before, json!([valid, invalid]))
                )
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let input = request(&before, json!([valid]));
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("sceneId", json!("other-scene-missing")),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = input.clone();
        invalid[field] = value;
        assert!(
            r.registry()
                .invoke(ID, InvocationContext::default(), invalid)
                .await
                .is_err()
        );
        assert_eq!(read(&r).await, before);
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        r.registry()
            .invoke(ID, cancelled, input.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&r).await, before);
    let clean = attached(false).await;
    assert_eq!(
        call(&r, ID, input.clone()).await["elements"],
        call(&clean, ID, input).await["elements"]
    );
}
