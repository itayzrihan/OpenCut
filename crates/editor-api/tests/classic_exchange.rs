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
async fn source() -> OpenCutRuntime {
    let rt = OpenCutRuntime::default();
    call(&rt,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":serde_json::from_str::<Value>(include_str!("fixtures/classic-project.json")).unwrap()})).await;
    call(&rt,"project.production.edit",json!({"projectId":"classic-project","expectedRevision":1,"change":{"type":"importScript","rowIdPrefix":"source","text":"שלום לעולם","sourceLanguage":"he","defaultDurationMs":4000}})).await;
    call(&rt,"project.production.edit",json!({"projectId":"classic-project","expectedRevision":2,"change":{"type":"createReferenceSlot","slotId":"reference","label":"Original reference"}})).await;
    call(&rt, "history.undo", json!({})).await;
    rt
}

#[tokio::test]
async fn exchange_preserves_full_history_and_extensions_without_mutating_source() {
    let rt = source().await;
    let before = rt.snapshot().unwrap();
    let archive = call(
        &rt,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","compact":true,"chained":true}),
    )
    .await;
    let result=call(&rt,"project.classic.exchange.prepare",json!({"projectId":"classic-project","expectedRevision":archive["revision"],"archive":archive,"destinationProjectId":"imported-project"})).await;
    assert_eq!(rt.snapshot().unwrap(), before);
    assert_eq!(result["archive"]["projectId"], "imported-project");
    assert_eq!(result["archive"]["historyEncoding"], "full");
    assert_eq!(result["archive"]["undoStack"].as_array().unwrap().len(), 1);
    assert_eq!(result["archive"]["redoStack"].as_array().unwrap().len(), 1);
    assert!(result["mediaAssets"][0].get("sourcePath").is_none());
    assert_eq!(result["mediaAssets"][0]["missing"], true);
    let imported = OpenCutRuntime::default();
    call(
        &imported,
        "project.classic.session.restore",
        json!({"projectId":"imported-project","expectedRevision":0,"archive":result["archive"]}),
    )
    .await;
    let read = call(
        &imported,
        "app.state.read",
        json!({"pointer":"/project/extensions/productionStudio"}),
    )
    .await;
    assert_eq!(
        read["value"]["scriptRows"][0]["versions"][0]["sourceText"],
        "שלום לעולם"
    );
    call(&imported, "history.redo", json!({})).await;
    assert_eq!(
        call(
            &imported,
            "app.state.read",
            json!({"pointer":"/project/extensions/productionStudio/referenceSlots/0/label"})
        )
        .await["value"],
        "Original reference"
    );
    call(&imported, "history.undo", json!({})).await;
    call(&imported, "history.undo", json!({})).await;
    assert_eq!(
        imported.snapshot().unwrap().project.unwrap().id,
        "imported-project"
    );
}

#[tokio::test]
async fn exchange_rejects_bad_scope_revision_and_invalid_history_before_any_effect() {
    let rt = source().await;
    let archive = call(
        &rt,
        "project.classic.session.archive",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let before = rt.snapshot().unwrap();
    for input in [
        json!({"projectId":"wrong","archive":archive}),
        json!({"projectId":"classic-project","expectedRevision":999,"archive":archive}),
        json!({"projectId":"classic-project","archive":archive,"destinationProjectId":"classic-project"}),
    ] {
        assert!(
            rt.registry()
                .invoke(
                    "project.classic.exchange.prepare",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
    }
    let mut invalid = archive.clone();
    invalid["redoStack"][0]["classic"]["projectExtensions"]["productionStudio"]["scriptRows"][0]
        ["versions"][0]["endMs"] = 0.into();
    assert!(
        rt.registry()
            .invoke(
                "project.classic.exchange.prepare",
                InvocationContext::default(),
                json!({"projectId":"classic-project","archive":invalid})
            )
            .await
            .is_err()
    );
    assert_eq!(rt.snapshot().unwrap(), before);
    let mut changed_binding = archive;
    changed_binding["undoStack"][0]["classic"]["mediaAssets"][0]["bindingRevision"] = 2.into();
    let error = rt
        .registry()
        .invoke(
            "project.classic.exchange.prepare",
            InvocationContext::default(),
            json!({"projectId":"classic-project","archive":changed_binding}),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("different original file versions")
    );
    assert_eq!(rt.snapshot().unwrap(), before);
}
