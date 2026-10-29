use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const SET: &str = "timeline.classic.audio.procedural.set";
const BANK: &str = "591fa3e028032e6dce56620a20e932e35667e8d8";

#[test]
fn shared_host_contract_boundary_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/earshot-source-contract.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut source = fixture["base"].clone();
        source
            .as_object_mut()
            .unwrap()
            .extend(case["patch"].as_object().unwrap().clone());
        assert_eq!(
            classic_timeline::validate_procedural_audio_source(&source).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{source}"
        );
    }
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
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
fn spec() -> Value {
    json!({"version":1,"engine":"earshot","bankRevision":BANK,"presetId":"whoosh_fast/whip","seed":42,"duration":2.0})
}
async fn setup() -> (OpenCutRuntime, Value) {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let inserted = call(&runtime, "timeline.classic.elements.insert", json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":read(&runtime).await["revision"],"clips":[{"placement":{"mode":"auto","trackType":"audio"},"element":{"type":"audio","sourceType":"procedural","procedural":spec(),"name":"Earshot Whoosh","startTime":120000,"duration":240000,"sourceDuration":240000,"trimStart":0,"trimEnd":0,"params":{"volume":-18,"muted":false}}}]})).await;
    (runtime, inserted["elements"][0].clone())
}
fn clip<'a>(state: &'a Value, reference: &Value) -> &'a Value {
    state["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == reference["trackId"])
        .unwrap()["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == reference["elementId"])
        .unwrap()
}
fn request(state: &Value, reference: &Value, source: Value) -> Value {
    json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":state["revision"],"updates":[{"trackId":reference["trackId"],"elementId":reference["elementId"],"procedural":source}]})
}

#[tokio::test]
async fn procedural_sources_roundtrip_without_files_and_edit_atomically_with_history() {
    let (runtime, reference) = setup().await;
    let before = read(&runtime).await;
    assert_eq!(clip(&before, &reference)["procedural"], spec());
    assert!(clip(&before, &reference).get("mediaId").is_none());
    let descriptor = runtime.registry().descriptor(SET).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(
        descriptor.transactional
            && descriptor.supports_dry_run
            && descriptor.cancellable
            && !descriptor.open_world
    );
    let mut source = spec();
    source["duration"] = json!(3.5);
    source["apex"] = json!(0.4);
    source["pitch"] = json!("F#4");
    source["parameters"] = json!({"brightness":0.8,"density":2.0});
    source["sourceCode"] =
        json!("def build(duration, seed, **kwargs):\n    return synth(duration, seed)\n");
    source["echo"] = json!({"delay":0.12,"feedback":0.25,"mix":0.1});
    let input = request(&before, &reference, source.clone());
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("earshot-once"));
    runtime
        .registry()
        .invoke(SET, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    context.dry_run = false;
    let receipt = runtime
        .registry()
        .invoke(SET, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(SET, context, input.clone())
            .await
            .unwrap(),
        receipt
    );
    let after = read(&runtime).await;
    let sound = clip(&after, &reference);
    assert_eq!(sound["procedural"], source);
    assert_eq!(sound["duration"], 420000);
    assert_eq!(sound["sourceDuration"], 420000);
    assert_eq!(sound["startTime"], 120000);
    assert_eq!(sound["params"], clip(&before, &reference)["params"]);
    assert_eq!(
        after["project"]["classic"]["mediaAssets"],
        before["project"]["classic"]["mediaAssets"]
    );
    assert_eq!(
        after["project"]["classic"]["document"]["scenes"][1],
        before["project"]["classic"]["document"]["scenes"][1]
    );
    let roundtrip: Value = serde_json::from_str(&serde_json::to_string(&after).unwrap()).unwrap();
    assert_eq!(clip(&roundtrip, &reference), sound);
    assert!(
        runtime
            .registry()
            .invoke(SET, InvocationContext::default(), input)
            .await
            .is_err()
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn procedural_validation_is_shared_by_insert_updates_attach_and_admin_patch() {
    let (runtime, reference) = setup().await;
    let before = read(&runtime).await;
    let mut bad = Vec::new();
    for (key, value) in [
        ("version", json!(2)),
        ("engine", json!("python")),
        ("bankRevision", json!("latest")),
        ("presetId", json!("../code\n")),
        ("seed", json!(-1)),
        ("duration", json!(31)),
        ("duration", json!(0)),
        ("apex", json!(3)),
        ("pitch", json!(0)),
        ("pitch", json!("A-8")),
        ("sourceCode", json!("x".repeat(32769))),
        ("sourceCode", json!("א".repeat(16385))),
        ("parameters", json!({"gain":"loud"})),
        ("echo", json!({"delay":0.1,"feedback":1,"mix":0.5})),
        ("unknown", json!(true)),
    ] {
        let mut source = spec();
        source[key] = value;
        bad.push(source);
    }
    let mut too_many = spec();
    too_many["parameters"] = Value::Object((0..65).map(|i| (format!("p{i}"), json!(i))).collect());
    bad.push(too_many);
    for source in bad {
        let update = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"updates":[{"trackId":reference["trackId"],"elementId":reference["elementId"],"patch":{"procedural":source}}]});
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.classic.elements.update",
                    InvocationContext::default(),
                    update
                )
                .await
                .is_err()
        );
        let mut classic = before["project"]["classic"].clone();
        let tracks = classic["document"]["scenes"][0]["tracks"]["audio"]
            .as_array_mut()
            .unwrap();
        let track_index = tracks
            .iter()
            .position(|track| track["id"] == reference["trackId"])
            .unwrap();
        let elements = tracks[track_index]["elements"].as_array_mut().unwrap();
        let element_index = elements
            .iter()
            .position(|element| element["id"] == reference["elementId"])
            .unwrap();
        elements[element_index]["procedural"] = source.clone();
        let path = format!(
            "/project/classic/document/scenes/0/tracks/audio/{track_index}/elements/{element_index}/procedural"
        );
        let patch = json!({"expectedRevision":before["revision"],"patch":[{"op":"replace","path":path,"value":source}]});
        assert!(
            runtime
                .registry()
                .invoke("app.state.patch", InvocationContext::default(), patch)
                .await
                .is_err()
        );
        assert!(runtime.registry().invoke("project.classic.session.attach", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":before["revision"],"classic":classic})).await.is_err());
        assert_eq!(read(&runtime).await, before);
    }
    let insert = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":before["revision"],"clips":[{"placement":{"mode":"auto"},"element":{"type":"audio","sourceType":"procedural","procedural":spec(),"mediaId":"video-asset","name":"Bad binding","startTime":0,"duration":240000,"params":{}}}]});
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.classic.elements.insert",
                InvocationContext::default(),
                insert
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn procedural_duration_respects_trims_rate_cancellation_and_atomic_targets() {
    let (runtime, reference) = setup().await;
    call(&runtime, "timeline.classic.elements.update", json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":read(&runtime).await["revision"],"updates":[{"trackId":reference["trackId"],"elementId":reference["elementId"],"patch":{"trimStart":30000,"trimEnd":30000,"retime":{"rate":2}}}]})).await;
    let before = read(&runtime).await;
    let mut source = spec();
    source["duration"] = json!(3);
    let input = request(&before, &reference, source.clone());
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(SET, context, input.clone())
            .await
            .is_err()
    );
    let mut wrong_project = input.clone();
    wrong_project["projectId"] = json!("other-project");
    assert!(
        runtime
            .registry()
            .invoke(SET, InvocationContext::default(), wrong_project)
            .await
            .is_err()
    );
    let mut batch = input.clone();
    batch["updates"]
        .as_array_mut()
        .unwrap()
        .push(json!({"trackId":"titles","elementId":"text-1","procedural":source}));
    assert!(
        runtime
            .registry()
            .invoke(SET, InvocationContext::default(), batch)
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(&runtime, SET, input).await;
    let after = read(&runtime).await;
    assert_eq!(clip(&after, &reference)["duration"], 150000);
    assert_eq!(clip(&after, &reference)["trimStart"], 30000);
    assert_eq!(clip(&after, &reference)["startTime"], 120000);
    let mut short = spec();
    short["duration"] = json!(0.25);
    assert!(
        runtime
            .registry()
            .invoke(
                SET,
                InvocationContext::default(),
                request(&after, &reference, short)
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, after);
}

#[tokio::test]
async fn procedural_insert_derives_missing_duration_from_source_and_trims() {
    let (runtime, _) = setup().await;
    let inserted = call(&runtime, "timeline.classic.elements.insert", json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":read(&runtime).await["revision"],"clips":[{"placement":{"mode":"auto","trackType":"audio"},"element":{"type":"audio","sourceType":"procedural","procedural":spec(),"name":"Derived source length","startTime":0,"trimStart":30000,"trimEnd":30000,"retime":{"rate":2},"params":{}}}]})).await;
    let state = read(&runtime).await;
    let inserted = clip(&state, &inserted["elements"][0]);
    assert_eq!(inserted["sourceDuration"], 240000);
    assert_eq!(inserted["duration"], 90000);
}

#[test]
fn timeline_source_codec_preserves_valid_code_and_rejects_invalid_procedural_data() {
    let mut source = json!({"schemaVersion":2,"scene":{"id":"scene","tracks":[{"id":"audio","elements":[{"id":"clip","type":"audio","sourceType":"procedural","procedural":spec()}]}]}});
    let result = classic_timeline::canonicalize_timeline_source_document(
        classic_timeline::CanonicalizeTimelineSourceDocumentOptions {
            json: source.to_string(),
        },
    );
    assert!(result.valid);
    let decoded: Value = serde_json::from_str(&result.formatted_json).unwrap();
    assert_eq!(
        decoded["scene"]["tracks"][0]["elements"][0]["procedural"],
        spec()
    );
    source["scene"]["tracks"][0]["elements"][0]["procedural"]["duration"] = json!(31);
    let result = classic_timeline::canonicalize_timeline_source_document(
        classic_timeline::CanonicalizeTimelineSourceDocumentOptions {
            json: source.to_string(),
        },
    );
    assert!(!result.valid);
    assert_eq!(result.diagnostics[0].code, "invalid_procedural_audio");
}
