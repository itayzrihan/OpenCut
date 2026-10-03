use std::collections::BTreeMap;

use opencut_editor_api::{
    AccessLevel, HyperframesDependencyStatus, HyperframesSource, InvocationContext, OpenCutRuntime,
    inspect_hyperframes,
};
use serde_json::{Value, json};

fn source() -> HyperframesSource {
    HyperframesSource {
        entry_file: "index.html".into(),
        files: BTreeMap::from([
            ("index.html".into(), r#"<!doctype html><html><head><script src="assets/gsap.js"></script></head><body>
              <div data-composition-id="main" data-width="720" data-height="1280" data-duration="6">
                <div id="intro" data-composition-id="intro" data-composition-src="scenes/intro.html" data-start="0" data-duration="3" data-track-index="2"></div>
                <div id="repeat" data-composition-id="repeat" data-composition-src="scenes/intro.html" data-start="3" data-duration="3" data-track-index="2"></div>
                <audio id="voice" src="assets/voice.wav" data-start="0" data-duration="6" data-track-index="10"></audio>
              </div></body></html>"#.into()),
            ("scenes/intro.html".into(), r#"<template><div data-composition-id="intro" data-duration="3">
                <div id="copy" data-start="0.4" data-duration="1.5" data-track-index="1">שלום</div>
                <img src="../assets/logo.svg" data-start="copy + 0.1" data-duration="1" />
                <script>window.__timelines.intro = gsap.timeline({ paused: true });</script>
              </div></template>"#.into()),
            ("assets/gsap.js".into(), "/* source preserved, never executed by inspection */".into()),
            ("assets/logo.svg".into(), "<svg xmlns='http://www.w3.org/2000/svg'/>".into()),
            ("hyperframes.json".into(), r#"{"width":720,"height":1280,"fps":30}"#.into()),
        ]),
        resource_asset_ids: BTreeMap::new(),
    }
}

async fn invoke(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}

async fn setup() -> (OpenCutRuntime, String, String) {
    let runtime = OpenCutRuntime::full_access().unwrap();
    invoke(&runtime, "project.create", json!({"name":"Mixed project"})).await;
    let asset = invoke(&runtime, "media.import", json!({"name":"Original footage","source":"original.mp4","mediaType":"video","durationSeconds":12})).await;
    let project = runtime.snapshot().unwrap().project.unwrap();
    let track_id = project
        .timeline
        .tracks
        .iter()
        .find(|t| t.kind == opencut_editor_api::TrackKind::Video)
        .unwrap()
        .id
        .clone();
    invoke(&runtime, "timeline.item.add", json!({"trackId":track_id,"name":"Existing edit","kind":"video","assetId":asset["changedIds"][0],"startSeconds":0,"durationSeconds":12})).await;
    (runtime, project.id, track_id)
}

#[test]
fn inventory_preserves_nested_instances_authored_expressions_and_source() {
    let source = source();
    let inspection = inspect_hyperframes(&source).unwrap();
    assert_eq!(
        (
            inspection.width,
            inspection.height,
            inspection.duration_seconds
        ),
        (720, 1280, Some(6.0))
    );
    assert!(inspection.requires_runtime);
    let repeated: Vec<_> = inspection
        .elements
        .iter()
        .filter(|e| e.element_id.as_deref() == Some("copy"))
        .collect();
    assert_eq!(repeated.len(), 2);
    assert_ne!(repeated[0].key, repeated[1].key);
    assert_ne!(repeated[0].parent_key, repeated[1].parent_key);
    assert!(inspection.elements.iter().any(|e| {
        e.attributes
            .get("data-start")
            .is_some_and(|v| v == "copy + 0.1")
    }));
    assert!(
        inspection
            .dependencies
            .iter()
            .any(|d| d.package_path.as_deref() == Some("assets/logo.svg")
                && d.status == HyperframesDependencyStatus::Source)
    );
    assert!(
        inspection
            .dependencies
            .iter()
            .any(|d| d.package_path.as_deref() == Some("assets/voice.wav")
                && d.status == HyperframesDependencyStatus::Missing)
    );
    assert_eq!(inspection.fingerprint, source.fingerprint());
}

#[test]
fn malformed_packages_and_recursive_compositions_fail_without_execution() {
    for path in [
        "../escape.html",
        "/absolute.html",
        "C:/secret.html",
        "a\\b.html",
        "a//b.html",
    ] {
        let mut source = source();
        source.files.insert(path.into(), "content".into());
        assert!(inspect_hyperframes(&source).is_err(), "accepted {path}");
    }
    let mut cycle = source();
    cycle.files.insert(
        "scenes/intro.html".into(),
        r#"<template><div data-composition-src="../index.html"></div></template>"#.into(),
    );
    assert!(
        inspect_hyperframes(&cycle)
            .unwrap_err()
            .to_string()
            .contains("cycle")
    );
    let mut escape = source();
    escape.files.insert(
        "scenes/intro.html".into(),
        r#"<template><img src="../../outside.png"></template>"#.into(),
    );
    assert!(inspect_hyperframes(&escape).is_err());
    let mut malformed = source();
    malformed
        .files
        .get_mut("index.html")
        .unwrap()
        .push_str("<script>throw new Error('not executed')</script>");
    assert!(inspect_hyperframes(&malformed).is_ok());
    for duration in ["NaN", "-1", "0", "Infinity"] {
        let mut malformed = source();
        malformed
            .files
            .get_mut("index.html")
            .unwrap()
            .replace_range(
                ..,
                &format!(r#"<div data-composition-id="x" data-duration="{duration}"></div>"#),
            );
        assert!(inspect_hyperframes(&malformed).is_err());
    }
}

#[test]
fn encoded_paths_and_root_relative_urls_resolve_inside_the_package() {
    let mut source = source();
    source
        .files
        .insert("assets/לוגו חדש.svg".into(), "<svg/>".into());
    source.files.insert(
        "scenes/intro.html".into(),
        r#"<template><div data-composition-id="intro">
        <img src="/assets/%D7%9C%D7%95%D7%92%D7%95%20%D7%97%D7%93%D7%A9.svg?v=2#icon">
        <img src="https://example.invalid/image.png"></div></template>"#
            .into(),
    );
    let inspection = inspect_hyperframes(&source).unwrap();
    assert!(
        inspection
            .dependencies
            .iter()
            .any(|d| d.package_path.as_deref() == Some("assets/לוגו חדש.svg")
                && d.status == HyperframesDependencyStatus::Source)
    );
    assert!(
        inspection
            .dependencies
            .iter()
            .any(|d| d.status == HyperframesDependencyStatus::External)
    );
    source.files.insert(
        "scenes/intro.html".into(),
        r#"<img src="/%2e%2e/outside.png">"#.into(),
    );
    assert!(inspect_hyperframes(&source).is_err());
}

#[tokio::test]
async fn dry_run_idempotency_does_not_swallow_the_subsequent_commit() {
    let (runtime, project_id, _) = setup().await;
    let revision = runtime.snapshot().unwrap().revision;
    let input =
        json!({"projectId":project_id,"expectedRevision":revision,"name":"Once","source":source()});
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context.metadata.insert(
        "opencut/idempotencyKey".into(),
        json!("preview-then-commit"),
    );
    let preview = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.import",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(preview.result.data["mutation"]["committed"], false);
    context.dry_run = false;
    let commit = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.import",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(commit.result.data["mutation"]["committed"], true);
    let retry = runtime
        .registry()
        .invoke("timeline.hyperframes.import", context, input)
        .await
        .unwrap();
    assert_eq!(commit, retry);
    assert_eq!(runtime.snapshot().unwrap().revision, revision + 1);
}

#[tokio::test]
async fn runtime_duration_and_bound_audio_are_preserved() {
    let runtime = OpenCutRuntime::full_access().unwrap();
    invoke(
        &runtime,
        "project.create",
        json!({"name":"Only HyperFrames"}),
    )
    .await;
    let audio = invoke(
        &runtime,
        "media.import",
        json!({"name":"Narration","source":"voice.wav","mediaType":"audio","durationSeconds":6}),
    )
    .await;
    let mut source = source();
    source.resource_asset_ids.insert(
        "assets/voice.wav".into(),
        audio["changedIds"][0].as_str().unwrap().into(),
    );
    source.files.insert("index.html".into(), r#"<div data-composition-id="generated"><script>/* runtime creates the timeline */</script></div>"#.into());
    let before = runtime.snapshot().unwrap();
    let mut input = json!({"projectId":before.project.as_ref().unwrap().id,"expectedRevision":before.revision,"name":"Generated","source":source});
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.hyperframes.import",
                InvocationContext::default(),
                input.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
    input["resolvedDurationSeconds"] = json!(6.0);
    invoke(&runtime, "timeline.hyperframes.import", input).await;
    let state = invoke(&runtime, "app.state.read", json!({})).await;
    assert_eq!(
        state["value"]["project"]["assets"][1]["hyperframes"]["durationSeconds"],
        6.0
    );
    assert_eq!(
        state["value"]["project"]["assets"][1]["hyperframes"]["source"]["resourceAssetIds"]["assets/voice.wav"],
        audio["changedIds"][0]
    );
}

#[tokio::test]
async fn import_coexists_with_existing_edit_roundtrips_and_undoes_as_one_change() {
    let (runtime, project_id, track_id) = setup().await;
    let before = runtime.snapshot().unwrap();
    let input = json!({"projectId":project_id,"expectedRevision":before.revision,"name":"Brag","source":source(),"trackId":track_id});
    let preview = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.import",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            input.clone(),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(preview["mutation"]["committed"], false);
    assert_eq!(runtime.snapshot().unwrap(), before);
    let result = invoke(&runtime, "timeline.hyperframes.import", input).await;
    let state = invoke(&runtime, "app.state.read", json!({})).await;
    let project = &state["value"]["project"];
    let old_project = before.project.as_ref().unwrap();
    assert_eq!(
        project["settings"],
        serde_json::to_value(&old_project.settings).unwrap()
    );
    let items = project["timeline"]["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["id"] == track_id)
        .unwrap()["items"]
        .as_array()
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0],
        serde_json::to_value(
            &old_project
                .timeline
                .tracks
                .iter()
                .find(|track| track.id == track_id)
                .unwrap()
                .items[0]
        )
        .unwrap()
    );
    assert_eq!(items[1]["kind"], "compound");
    assert_eq!(items[1]["startSeconds"], 12.0);
    assert_eq!(items[1]["durationSeconds"], 6.0);
    let asset = project["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == result["assetId"])
        .unwrap();
    assert_eq!(
        asset["hyperframes"]["source"],
        serde_json::to_value(source()).unwrap()
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sessions.json");
    runtime.save_application_state(&path).unwrap();
    let restored = OpenCutRuntime::full_access().unwrap();
    restored.restore_application_state(&path).unwrap();
    assert_eq!(restored.snapshot().unwrap(), runtime.snapshot().unwrap());
    invoke(&runtime, "history.undo", json!({})).await;
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
    invoke(&runtime, "history.redo", json!({})).await;
    assert_eq!(
        runtime.snapshot().unwrap().project,
        restored.snapshot().unwrap().project
    );
}

#[tokio::test]
async fn overlay_placement_and_retries_use_the_existing_registry_contract() {
    let (runtime, project_id, _) = setup().await;
    let before = runtime.snapshot().unwrap();
    let input = json!({"projectId":project_id,"expectedRevision":before.revision,"name":"Overlay","source":source(),"startSeconds":2.5});
    let descriptor = runtime
        .registry()
        .snapshot()
        .unwrap()
        .capabilities
        .into_iter()
        .find(|d| d.id == "timeline.hyperframes.import")
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(descriptor.transactional && descriptor.supports_dry_run && descriptor.cancellable);
    assert!(!descriptor.open_world);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("import-once"));
    let first = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.import",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    let repeated = runtime
        .registry()
        .invoke("timeline.hyperframes.import", context, input.clone())
        .await
        .unwrap();
    assert_eq!(first, repeated);
    let after = runtime.snapshot().unwrap();
    let tracks = &after.project.as_ref().unwrap().timeline.tracks;
    assert_eq!(
        &tracks[..tracks.len() - 1],
        &before.project.unwrap().timeline.tracks
    );
    assert_eq!(tracks.last().unwrap().items[0].start_seconds, 2.5);
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.hyperframes.import",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), after);
}

#[tokio::test]
async fn wrong_project_locked_track_missing_resource_and_cancellation_are_atomic() {
    let (runtime, project_id, track_id) = setup().await;
    let before = runtime.snapshot().unwrap();
    let base = json!({"projectId":project_id,"expectedRevision":before.revision,"name":"Overlay","source":source(),"trackId":track_id});
    for (field, value) in [
        ("projectId", json!("wrong-project")),
        ("startSeconds", json!(-1)),
        ("trackId", json!("missing-track")),
        ("name", json!("")),
    ] {
        let mut input = base.clone();
        input[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.hyperframes.import",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
        assert_eq!(runtime.snapshot().unwrap(), before);
    }
    let mut input = base.clone();
    input["source"]["resourceAssetIds"] = json!({"assets/voice.wav":"missing-asset"});
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.hyperframes.import",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("timeline.hyperframes.import", cancelled, base.clone())
            .await
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
    invoke(
        &runtime,
        "timeline.track.update",
        json!({"id":track_id,"patch":{"locked":true}}),
    )
    .await;
    let locked = runtime.snapshot().unwrap();
    let mut input = base;
    input["expectedRevision"] = json!(locked.revision);
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.hyperframes.import",
                InvocationContext::default(),
                input
            )
            .await
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), locked);
}
