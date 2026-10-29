use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const BANK: &str = "591fa3e028032e6dce56620a20e932e35667e8d8";
const PREFIX: &str = "audio.earshot.";

async fn call(runtime: &OpenCutRuntime, suffix: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(
            &format!("{PREFIX}{suffix}"),
            InvocationContext::default(),
            input,
        )
        .await
        .unwrap()
        .result
        .data
}
async fn state(runtime: &OpenCutRuntime) -> Value {
    runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data
}
fn catalog() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../classic/apps/web/src/earshot/catalog-data.json"
    ))
    .unwrap()
}
fn numeric_values(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Array(array) => Value::Array(array.iter().map(numeric_values).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), numeric_values(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}
fn manifest() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../classic/vendor/earshot/manifest.json"
    ))
    .unwrap()
}

#[tokio::test]
async fn complete_catalog_is_discoverable_and_returns_faithful_editable_starters() {
    let runtime = OpenCutRuntime::default();
    let before = state(&runtime).await;
    let mut ids = BTreeSet::new();
    let mut offset = 0;
    loop {
        let page = call(
            &runtime,
            "catalog.search",
            json!({"offset":offset,"limit":50}),
        )
        .await;
        assert_eq!(page["bankRevision"], BANK);
        assert_eq!(page["totalCatalogItems"], 252);
        assert_eq!(page["totalMatches"], 252);
        assert!(page["items"].as_array().unwrap().len() <= 50);
        for sound in page["items"].as_array().unwrap() {
            assert!(ids.insert(sound["id"].as_str().unwrap().to_owned()));
        }
        let Some(next) = page["nextOffset"].as_u64() else {
            break;
        };
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(ids.len(), 252);
    let template: String = serde_json::from_str(include_str!(
        "../../../classic/apps/web/src/earshot/starter-source.json"
    ))
    .unwrap();
    for sound in catalog() {
        assert!(ids.contains(sound["id"].as_str().unwrap()));
        let entry = call(
            &runtime,
            "catalog.read",
            json!({"bankRevision":BANK,"id":sound["id"]}),
        )
        .await;
        assert_eq!(numeric_values(&entry["sound"]), numeric_values(&sound));
        assert_eq!(entry["procedural"]["seed"], sound["seed"]);
        assert_eq!(entry["procedural"]["presetId"], sound["id"]);
        assert_eq!(
            entry["sourceCode"],
            template.replace("__EARSHOT_PRESET_ID__", &sound["id"].to_string())
        );
        classic_timeline::validate_procedural_audio_source(&entry["procedural"]).unwrap();
        let mut custom = entry["procedural"].clone();
        custom["sourceCode"] = entry["sourceCode"].clone();
        classic_timeline::validate_procedural_audio_source(&custom).unwrap();
        let recipe = call(
            &runtime,
            "repository.read",
            json!({"bankRevision":BANK,"path":sound["sourcePath"],"limit":100}),
        )
        .await;
        assert!(!recipe["text"].as_str().unwrap().is_empty());
    }
    let filtered = call(
        &runtime,
        "catalog.search",
        json!({"query":"CLICK","category":"click","kind":"click"}),
    )
    .await;
    assert!(filtered["totalMatches"].as_u64().unwrap() > 0);
    assert!(
        filtered["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|sound| sound["category"] == "click")
    );
    assert_eq!(state(&runtime).await, before);
}

#[tokio::test]
async fn every_pinned_source_file_roundtrips_with_bounded_unicode_pages_and_exact_hashes() {
    let runtime = OpenCutRuntime::default();
    let before = state(&runtime).await;
    let expected = manifest();
    let mut files = Vec::new();
    let mut offset = 0;
    loop {
        let page = call(
            &runtime,
            "repository.list",
            json!({"limit":80,"offset":offset}),
        )
        .await;
        assert_eq!(page["totalRepositoryFiles"], 282);
        assert_eq!(page["totalMatches"], 282);
        files.extend(page["files"].as_array().unwrap().clone());
        let Some(next) = page["nextOffset"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(files.len(), expected.len());
    let mut binary = 0;
    for (file, expected) in files.iter().zip(expected.iter()) {
        assert_eq!(file["path"], expected["path"]);
        assert_eq!(file["sha256"], expected["sha256"]);
        assert_eq!(file["byteSize"], expected["size"]);
        if file["encoding"] == "binary" {
            binary += 1;
            let response = runtime.registry().invoke("audio.earshot.repository.artifact", InvocationContext::default(), json!({"bankRevision":BANK,"path":file["path"],"expectedSha256":file["sha256"]})).await.unwrap();
            let artifact = &response.result.artifacts[0];
            assert_eq!(artifact.sha256, file["sha256"]);
            assert_eq!(artifact.mime_type, "image/png");
            let bytes = runtime.artifacts().get(&artifact.uri).unwrap();
            assert!(bytes.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert_eq!(bytes.bytes.len() as u64, expected["size"]);
            continue;
        }
        let mut offset = 0;
        let mut complete = String::new();
        loop {
            let page = call(&runtime, "repository.read", json!({"bankRevision":BANK,"path":file["path"],"expectedSha256":file["sha256"],"offset":offset,"limit":7777})).await;
            let text = page["text"].as_str().unwrap();
            assert!(text.chars().count() <= 7777);
            complete.push_str(text);
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(complete.chars().count() as u64, page["totalCharacters"]);
                break;
            };
            assert_eq!(next, offset + text.chars().count() as u64);
            offset = next;
        }
        assert_eq!(
            format!("{:x}", Sha256::digest(complete.as_bytes())),
            file["sha256"],
            "{}",
            file["path"]
        );
        assert_eq!(complete.len() as u64, file["byteSize"]);
    }
    assert_eq!(binary, 2);
    assert_eq!(state(&runtime).await, before);
}

#[tokio::test]
async fn full_repository_search_pages_every_matching_line_including_docs_and_skills() {
    let runtime = OpenCutRuntime::default();
    for prefix in ["docs/", "skills/", "earshot/"] {
        let mut offset = 0;
        let mut seen = BTreeSet::new();
        loop {
            let page = call(
                &runtime,
                "repository.search",
                json!({"query":"sound","prefix":prefix,"offset":offset,"limit":37}),
            )
            .await;
            assert!(page["matches"].as_array().unwrap().len() <= 37);
            assert!(page["totalMatchingLines"].as_u64().unwrap() > 2);
            for hit in page["matches"].as_array().unwrap() {
                assert!(hit["path"].as_str().unwrap().starts_with(prefix));
                assert!(
                    hit["text"]
                        .as_str()
                        .unwrap()
                        .to_lowercase()
                        .contains("sound")
                );
                assert!(hit["text"].as_str().unwrap().chars().count() <= 400);
                assert!(seen.insert((hit["path"].to_string(), hit["line"].as_u64().unwrap())));
            }
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(seen.len() as u64, page["totalMatchingLines"]);
                break;
            };
            assert!(next > offset);
            offset = next;
        }
    }
    let all = call(
        &runtime,
        "repository.search",
        json!({"query":"earshot","limit":1}),
    )
    .await;
    assert_eq!(all["searchedTextFiles"], 280);
    assert_eq!(all["skippedBinaryFiles"], 2);
    let literal = call(
        &runtime,
        "repository.search",
        json!({"query":".*","prefix":"README.md"}),
    )
    .await;
    let expected = include_str!("../../../classic/vendor/earshot/upstream/README.md")
        .lines()
        .filter(|line| line.contains(".*"))
        .count();
    assert_eq!(literal["totalMatchingLines"], expected);
}

#[tokio::test]
async fn invalid_paths_generations_bounds_and_cancelled_requests_never_change_state() {
    let runtime = OpenCutRuntime::default();
    let before = state(&runtime).await;
    let inputs = [
        ("catalog.search", json!({"limit":51})),
        ("catalog.search", json!({"limit":0})),
        ("catalog.search", json!({"bankRevision":"0".repeat(40)})),
        (
            "catalog.read",
            json!({"bankRevision":BANK,"id":"missing/preset"}),
        ),
        (
            "catalog.read",
            json!({"bankRevision":BANK,"id":"click/double","sourceCode":"anything"}),
        ),
        ("repository.list", json!({"limit":81})),
        ("repository.search", json!({"query":" "})),
        ("repository.search", json!({"query":"a".repeat(201)})),
        ("repository.search", json!({"query":"sound","limit":51})),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"../manifest.json"}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"/etc/passwd"}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"docs/../README.md"}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"README.md","limit":12001}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"README.md","offset":1000000}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"README.md","expectedSha256":"0".repeat(64)}),
        ),
        (
            "repository.read",
            json!({"bankRevision":BANK,"path":"docs/media/launch_sheet.png"}),
        ),
        (
            "repository.artifact",
            json!({"bankRevision":BANK,"path":"../manifest.json"}),
        ),
        (
            "repository.artifact",
            json!({"bankRevision":"0".repeat(40),"path":"README.md"}),
        ),
    ];
    for (id, input) in inputs {
        assert!(
            runtime
                .registry()
                .invoke(
                    &format!("{PREFIX}{id}"),
                    InvocationContext::default(),
                    input.clone()
                )
                .await
                .is_err(),
            "accepted {id}: {input}"
        );
    }
    for (id, input) in [
        ("catalog.search", json!({})),
        ("repository.search", json!({"query":"sound"})),
        (
            "repository.artifact",
            json!({"bankRevision":BANK,"path":"README.md"}),
        ),
    ] {
        let context = InvocationContext::default();
        context.cancellation.cancel();
        assert!(
            runtime
                .registry()
                .invoke(&format!("{PREFIX}{id}"), context, input)
                .await
                .is_err()
        );
    }
    for suffix in [
        "catalog.search",
        "catalog.read",
        "repository.list",
        "repository.read",
        "repository.search",
        "repository.artifact",
    ] {
        let descriptor = runtime
            .registry()
            .descriptor(&format!("{PREFIX}{suffix}"))
            .unwrap()
            .unwrap();
        assert_eq!(descriptor.access, AccessLevel::Read);
        assert_eq!(descriptor.document_support, DocumentSupport::Both);
        assert!(
            descriptor.available
                && descriptor.cancellable
                && !descriptor.open_world
                && !descriptor.transactional
        );
        assert!(descriptor.tags.contains(&"earshot".into()));
    }
    assert_eq!(state(&runtime).await, before);
}

#[tokio::test]
async fn discovered_recipe_inserts_and_edits_through_canonical_capabilities_then_reads_from_state()
{
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    let entry = call(
        &runtime,
        "catalog.read",
        json!({"bankRevision":BANK,"id":"click/double"}),
    )
    .await;
    let duration = (entry["procedural"]["duration"].as_f64().unwrap() * 120000.0).round() as u64;
    let inserted = runtime.registry().invoke("timeline.classic.elements.insert", InvocationContext::default(), json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state(&runtime).await["revision"],"clips":[{"placement":{"mode":"auto","trackType":"audio"},"element":{"type":"audio","sourceType":"procedural","procedural":entry["procedural"],"name":entry["sound"]["name"],"startTime":0,"duration":duration,"sourceDuration":duration,"trimStart":0,"trimEnd":0,"params":{"volume":-12,"muted":false}}}]})).await.unwrap().result.data;
    let reference = &inserted["elements"][0];
    let mut custom = entry["procedural"].clone();
    custom["sourceCode"] = entry["sourceCode"].clone();
    custom["echo"] = json!({"delay":0.1,"feedback":0.3,"mix":0.2});
    runtime.registry().invoke("timeline.classic.audio.procedural.set", InvocationContext::default(), json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state(&runtime).await["revision"],"updates":[{"trackId":reference["trackId"],"elementId":reference["elementId"],"procedural":custom}]})).await.unwrap();
    let state = state(&runtime).await;
    let tracks = state["value"]["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"]
        .as_array()
        .unwrap();
    let clip = tracks
        .iter()
        .flat_map(|track| track["elements"].as_array().unwrap())
        .find(|clip| clip["id"] == reference["elementId"])
        .unwrap();
    assert_eq!(clip["procedural"], custom);
    assert!(clip.get("mediaId").is_none());
    assert!(clip.get("file").is_none());
}
