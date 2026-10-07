use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

#[tokio::test]
async fn semantic_ranking_uses_the_pinned_vector_generation_and_filters_without_mutating_state() {
    let runtime = OpenCutRuntime::default();
    let index: Value = serde_json::from_str(include_str!("../../../resources/hyperframes/upstream/4c4b8574406cc566d28778a13f22c072d727a871/registry/catalog-artifact/local-vectors.json")).unwrap();
    let bytes = include_bytes!(
        "../../../resources/hyperframes/upstream/4c4b8574406cc566d28778a13f22c072d727a871/registry/catalog-artifact/local-vectors.bin"
    );
    let row = index["names"]
        .as_array()
        .unwrap()
        .iter()
        .position(|id| id == "apple-money-count")
        .unwrap();
    let mut vector: Vec<f64> = bytes[row * 384 * 4..(row + 1) * 384 * 4]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64)
        .collect();
    let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
    vector.iter_mut().for_each(|v| *v /= norm);
    let embedding = json!({"query":"financial values increasing", "normalizedQuery":"financial values increasing", "modelRevision":index["modelRevision"], "vectorRevision":index["revision"], "vector":vector});
    let before = call(&runtime, "app.state.read", json!({})).await;
    let input = json!({"query":"financial values increasing", "embedding":embedding, "limit":3});
    let hits = call(&runtime, "hyperframes.examples.search", input.clone()).await;
    assert_eq!(hits["searchMode"], "semanticLocalBge");
    assert_eq!(hits["items"][0]["id"], "apple-money-count");
    assert_eq!(hits["items"].as_array().unwrap().len(), 3);
    assert_eq!(hits["totalVerified"], 150);
    let verified = call(&runtime,"hyperframes.examples.search",json!({"verifiedOnly":true,"kind":"component","query":input["query"],"embedding":input["embedding"]})).await;
    assert!(
        verified["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["verified"] == true && v["kind"] == "component")
    );
    for (key, value) in [
        ("modelRevision", json!("wrong")),
        ("vectorRevision", json!("wrong")),
        ("query", json!("different")),
        ("vector", json!(vec![0.0; 384])),
    ] {
        let mut bad = input.clone();
        bad["embedding"][key] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.examples.search",
                    InvocationContext::default(),
                    bad
                )
                .await
                .is_err()
        );
    }
    assert_eq!(call(&runtime, "app.state.read", json!({})).await, before);
    let plan = opencut_editor_api::hyperframes_embedding_plan(
        json!({"projectId":"p","expectedRevision":0,"query":"כותרת זכוכית"}),
    )
    .unwrap();
    assert_eq!(plan["normalizedQuery"], "glass title");
    assert_eq!(plan["files"].as_array().unwrap().len(), 4);
    assert!(
        opencut_editor_api::hyperframes_embedding_plan(
            json!({"projectId":"p","expectedRevision":0,"query":"ארנב"})
        )
        .is_err()
    );
}

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
async fn pinned_catalog_is_bounded_discoverable_and_does_not_claim_captured_items_verified() {
    let runtime = OpenCutRuntime::default();
    let before = call(&runtime, "app.state.read", json!({})).await;
    let page = call(&runtime, "hyperframes.examples.search", json!({"limit":50})).await;
    assert_eq!(page["totalCatalogItems"], 394);
    assert_eq!(page["totalVerified"], 150);
    assert_eq!(page["searchMode"], "lexicalWithHebrewAliases");
    assert_eq!(page["items"].as_array().unwrap().len(), 50);
    assert_eq!(page["nextOffset"], 50);
    let next = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"limit":50,"offset":50}),
    )
    .await;
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    let verified = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"verifiedOnly":true}),
    )
    .await;
    assert_eq!(verified["totalMatches"], 150);
    assert!(
        verified["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["verified"] == true)
    );
    for (kind, count) in [("block", 50), ("component", 100)] {
        let result = call(
            &runtime,
            "hyperframes.examples.search",
            json!({"kind": kind, "verifiedOnly": true}),
        )
        .await;
        assert_eq!(result["totalMatches"], count);
    }
    for id in ["matrix-decode", "rgb-glitch-text", "separator"] {
        let rejected = call(
            &runtime,
            "hyperframes.examples.search",
            json!({"query": id, "verifiedOnly": true}),
        )
        .await;
        assert_eq!(rejected["totalMatches"], 0);
    }
    let prompt_query = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"query": "neuroscientist", "verifiedOnly": true}),
    )
    .await;
    assert!(prompt_query["totalMatches"].as_u64().unwrap() > 0);
    for (kind, count) in [("block", 164), ("component", 222), ("example", 8)] {
        let result = call(
            &runtime,
            "hyperframes.examples.search",
            json!({"kind":kind}),
        )
        .await;
        assert_eq!(result["totalMatches"], count);
        assert!(
            result["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["kind"] == kind)
        );
    }
    let english = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"query":"chart"}),
    )
    .await;
    let hebrew = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"query":"גרף"}),
    )
    .await;
    assert_eq!(english["items"], hebrew["items"]);
    assert!(english["totalMatches"].as_u64().unwrap() > 0);
    let item = call(
        &runtime,
        "hyperframes.examples.read",
        json!({"id":"data-chart","upstreamCommit":page["upstreamCommit"]}),
    )
    .await;
    assert_eq!(item["item"]["kind"], "block");
    assert_eq!(item["item"]["verification"]["status"], "captured");
    assert_eq!(item["item"]["prompt"]["status"], "unreviewed");
    let exact = call(
        &runtime,
        "hyperframes.examples.search",
        json!({"query":"lt-clean-bar"}),
    )
    .await;
    assert_eq!(exact["totalMatches"], 1);
    let original = call(
        &runtime,
        "hyperframes.examples.read",
        json!({"id":"apple-money-count","upstreamCommit":page["upstreamCommit"]}),
    )
    .await;
    let upstream: Value = serde_json::from_str(include_str!("../../../resources/hyperframes/upstream/4c4b8574406cc566d28778a13f22c072d727a871/registry/blocks/apple-money-count/registry-item.json")).unwrap();
    assert_eq!(original["item"]["prompt"]["status"], "original");
    assert_eq!(original["item"]["prompt"]["text"], upstream["sourcePrompt"]);
    assert_eq!(
        original["item"]["prompt"]["provenance"]["manifestSha256"],
        original["item"]["manifestSha256"]
    );
    assert!(
        item["item"]["sourceUrl"]
            .as_str()
            .unwrap()
            .contains(page["upstreamCommit"].as_str().unwrap())
    );
    let missing = call(
        &runtime,
        "hyperframes.examples.read",
        json!({"id":"carousel-circle-1","upstreamCommit":page["upstreamCommit"]}),
    )
    .await;
    assert!(
        !missing["item"]["verification"]["missingDeclaredFiles"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for id in ["hyperframes.examples.search", "hyperframes.examples.read"] {
        let descriptor = runtime.registry().descriptor(id).unwrap().unwrap();
        assert_eq!(descriptor.access, AccessLevel::Read);
        assert_eq!(descriptor.document_support, DocumentSupport::Both);
        assert!(!descriptor.open_world);
    }
    assert_eq!(call(&runtime, "app.state.read", json!({})).await, before);
}

#[tokio::test]
async fn invalid_or_cancelled_reference_requests_are_rejected() {
    let runtime = OpenCutRuntime::default();
    for input in [
        json!({"limit":0}),
        json!({"limit":51}),
        json!({"offset":10001}),
        json!({"kind":"video"}),
        json!({"query":"x".repeat(301)}),
        json!({"unknown":true}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.examples.search",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
    }
    let found = call(&runtime, "hyperframes.examples.search", json!({})).await;
    for input in [
        json!({"id":"data-chart","upstreamCommit":"stale"}),
        json!({"id":"../../LICENSE","upstreamCommit":found["upstreamCommit"]}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.examples.read",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.examples.search", context, json!({}))
            .await
            .is_err()
    );
}
