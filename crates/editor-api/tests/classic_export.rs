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
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let clip = c["document"]["scenes"][0]["tracks"]["main"]["elements"][0].clone();
    let mut clips = Vec::new();
    let mut assets = Vec::new();
    for (id, w, h, duration, kind, enabled) in [
        ("camera", 3840, 2160, 120000000, "video", true),
        ("insert", 1280, 720, 1200000, "video", true),
        ("short8k", 7680, 4320, 120000, "video", true),
        ("photo", 16000, 9000, 120000000, "image", true),
        ("disabled8k", 7680, 4320, 120000000, "video", false),
    ] {
        let mut e = clip.clone();
        e["id"] = json!(id);
        e["mediaId"] = json!(id);
        e["duration"] = json!(duration);
        e["type"] = json!(kind);
        e["enabled"] = json!(enabled);
        e["params"] = json!({"transform.scaleX":1,"transform.scaleY":1});
        clips.push(e);
        assets.push(json!({"id":id,"name":id,"type":kind,"width":w,"height":h,"duration":2000}));
    }
    c["mediaAssets"] = json!(assets);
    c["document"]["scenes"][0]["tracks"]["main"]["elements"] = json!(clips);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    r
}
async fn state(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}

#[tokio::test]
async fn unknown_dimensions_fall_back_and_portrait_compositions_keep_their_shape() {
    for (canvas, dimensions, expected) in [
        (json!({"width":1920,"height":1080}), json!({}), (1920, 1080)),
        (
            json!({"width":1080,"height":1920}),
            json!({"width":2160,"height":3840}),
            (2160, 3840),
        ),
    ] {
        let r = OpenCutRuntime::default();
        let mut c: Value =
            serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
        c["document"]["settings"]["canvasSize"] = canvas;
        for (key, value) in dimensions.as_object().unwrap() {
            c["mediaAssets"][0][key] = value.clone();
        }
        call(
            &r,
            "project.classic.session.attach",
            json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
        )
        .await;
        let p = call(
            &r,
            "project.classic.export.plan",
            request(&r, "source", "compact").await,
        )
        .await;
        assert_eq!(
            (p["width"].as_u64().unwrap(), p["height"].as_u64().unwrap()),
            expected
        );
        if dimensions.as_object().unwrap().is_empty() {
            assert!(!p["warnings"].as_array().unwrap().is_empty());
        }
        let mut high_fps = request(&r, "source", "compact").await;
        high_fps["fps"] = json!({"numerator":60,"denominator":1});
        let high = call(&r, "project.classic.export.plan", high_fps).await;
        assert_eq!(
            high["videoBitrate"].as_u64().unwrap(),
            p["videoBitrate"].as_u64().unwrap() * 2
        );
    }
}
async fn request(r: &OpenCutRuntime, resolution: &str, encoding: &str) -> Value {
    json!({"projectId":"classic-project","expectedRevision":state(r).await["revision"],"sceneId":"main-scene","preferences":{"resolution":resolution,"encoding":encoding},"quality":"very_high","format":"mp4"})
}
#[tokio::test]
async fn dominant_source_ignores_short_inserts_photos_and_disabled_cameras() {
    let r = setup().await;
    let before = state(&r).await;
    let plan = call(
        &r,
        "project.classic.export.plan",
        request(&r, "source", "compact").await,
    )
    .await;
    assert_eq!(plan["width"], 3840);
    assert_eq!(plan["height"], 2160);
    assert_eq!(plan["logicalWidth"], 1920);
    assert_eq!(plan["codec"], "hevc");
    assert_eq!(plan["videoBitrate"], 32000000);
    assert_eq!(plan["upscaledSources"], json!(["insert"]));
    assert_eq!(state(&r).await, before);
    let compatible = call(
        &r,
        "project.classic.export.plan",
        request(&r, "source", "compatible").await,
    )
    .await;
    assert_eq!(compatible["videoBitrate"], 48000000);
    let project = call(
        &r,
        "project.classic.export.plan",
        request(&r, "project", "compact").await,
    )
    .await;
    assert_eq!(project["width"], 1920);
}
#[tokio::test]
async fn export_preferences_are_validated_persisted_and_undoable() {
    let r = setup().await;
    let before = state(&r).await;
    let prefs = json!({"resolution":"source","encoding":"compact"});
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"settings":{"exportPreferences":prefs}});
    r.registry()
        .invoke(
            "project.classic.settings.update",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(state(&r).await, before);
    call(&r, "project.classic.settings.update", input).await;
    let after = state(&r).await;
    assert_eq!(
        after["project"]["classic"]["document"]["settings"]["exportPreferences"],
        prefs
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"],
        before["project"]["classic"]["document"]["scenes"]
    );
    let bad = json!({"projectId":"classic-project","expectedRevision":after["revision"],"settings":{"exportPreferences":{"resolution":"invented","encoding":"compact"}}});
    assert!(
        r.registry()
            .invoke(
                "project.classic.settings.update",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err()
    );
    let stale = request(&r, "source", "compact").await;
    call(&r, "history.undo", json!({})).await;
    assert_eq!(
        state(&r).await["project"]["classic"]["document"]["settings"],
        before["project"]["classic"]["document"]["settings"]
    );
    assert!(
        r.registry()
            .invoke(
                "project.classic.export.plan",
                InvocationContext::default(),
                stale
            )
            .await
            .is_err()
    );
}
