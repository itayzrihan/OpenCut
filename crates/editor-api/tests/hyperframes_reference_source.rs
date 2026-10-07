use opencut_editor_api::{
    HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime, hyperframes_reference_source,
    register_hyperframes_reference_source,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};

const COMMIT: &str = "4c4b8574406cc566d28778a13f22c072d727a871";
fn request() -> Value {
    json!({"projectId":"classic-project","expectedRevision":1,"id":"lt-clean-bar","upstreamCommit":COMMIT,"filePath":"registry-item.json","offset":0,"limit":21})
}
fn source(request: &Value) -> String {
    let plan = hyperframes_reference_source(request.clone(), None).unwrap();
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/hyperframes")
            .join(plan["relativePath"].as_str().unwrap()),
    )
    .unwrap()
}

#[test]
fn source_paging_reconstructs_exact_pinned_bytes_and_rejects_corruption() {
    let mut input = request();
    let text = source(&input);
    let mut collected = String::new();
    loop {
        let page = hyperframes_reference_source(input.clone(), Some(&text)).unwrap();
        assert!(page["text"].as_str().unwrap().chars().count() <= 21);
        collected.push_str(page["text"].as_str().unwrap());
        if page["nextOffset"].is_null() {
            break;
        }
        input["offset"] = page["nextOffset"].clone();
    }
    assert_eq!(collected, text);
    assert!(hyperframes_reference_source(request(), Some(&text.replacen('a', "b", 1))).is_err());
    for (key, value) in [
        ("id", json!("unknown")),
        ("filePath", json!("../../LICENSE")),
        ("upstreamCommit", json!("latest")),
        ("limit", json!(0)),
        ("limit", json!(12001)),
        ("offset", json!(9999999)),
        ("url", json!("https://example.org")),
    ] {
        let mut bad = request();
        bad[key] = value;
        assert!(hyperframes_reference_source(bad, None).is_err());
    }
}

#[test]
fn prepared_files_require_their_own_manifest_digest() {
    let catalog: Value = serde_json::from_str(include_str!("../../../resources/hyperframes/catalog.json")).unwrap();
    let item = catalog["items"].as_array().unwrap().iter().find(|item| item.get("prepared").is_some_and(Value::is_object)).expect("prepared candidates");
    let file = &item["prepared"]["files"][0];
    let mut input = request();
    input["id"] = item["id"].clone();
    input["filePath"] = json!(format!("@prepared/{}", file["path"].as_str().unwrap()));
    assert!(hyperframes_reference_source(input.clone(), None).is_err());
    input["expectedSha256"] = json!("stale");
    assert!(hyperframes_reference_source(input.clone(), None).is_err());
    input["expectedSha256"] = file["sha256"].clone();
    let bytes = source(&input);
    let page = hyperframes_reference_source(input.clone(), Some(&bytes)).unwrap();
    assert_eq!(page["sha256"], file["sha256"]);
    assert_eq!(page["filePath"], input["filePath"]);
}

#[tokio::test]
async fn scoped_host_read_preserves_state_and_rejects_stale_or_mismatched_pages() {
    for mode in 0..4 {
        let runtime = OpenCutRuntime::full_access().unwrap();
        let bridge = HostBridge::default();
        register_hyperframes_reference_source(&runtime, &bridge).unwrap();
        runtime.registry().invoke("project.classic.session.attach", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":0,"classic":serde_json::from_str::<Value>(include_str!("fixtures/classic-project.json")).unwrap()})).await.unwrap();
        let mut input = request();
        input["expectedRevision"] = json!(runtime.snapshot().unwrap().revision);
        let before = runtime
            .registry()
            .invoke("app.state.read", InvocationContext::default(), json!({}))
            .await
            .unwrap()
            .result
            .data;
        let context = InvocationContext::default();
        let cancellation = context.cancellation.clone();
        let mut pending = std::pin::pin!(runtime.registry().invoke(
            "hyperframes.examples.source.read",
            context,
            input.clone()
        ));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = bridge.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter, "hyperframesReferences");
        assert_eq!(effect.request, input);
        let mut page = hyperframes_reference_source(input.clone(), Some(&source(&input))).unwrap();
        match mode {
            1 => cancellation.cancel(),
            2 => page["sha256"] = json!("wrong"),
            3 => page["nextOffset"] = json!(0),
            _ => {}
        }
        bridge
            .settle(effect.id, HostEffectResult::Success { data: page })
            .unwrap();
        assert_eq!(pending.await.is_ok(), mode == 0);
        let after = runtime
            .registry()
            .invoke("app.state.read", InvocationContext::default(), json!({}))
            .await
            .unwrap()
            .result
            .data;
        assert_eq!(before, after);
        input["projectId"] = json!("other");
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.examples.source.read",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
        assert!(bridge.pending().unwrap().is_empty());
    }
}
