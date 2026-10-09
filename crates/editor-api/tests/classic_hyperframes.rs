use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

fn classic() -> Value {
    serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap()
}
fn source() -> Value {
    json!({"entryFile":"index.html","files":{"index.html":"<div data-composition-id='main' data-duration='6' data-width='720' data-height='1280'><script>throw new Error('must not run during import')</script></div>"},"resourceAssetIds":{}})
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
async fn attach(runtime: &OpenCutRuntime, snapshot: Value) {
    call(
        runtime,
        "project.classic.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":snapshot}),
    )
    .await;
}
async fn state(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}

#[tokio::test]
async fn derived_audio_follows_canonical_trim_placement_mute_and_undo_without_new_tracks() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime, classic()).await;
    let before = state(&runtime).await;
    let imported = call(
        &runtime,
        "timeline.hyperframes.import",
        json!({
            "projectId":"classic-project", "expectedRevision":before["revision"],
            "name":"Audio composition", "source":source(), "startSeconds":8
        }),
    )
    .await;
    let original = state(&runtime).await;
    let scene_id = original["project"]["classic"]["document"]["currentSceneId"].clone();
    let read = |revision: Value| json!({"projectId":"classic-project", "sceneId":scene_id, "expectedRevision":revision});
    let projection = call(
        &runtime,
        "hyperframes.audio.clips.read",
        read(original["revision"].clone()),
    )
    .await;
    assert_eq!(projection["clips"].as_array().unwrap().len(), 1);
    assert_eq!(projection["clips"][0]["compositionId"], imported["assetId"]);
    assert_eq!(projection["clips"][0]["element"]["startTime"], 960_000);
    assert_eq!(projection["clips"][0]["element"]["duration"], 720_000);
    assert_eq!(state(&runtime).await, original);

    let mut snapshot = original["project"]["classic"].clone();
    let scenes = snapshot["document"]["scenes"].as_array_mut().unwrap();
    let scene = scenes
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
    element["duration"] = json!(600_000); // visual freeze after source end
    element["hidden"] = json!(true); // only visual visibility
    element["params"]["volume"] = json!(-6);
    element["params"]["fadeInDuration"] = json!(0.5);
    call(&runtime, "project.classic.commit", json!({"projectId":"classic-project", "expectedRevision":original["revision"], "classic":snapshot})).await;
    let edited = state(&runtime).await;
    let changed = call(
        &runtime,
        "hyperframes.audio.clips.read",
        read(edited["revision"].clone()),
    )
    .await;
    let audio = &changed["clips"][0]["element"];
    assert_eq!(audio["type"], "audio");
    assert_eq!(audio["startTime"], 240_000);
    assert_eq!(audio["trimStart"], 180_000);
    assert_eq!(audio["duration"], 540_000);
    assert_eq!(audio["trimEnd"], 0);
    assert_eq!(audio["params"]["volume"], -6);
    assert_eq!(audio["params"]["fadeInDuration"], 0.5);
    assert!(audio.get("hidden").is_none());
    assert_eq!(state(&runtime).await, edited);
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.clips.read",
                InvocationContext::default(),
                read(original["revision"].clone())
            )
            .await
            .is_err()
    );
    let mut wrong = read(edited["revision"].clone());
    wrong["projectId"] = json!("another-project");
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.clips.read",
                InvocationContext::default(),
                wrong
            )
            .await
            .is_err()
    );

    call(&runtime, "history.undo", json!({})).await;
    let undone = state(&runtime).await;
    assert_eq!(undone["project"], original["project"]);
    let restored = call(
        &runtime,
        "hyperframes.audio.clips.read",
        read(undone["revision"].clone()),
    )
    .await;
    assert_eq!(restored["clips"], projection["clips"]);
    call(&runtime, "history.redo", json!({})).await;
    let redone = state(&runtime).await;
    assert_eq!(redone["project"], edited["project"]);

    let mut muted = redone["project"]["classic"].clone();
    for scene in muted["document"]["scenes"].as_array_mut().unwrap() {
        for track in scene["tracks"]["overlay"].as_array_mut().unwrap() {
            if track["id"] == imported["trackId"] {
                track["muted"] = json!(true);
            }
        }
    }
    call(&runtime, "project.classic.commit", json!({"projectId":"classic-project", "expectedRevision":redone["revision"], "classic":muted})).await;
    let muted_state = state(&runtime).await;
    assert_eq!(
        call(
            &runtime,
            "hyperframes.audio.clips.read",
            read(muted_state["revision"].clone())
        )
        .await["clips"],
        json!([])
    );
}

#[tokio::test]
async fn composition_binary_assets_roundtrip_through_canonical_state_and_history() {
    let runtime = OpenCutRuntime::default();
    let mut original = classic();
    original["mediaAssets"].as_array_mut().unwrap().push(json!({
        "id":"package-font", "name":"assets/עברית.woff2", "type":"file",
        "mimeType":"font/woff2", "size":1024, "lastModified":100, "storageKind":"copied"
    }));
    attach(&runtime, original.clone()).await;
    let mut package = source();
    package["resourceAssetIds"]["assets/עברית.woff2"] = json!("package-font");
    let before = state(&runtime).await;
    let imported = call(
        &runtime,
        "timeline.hyperframes.import",
        json!({
            "projectId":"classic-project", "expectedRevision":before["revision"],
            "name":"Composition with a local font", "source":package
        }),
    )
    .await;
    let after = state(&runtime).await;
    let asset_id = imported["assetId"].as_str().unwrap();
    assert_eq!(
        after["project"]["classic"]["document"]["hyperframesCompositions"][asset_id]["source"],
        package
    );
    assert_eq!(
        after["project"]["classic"]["mediaAssets"],
        original["mediaAssets"]
    );
    let restored = OpenCutRuntime::default();
    restored
        .restore_application_state_from_bytes(&runtime.serialize_application_state().unwrap())
        .unwrap();
    assert_eq!(state(&restored).await["project"], after["project"]);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"]["classic"], original);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn folder_resources_and_clip_commit_as_one_undoable_import() {
    let runtime = OpenCutRuntime::default();
    let original = classic();
    attach(&runtime, original.clone()).await;
    let before = state(&runtime).await;
    let mut package = source();
    package["resourceAssetIds"]["assets/font.woff2"] = json!("folder-font");
    let resource = json!({"id":"folder-font", "name":"assets/font.woff2", "type":"file",
        "mimeType":"font/woff2", "fileName":"font.woff2", "size":1024, "lastModified":100, "storageKind":"copied"});
    let input = json!({"projectId":"classic-project", "expectedRevision":before["revision"],
        "name":"Complete folder", "source":package, "classicResourceAssets":[resource]});
    runtime
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
        .unwrap();
    assert_eq!(state(&runtime).await, before);
    call(&runtime, "timeline.hyperframes.import", input).await;
    let after = state(&runtime).await;
    assert_eq!(
        after["project"]["classic"]["mediaAssets"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        &resource
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"]["classic"], original);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], after["project"]);
}

#[tokio::test]
async fn invalid_folder_resources_cannot_replace_media_or_leave_partial_imports() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime, classic()).await;
    let before = state(&runtime).await;
    for resource in [
        json!({"id":"folder-font", "type":"file", "url":"blob:transient"}),
        json!({"id":"folder-font", "type":"unsupported"}),
        json!({"id":"unrelated", "type":"file"}),
        before["project"]["classic"]["mediaAssets"][0].clone(),
    ] {
        let mut package = source();
        package["resourceAssetIds"]["font.woff2"] = json!("folder-font");
        // An existing ID may be referenced, but cannot be overwritten by upload metadata.
        if resource == before["project"]["classic"]["mediaAssets"][0] {
            package["resourceAssetIds"]["font.woff2"] = resource["id"].clone();
        }
        assert!(
            runtime
                .registry()
                .invoke(
                    "timeline.hyperframes.import",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project", "expectedRevision":before["revision"],
                "name":"Invalid", "source":package, "classicResourceAssets":[resource]})
                )
                .await
                .is_err()
        );
        assert_eq!(state(&runtime).await, before);
    }
}

#[tokio::test]
async fn existing_classic_timeline_import_is_lossless_and_undoable() {
    let runtime = OpenCutRuntime::default();
    let original = classic();
    attach(&runtime, original.clone()).await;
    let before = state(&runtime).await;
    assert_eq!(before["project"]["classic"], original);
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"name":"Imported Brag","source":source()});
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("classic-import"));
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
    assert_eq!(state(&runtime).await, before);
    context.dry_run = false;
    let imported = runtime
        .registry()
        .invoke(
            "timeline.hyperframes.import",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke("timeline.hyperframes.import", context, input)
            .await
            .unwrap(),
        imported
    );
    let after = state(&runtime).await;
    let actual = &after["project"]["classic"];
    let imported_clip = &actual["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0];
    let imported_composition = &actual["document"]["hyperframesCompositions"]
        [imported_clip["params"]["hyperframesAssetId"]
            .as_str()
            .unwrap()];
    assert_eq!(
        imported_clip["params"]["sourceWidth"],
        imported_composition["width"]
    );
    assert_eq!(
        imported_clip["params"]["sourceHeight"],
        imported_composition["height"]
    );
    let expected = &original["document"];
    assert_eq!(actual["mediaAssets"], original["mediaAssets"]);
    for field in [
        "settings",
        "customFonts",
        "aiEditHistory",
        "futureFeature",
        "version",
    ] {
        assert_eq!(actual["document"][field], expected[field]);
    }
    assert_eq!(actual["document"]["scenes"][1], expected["scenes"][1]);
    for field in ["main", "audio", "futureTrackLayout"] {
        assert_eq!(
            actual["document"]["scenes"][0]["tracks"][field],
            expected["scenes"][0]["tracks"][field]
        );
    }
    assert_eq!(
        actual["document"]["scenes"][0]["tracks"]["overlay"][1],
        expected["scenes"][0]["tracks"]["overlay"][0]
    );
    assert_eq!(
        actual["document"]["scenes"][0]["parallax"],
        expected["scenes"][0]["parallax"]
    );
    let clip = &actual["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0];
    assert_eq!(clip["startTime"], 1_200_000);
    assert_eq!(clip["duration"], 720_000);
    assert_ne!(clip["id"], "item-2", "must avoid imported Classic IDs");
    assert_eq!(actual["document"]["metadata"]["duration"], 1_920_000);
    let asset_id = imported.result.data["assetId"].as_str().unwrap();
    assert_eq!(
        actual["document"]["hyperframesCompositions"][asset_id]["source"],
        source()
    );
    assert!(
        after["project"]["timeline"]["tracks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], before["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(state(&runtime).await["project"], after["project"]);
    let saved = runtime.serialize_application_state().unwrap();
    let reopened = OpenCutRuntime::default();
    reopened
        .restore_application_state_from_bytes(&saved)
        .unwrap();
    assert_eq!(state(&reopened).await, state(&runtime).await);
}

#[tokio::test]
async fn classic_commit_and_import_reject_stale_or_invalid_changes_atomically() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime, classic()).await;
    let before = state(&runtime).await;
    for overrides in [
        json!({"trackId":"video-track"}),
        json!({"trackId":"titles"}),
        json!({"projectId":"wrong"}),
        json!({"expectedRevision":0}),
        json!({"startSeconds":-0.000001}),
        json!({"startSeconds":1e15}),
    ] {
        let mut input = json!({"projectId":"classic-project","expectedRevision":1,"name":"Invalid","source":source()});
        input
            .as_object_mut()
            .unwrap()
            .extend(overrides.as_object().unwrap().clone());
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
        assert_eq!(state(&runtime).await, before);
    }
    let mut missing_resource = source();
    missing_resource["resourceAssetIds"] = json!({"audio.wav":"missing"});
    assert!(runtime.registry().invoke("timeline.hyperframes.import", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":1,"name":"Invalid resource","source":missing_resource})).await.is_err());
    assert_eq!(state(&runtime).await, before);
    // Native actions cannot create a second timeline beside the Classic scene.
    assert!(
        runtime
            .registry()
            .invoke(
                "timeline.track.add",
                InvocationContext::default(),
                json!({"name":"Parallel","kind":"video"})
            )
            .await
            .is_err()
    );
    assert_eq!(state(&runtime).await, before);
    let mut updated = classic();
    updated["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["params"]["transform.scaleX"] =
        json!(1.7);
    call(
        &runtime,
        "project.classic.commit",
        json!({"projectId":"classic-project","expectedRevision":1,"classic":updated}),
    )
    .await;
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(state(&runtime).await["project"]["classic"], classic());
}

#[tokio::test]
async fn import_uses_the_active_scene_and_keeps_main_project_duration() {
    let runtime = OpenCutRuntime::default();
    let mut original = classic();
    original["document"]["currentSceneId"] = json!("other-scene");
    attach(&runtime, original.clone()).await;
    call(&runtime, "timeline.hyperframes.import", json!({"projectId":"classic-project","expectedRevision":1,"name":"Other scene","source":source(),"startSeconds":0.5})).await;
    let after = state(&runtime).await;
    let actual = &after["project"]["classic"]["document"];
    assert_eq!(actual["scenes"][0], original["document"]["scenes"][0]);
    assert_eq!(
        actual["scenes"][1]["tracks"]["overlay"][0]["elements"][0]["startTime"],
        60_000
    );
    assert_eq!(actual["metadata"]["duration"], 1_200_000);
}

#[tokio::test]
async fn imported_dimensions_are_validated_and_older_clips_remain_readable() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime, classic()).await;
    call(
        &runtime,
        "timeline.hyperframes.import",
        json!({
            "projectId":"classic-project", "expectedRevision":1,
            "name":"Dimensions", "source":source()
        }),
    )
    .await;
    let before = state(&runtime).await;
    for dimensions in [json!({"sourceWidth":1}), json!({"sourceHeight":"1280"})] {
        let mut invalid = before["project"]["classic"].clone();
        invalid["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0]["params"]
            .as_object_mut()
            .unwrap()
            .extend(dimensions.as_object().unwrap().clone());
        assert!(runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({
            "projectId":"classic-project", "expectedRevision":before["revision"], "classic":invalid
        })).await.is_err());
        assert_eq!(state(&runtime).await, before);
    }
    let mut legacy = before["project"]["classic"].clone();
    let params = legacy["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0]["params"]
        .as_object_mut()
        .unwrap();
    params.remove("sourceWidth");
    params.remove("sourceHeight");
    call(
        &runtime,
        "project.classic.commit",
        json!({
            "projectId":"classic-project", "expectedRevision":before["revision"], "classic":legacy
        }),
    )
    .await;
    assert_eq!(state(&runtime).await["project"]["classic"], legacy);
}

#[tokio::test]
async fn malformed_classic_snapshots_fail_without_panicking_or_replacing_state() {
    let runtime = OpenCutRuntime::default();
    for snapshot in [json!({"document":{},"mediaAssets":[]}), {
        let mut invalid = classic();
        invalid["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["duration"] = json!(0.5);
        invalid
    }] {
        assert!(
            runtime
                .registry()
                .invoke(
                    "project.classic.attach",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project","expectedRevision":0,"classic":snapshot})
                )
                .await
                .is_err()
        );
        assert_eq!(runtime.snapshot().unwrap().revision, 0);
    }
}
