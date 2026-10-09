use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const AUDIO: &str = "timeline.classic.audio.source.edit";

#[tokio::test]
async fn extraction_preserves_sync_offsets_and_audio_fades_for_playback_and_export() {
    for offset in [-0.25, 1.25] {
        let mut classic = fixture();
        let source = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
        source["params"]["audioSyncOffset"] = json!(offset);
        source["params"]["fadeInDuration"] = json!(0.4);
        source["params"]["fadeOutDuration"] = json!(0.6);
        let runtime = attached(classic).await;
        let original = read(&runtime).await;
        call(&runtime, AUDIO, input(&original, "extract")).await;
        let edited = read(&runtime).await;
        let tracks = &edited["project"]["classic"]["document"]["scenes"][0]["tracks"];
        let video = &tracks["main"]["elements"][0];
        let audio = &tracks["audio"][0]["elements"][0];
        for key in ["audioSyncOffset", "fadeInDuration", "fadeOutDuration"] {
            assert_eq!(audio["params"][key], video["params"][key]);
        }
        let timing = |clip: &Value| {
            serde_json::to_value(classic_timeline::resolve_clip_audio_timing(
                classic_timeline::ClipAudioTimingOptions {
                    start_time: clip["startTime"].as_f64().unwrap() / 120000.0,
                    duration: clip["duration"].as_f64().unwrap() / 120000.0,
                    trim_start: clip["trimStart"].as_f64().unwrap() / 120000.0,
                    rate: clip["retime"]["rate"].as_f64().unwrap(),
                    offset_seconds: clip["params"]["audioSyncOffset"].as_f64().unwrap(),
                },
            ))
            .unwrap()
        };
        assert_eq!(timing(audio), timing(video));
        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], original["project"]);
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(read(&runtime).await["project"], edited["project"]);
    }
}

#[tokio::test]
async fn empty_and_composite_volume_channels_preserve_defaults_and_shared_new_key_ids() {
    for volume in [
        Value::Null,
        json!({}),
        json!({"keys":[]}),
        json!({
            "left":{"keys":[{"id":"shared","time":100,"value":-3}]},
            "right":{"keys":[{"id":"shared","time":100,"value":-4},{"id":"right-only","time":0,"value":-2}]},
            "unused":null
        }),
    ] {
        let mut classic = fixture();
        let source = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
        source["params"] = json!({});
        source["sourceDuration"] = Value::Null;
        source["animations"]["volume"] = volume.clone();
        let runtime = attached(classic).await;
        call(&runtime, AUDIO, input(&read(&runtime).await, "extract")).await;
        let state = read(&runtime).await;
        let audio = &state["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"][0]["elements"]
            [0];
        assert_eq!(audio["params"], json!({"volume":0,"muted":false}));
        assert_eq!(audio.get("sourceDuration"), Some(&Value::Null));
        if volume.get("left").is_none() {
            assert!(audio.get("animations").is_none());
        } else {
            let volume = &audio["animations"]["volume"];
            assert!(volume.get("unused").is_none());
            assert_eq!(
                volume["left"]["keys"][0]["id"],
                volume["right"]["keys"][1]["id"]
            );
            assert_ne!(volume["right"]["keys"][0]["id"], "right-only");
            assert_eq!(volume["right"]["keys"][0]["time"], 0);
            assert_ne!(volume["left"]["keys"][0]["id"], "shared");
        }
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
fn fixture() -> Value {
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let source = &mut classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    source["params"]["volume"] = json!(-6);
    source["params"]["muted"] = json!(true);
    source["sourceDuration"] = json!(1_920_000);
    source["retime"]["maintainPitch"] = json!(false);
    source["animations"] = json!({"volume":{"extrapolation":{"before":"hold","after":"linear"},"futureChannel":true,"keys":[
        {"id":"late","time":120000,"value":-10,"segmentToNext":"bezier","tangentMode":"broken","leftHandle":{"dt":-240000,"dv":3},"rightHandle":{"dt":500,"dv":2}},
        {"id":"early","time":0,"value":0,"segmentToNext":"linear","leftHandle":{"dt":-1,"dv":0},"rightHandle":{"dt":240000,"dv":5},"futureKey":"preserve"}
    ]},"opacity":{"keys":[{"id":"opacity","time":0,"value":0.5}]}});
    classic
}
async fn attached(classic: Value) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input(state: &Value, action: &str) -> Value {
    json!({"projectId":"classic-project","expectedRevision":state["revision"],"sceneId":"main-scene","trackId":"video-track","elementId":"item-2","action":action})
}

#[tokio::test]
async fn extraction_preserves_source_and_volume_curves_with_independent_ids_and_durable_history() {
    let runtime = attached(fixture()).await;
    let original = read(&runtime).await;
    let request = input(&original, "extract");
    let dry = runtime
        .registry()
        .invoke(
            AUDIO,
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(read(&runtime).await, original);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("extract-one"));
    let receipt = runtime
        .registry()
        .invoke(AUDIO, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(AUDIO, context, request)
            .await
            .unwrap(),
        receipt
    );
    let result = receipt.result.data;
    assert_eq!(result["audioElementId"], dry["audioElementId"]);
    assert_eq!(result["audioTrackId"], dry["audioTrackId"]);
    let edited = read(&runtime).await;
    let tracks = &edited["project"]["classic"]["document"]["scenes"][0]["tracks"];
    let track = &tracks["audio"][0];
    let audio = &track["elements"][0];
    assert_eq!(track["id"], result["audioTrackId"]);
    assert_eq!(track["name"], "Audio track");
    assert_eq!(tracks["order"][0], track["id"]);
    assert_eq!(audio["id"], result["audioElementId"]);
    let mut expected = original["project"]["classic"].clone();
    expected["document"]["scenes"][0]["tracks"]["audio"] = tracks["audio"].clone();
    expected["document"]["scenes"][0]["tracks"]["order"] = tracks["order"].clone();
    expected["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["isSourceAudioEnabled"] =
        json!(false);
    assert_eq!(edited["project"]["classic"], expected);
    let source =
        &original["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    for key in [
        "name",
        "mediaId",
        "startTime",
        "duration",
        "trimStart",
        "trimEnd",
        "sourceDuration",
        "retime",
    ] {
        assert_eq!(audio[key], source[key]);
    }
    assert_eq!(
        audio["params"],
        json!({"volume":-6,"muted":true,"audioSyncOffset":0.1})
    );
    assert_eq!(audio["sourceType"], "upload");
    assert!(audio.get("masks").is_none() && audio.get("effects").is_none());
    assert!(audio["animations"].get("opacity").is_none());
    let keys = audio["animations"]["volume"]["keys"].as_array().unwrap();
    assert_eq!(keys[0]["time"], 0);
    assert_eq!(keys[1]["time"], 120000);
    assert_eq!(keys[0]["futureKey"], "preserve");
    assert_eq!(keys[0]["tangentMode"], "flat");
    assert!(keys[0].get("leftHandle").is_none());
    assert!(keys[1].get("rightHandle").is_none());
    assert_eq!(keys[0]["rightHandle"]["dt"], 120000);
    assert_eq!(keys[1]["leftHandle"]["dt"], -120000);
    assert_ne!(keys[0]["id"], "early");
    assert_ne!(keys[1]["id"], "late");
    assert_ne!(keys[0]["id"], keys[1]["id"]);
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
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], original["project"]);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(read(&reopened).await["project"], edited["project"]);
    call(&reopened, AUDIO, input(&read(&reopened).await, "recover")).await;
    let recovered = read(&reopened).await;
    assert_eq!(
        recovered["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"],
        tracks["audio"]
    );
    assert_eq!(
        recovered["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["isSourceAudioEnabled"],
        true
    );
    let descriptor = runtime.registry().descriptor(AUDIO).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(!descriptor.open_world);
}

#[tokio::test]
async fn placement_uses_display_order_exact_boundaries_and_generates_noncolliding_ids() {
    let mut classic = fixture();
    let tracks = &mut classic["document"]["scenes"][0]["tracks"];
    let element = |id, start, duration| json!({"id":id,"type":"audio","startTime":start,"duration":duration,"trimStart":0,"trimEnd":0});
    tracks["audio"] = json!([
        {"id":"free-later","type":"audio","muted":false,"elements":[]},
        {"id":"busy","type":"audio","muted":false,"elements":[element("classic-audio-1",500,10)]},
        {"id":"touching","type":"audio","muted":true,"futureTrack":1,"elements":[element("touch-end",1200000,100)]}
    ]);
    tracks["order"] = json!(["titles", "busy", "touching", "video-track", "free-later"]);
    let runtime = attached(classic).await;
    let original = read(&runtime).await;
    let result = call(&runtime, AUDIO, input(&original, "toggle")).await;
    assert_eq!(result["audioTrackId"], "touching");
    assert_ne!(result["audioElementId"], "classic-audio-1");
    let after = read(&runtime).await;
    let tracks = &after["project"]["classic"]["document"]["scenes"][0]["tracks"];
    assert_eq!(
        tracks["order"],
        original["project"]["classic"]["document"]["scenes"][0]["tracks"]["order"]
    );
    assert_eq!(tracks["audio"].as_array().unwrap().len(), 3);
    assert_eq!(tracks["audio"][2]["elements"].as_array().unwrap().len(), 2);
    assert_eq!(tracks["audio"][2]["muted"], true);
    assert_eq!(tracks["audio"][2]["futureTrack"], 1);
    call(&runtime, AUDIO, input(&after, "toggle")).await;
    assert_eq!(
        read(&runtime).await["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"],
        tracks["audio"]
    );
}

#[tokio::test]
async fn invalid_scope_media_and_duplicate_extract_are_atomic_and_recovery_needs_no_media() {
    let runtime = attached(fixture()).await;
    let before = read(&runtime).await;
    let mut invalid_classic = before["project"]["classic"].clone();
    invalid_classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["isSourceAudioEnabled"] =
        json!("disabled");
    assert!(runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":before["revision"],"classic":invalid_classic})).await.is_err());
    assert_eq!(read(&runtime).await, before);
    for (key, value) in [
        ("projectId", json!("other")),
        ("sceneId", json!("other-scene")),
        ("trackId", json!("missing")),
        ("elementId", json!("text-1")),
        ("expectedRevision", json!(0)),
        ("action", json!("delete")),
    ] {
        let mut request = input(&before, "extract");
        request[key] = value;
        assert!(
            runtime
                .registry()
                .invoke(AUDIO, InvocationContext::default(), request)
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(AUDIO, context, input(&before, "extract"))
            .await
            .is_err()
    );
    call(&runtime, AUDIO, input(&before, "extract")).await;
    let separated = read(&runtime).await;
    assert!(
        runtime
            .registry()
            .invoke(
                AUDIO,
                InvocationContext::default(),
                input(&separated, "extract")
            )
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, separated);
    for mode in ["missing", "silent", "zero", "bad-curve"] {
        let mut classic = fixture();
        match mode {
            "missing" => classic["mediaAssets"] = json!([]),
            "silent" => classic["mediaAssets"][0]["hasAudio"] = json!(false),
            "zero" => {
                classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["duration"] =
                    json!(0)
            }
            _ => {
                classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["animations"]["volume"]
                    ["keys"][0]["time"] = json!(0.5)
            }
        }
        let runtime = attached(classic).await;
        let before = read(&runtime).await;
        assert!(
            runtime
                .registry()
                .invoke(
                    AUDIO,
                    InvocationContext::default(),
                    input(&before, "extract")
                )
                .await
                .is_err(),
            "{mode}"
        );
        assert_eq!(read(&runtime).await, before);
    }
    let mut classic = fixture();
    classic["mediaAssets"] = json!([]);
    classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0]["isSourceAudioEnabled"] =
        json!(false);
    let runtime = attached(classic).await;
    call(&runtime, AUDIO, input(&read(&runtime).await, "toggle")).await;
    assert_eq!(
        read(&runtime).await["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"]["elements"]
            [0]["isSourceAudioEnabled"],
        true
    );
}
