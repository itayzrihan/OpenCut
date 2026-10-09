use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const SETTINGS: &str = "project.classic.settings.update";
async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["settings"]["futureSetting"] = json!({"preserve":true});
    classic["document"]["settings"]["background"]["futureRendering"] = json!({"preserve":true});
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, settings: Value) -> Value {
    json!({"projectId":"classic-project", "expectedRevision":state["revision"], "settings":settings})
}
async fn edit(runtime: &OpenCutRuntime, settings: Value, group: Option<&str>) -> Value {
    let mut request = input(&read(runtime).await, settings);
    if let Some(group) = group {
        request["historyGroup"] = json!(group);
    }
    call(runtime, SETTINGS, request).await;
    read(runtime).await
}

#[tokio::test]
async fn settings_preserve_complete_document_sync_projection_and_reopen_with_undo() {
    let runtime = attached().await;
    let original = read(&runtime).await;
    let settings = json!({
        "fps":{"numerator":60000,"denominator":1001},
        "canvasSize":{"width":1080,"height":1920},
        "canvasSizeMode":"preset",
        "lastCustomCanvasSize":{"width":1440,"height":1440},
        "originalCanvasSize":null,
        "background":{"type":"color","color":"linear-gradient(90deg, #000, #fff)"}
    });
    let request = input(&original, settings.clone());
    runtime
        .registry()
        .invoke(
            SETTINGS,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, original);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("settings-edit"));
    let receipt = runtime
        .registry()
        .invoke(SETTINGS, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(SETTINGS, context, request)
            .await
            .unwrap(),
        receipt
    );
    let edited = read(&runtime).await;
    assert_eq!(edited["project"]["settings"]["width"], 1080);
    assert_eq!(edited["project"]["settings"]["height"], 1920);
    assert_eq!(
        edited["project"]["settings"]["frameRateRational"],
        settings["fps"]
    );
    let mut expected = original["project"]["classic"].clone();
    expected["document"]["settings"]
        .as_object_mut()
        .unwrap()
        .extend(settings.as_object().unwrap().clone());
    expected["document"]["metadata"]["updatedAt"] =
        edited["project"]["classic"]["document"]["metadata"]["updatedAt"].clone();
    assert_eq!(edited["project"]["classic"], expected);
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(read(&reopened).await["project"], edited["project"]);
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], original["project"]);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], edited["project"]);
    let descriptor = runtime.registry().descriptor(SETTINGS).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(!descriptor.open_world);
}

#[tokio::test]
async fn gesture_coalesces_committed_previews_but_never_swallows_an_intervening_edit_or_undo() {
    let runtime = attached().await;
    let original = read(&runtime).await;
    for color in ["#111111", "#222222", "#333333"] {
        edit(
            &runtime,
            json!({"background":{"type":"color","color":color}}),
            Some("picker"),
        )
        .await;
    }
    let final_color = read(&runtime).await;
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], original["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], final_color["project"]);
    let after_undo_redo = edit(
        &runtime,
        json!({"background":{"type":"blur","blurIntensity":500}}),
        Some("picker"),
    )
    .await;
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], final_color["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after_undo_redo["project"]);
    let revision = read(&runtime).await["revision"].clone();
    call(&runtime, "project.classic.scenes.edit", json!({"projectId":"classic-project","expectedRevision":revision,"change":{"type":"rename","sceneId":"main-scene","name":"Intervening edit"}})).await;
    let renamed = read(&runtime).await;
    edit(
        &runtime,
        json!({"background":{"type":"color","color":"#fff"}}),
        Some("picker"),
    )
    .await;
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], renamed["project"]);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after_undo_redo["project"]);
}

#[tokio::test]
async fn settings_reject_invalid_input_targets_and_generic_commit_without_mutation() {
    let runtime = attached().await;
    let original = read(&runtime).await;
    for settings in [
        json!({}),
        json!({"unknown":true}),
        json!({"fps":null,"canvasSizeMode":"custom"}),
        json!({"fps":{"numerator":0,"denominator":1}}),
        json!({"fps":{"numerator":30,"denominator":0}}),
        json!({"canvasSize":{"width":0,"height":1080}}),
        json!({"canvasSize":{"width":1.5,"height":1}}),
        json!({"canvasSizeMode":"invalid"}),
        json!({"canvasSizeMode":null,"background":{"type":"blur","blurIntensity":5}}),
        json!({"lastCustomCanvasSize":{"width":-1,"height":1}}),
        json!({"background":{"type":"blur","blurIntensity":-1}}),
        json!({"background":{"type":"color","color":" "}}),
        json!({"background":{"type":"video","color":"#fff"}}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    SETTINGS,
                    InvocationContext::default(),
                    input(&original, settings)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, original);
    }
    for (key, value) in [
        ("projectId", json!("other")),
        ("expectedRevision", json!(0)),
        ("historyGroup", json!("")),
    ] {
        let mut request = input(&original, json!({"canvasSizeMode":"custom"}));
        request[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(SETTINGS, InvocationContext::default(), request)
                .await
                .is_err()
        );
    }
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(
                SETTINGS,
                cancelled,
                input(&original, json!({"canvasSizeMode":"custom"}))
            )
            .await
            .is_err()
    );
    let mut classic = original["project"]["classic"].clone();
    classic["document"]["settings"]["background"] = json!({"type":"blur","blurIntensity":-1});
    assert!(runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":original["revision"],"classic":classic})).await.is_err());
    assert_eq!(read(&runtime).await, original);
    let remembered = edit(&runtime, json!({"originalCanvasSize":{"width":1920,"height":1080},"lastCustomCanvasSize":{"width":500,"height":500}}), None).await;
    let cleared = edit(&runtime, json!({"lastCustomCanvasSize":null}), None).await;
    assert!(
        cleared["project"]["classic"]["document"]["settings"]["lastCustomCanvasSize"].is_null()
    );
    assert_eq!(
        cleared["project"]["classic"]["document"]["settings"]["originalCanvasSize"],
        remembered["project"]["classic"]["document"]["settings"]["originalCanvasSize"]
    );
}
