use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const GROUP: &str = "timeline.classic.multicam.recordings.group";
const CREATE: &str = "timeline.classic.multicam.create";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn read(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn fixture() -> (OpenCutRuntime, Value, Value) {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["settings"]["fps"] = json!({"numerator":25,"denominator":1});
    let mut assets = vec![
        json!({"id":"v1","name":"Shared camera","type":"video","duration":200.}),
        json!({"id":"v2","name":"Other camera","type":"video","duration":200.}),
    ];
    for (token, first) in [("9P8H", 5), ("AHQC", 5), ("AX5F", 3)] {
        for (i, time, duration) in [(0, "1635", 1800.15), (1, "1705", 100.)] {
            assets.push(json!({"id":format!("{token}-{i}"),"name":format!("20260720_{time}_{:04}_32Float_{token}.wav",first+i),"type":"audio","duration":duration,"bindingRevision":2}));
        }
    }
    classic["mediaAssets"] = json!(assets);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let state = read(&r).await;
    let request = json!({"projectId":"classic-project","expectedRevision":state["revision"],"mediaIds":assets.iter().filter(|a|a["type"]=="audio").map(|a|a["id"].clone()).collect::<Vec<_>>()});
    let groups = call(&r, GROUP, request).await;
    assert_eq!(groups["issues"], json!([]));
    let ids: Vec<_> = groups["microphones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    let channels:Vec<_>=["v1","v2"].iter().map(|v|json!({"id":v,"name":v,"videoId":v,"audioId":"9P8H-0","videoBindingRevision":0,"audioBindingRevision":2,"videoOffset":0.,"audioOffset":0.,"audioDelay":0.,"videoDelay":0.})).collect();
    let input = json!({"projectId":"classic-project","expectedRevision":state["revision"],"plan":{
        "settings":classic_podcast::podcast_multicam_defaults(classic_podcast::PodcastMulticamDefaultsOptions{quick:true}),
        "channels":channels,"duration":100.,"cuts":[{"timestamp":0.,"duration":100.,"channelId":"v1"}],
        "advanced":{"microphones":groups["microphones"],"starts":{"20260720-9P8H":-1790.15,"20260720-AHQC":3.123,"20260720-AX5F":5.},"routing":{"microphoneIds":ids,"cameras":[{"channelId":"v1","microphoneIds":ids},{"channelId":"v2","microphoneIds":ids}]}}
    }});
    (r, input, state)
}
#[tokio::test]
async fn provenance_continuous_segments_shared_cameras_roundtrip_undo_and_dry_run() {
    let (r, input, before) = fixture().await;
    let dry = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    r.registry()
        .invoke(CREATE, dry, input.clone())
        .await
        .unwrap();
    assert_eq!(read(&r).await, before);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("advanced-1"));
    let receipt = r
        .registry()
        .invoke(CREATE, context.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        r.registry()
            .invoke(CREATE, context, input.clone())
            .await
            .unwrap(),
        receipt
    );
    let after = read(&r).await;
    let scene = after["project"]["classic"]["document"]["scenes"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert_eq!(scene["multicam"]["advanced"], input["plan"]["advanced"]);
    let tracks = scene["tracks"]["audio"].as_array().unwrap();
    assert_eq!(tracks.len(), 3);
    let track = tracks
        .iter()
        .find(|t| t["name"].as_str().unwrap().contains("9P8H"))
        .unwrap();
    let e = track["elements"].as_array().unwrap();
    assert_eq!(e.len(), 2);
    assert_eq!(e[0]["startTime"], 0);
    assert_eq!(e[0]["duration"], 1200000);
    assert_eq!(e[1]["startTime"], 1200000);
    assert_eq!(e[1]["duration"], 10800000);
    assert_eq!(e[0]["podcastRecorderToken"], "9P8H");
    assert_eq!(e[1]["podcastSequence"], 6);
    assert_eq!(e[0]["mediaId"], "9P8H-0");
    assert_eq!(e[1]["mediaId"], "9P8H-1");
    call(&r, "history.undo", json!({})).await;
    assert_eq!(read(&r).await["project"], before["project"]);
    call(&r, "history.redo", json!({})).await;
    assert_eq!(read(&r).await["project"], after["project"]);
    assert_eq!(
        r.registry().descriptor(GROUP).unwrap().unwrap().access,
        AccessLevel::Read
    );
}
#[tokio::test]
async fn wrong_microphone_missing_segment_stale_binding_and_unknown_mapping_are_atomic() {
    let (r, input, before) = fixture().await;
    for (path, value) in [
        (
            "/plan/advanced/microphones/0/segments/1/recording/mediaId",
            json!("AHQC-1"),
        ),
        (
            "/plan/advanced/microphones/0/segments/1/sequence",
            json!(99),
        ),
        (
            "/plan/advanced/microphones/0/segments/0/recording/bindingRevision",
            json!(3),
        ),
        (
            "/plan/advanced/routing/cameras/0/microphoneIds",
            json!(["wrong"]),
        ),
        ("/expectedRevision", json!(0)),
    ] {
        let mut bad = input.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert!(
            r.registry()
                .invoke(CREATE, InvocationContext::default(), bad)
                .await
                .is_err(),
            "{path}"
        );
        assert_eq!(read(&r).await, before);
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(r.registry().invoke(CREATE, context, input).await.is_err());
    assert_eq!(read(&r).await, before);
}
#[tokio::test]
async fn advanced_high_bleed_routes_independent_mics_to_shared_cameras() {
    let (r, _, state) = fixture().await;
    let mut a = vec![0.8; 1200];
    let mut b = vec![0.65; 1200];
    a[600..].fill(0.65);
    b[600..].fill(0.8);
    let out=call(&r,"timeline.classic.multicam.analyze",json!({"projectId":"classic-project","expectedRevision":state["revision"],"options":{
        "duration":12.,"channelIds":["v1","v2"],"envelopes":[a,b],"settings":classic_podcast::podcast_multicam_defaults(classic_podcast::PodcastMulticamDefaultsOptions{quick:true}),
        "advanced":{"microphoneIds":["one","two"],"cameras":[{"channelId":"v1","microphoneIds":["one"]},{"channelId":"v2","microphoneIds":["two"]}]}
    }})).await;
    let cuts = out["cuts"].as_array().unwrap();
    assert_eq!(cuts[0]["channelId"], "v1");
    assert!(cuts.iter().any(|c| c["channelId"] == "v2"));
    assert_eq!(
        cuts.iter()
            .map(|c| c["duration"].as_f64().unwrap())
            .sum::<f64>(),
        12.
    );
}

#[tokio::test]
async fn inline_camera_suggestions_read_registered_names_without_creating_virtual_assets() {
    let r = OpenCutRuntime::default();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"] = json!([
        {"id":"alt","name":"C7458Shlishiyaangle1.MP4","type":"video","duration":4445.28},
        {"id":"main","name":"C7458Shlishya Main Angle.MP4","type":"video","duration":4428.48},
        {"id":"single","name":"C7460Avihay.MP4","type":"video","duration":4360.8},
        {"id":"mic1","name":"20260720_1634_0005_32Float_9P8HShlishya1.wav","type":"audio","duration":1800.15},
        {"id":"mic4","name":"20260720_1635_0003_32Float_BCZ9Avihay.wav","type":"audio","duration":1800.15}
    ]);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let before = read(&r).await;
    let input = json!({"projectId":"classic-project","expectedRevision":before["revision"],"videoIds":["alt","main","single"],"recordingIds":["mic1","mic4"]});
    let out = call(
        &r,
        "timeline.classic.multicam.cameras.suggest",
        input.clone(),
    )
    .await;
    assert_eq!(out["groups"].as_array().unwrap().len(), 2);
    assert_eq!(out["groups"][0]["preferredCameraId"], "main");
    assert_eq!(out["groups"][0]["microphoneIds"], json!(["20260720-9P8H"]));
    assert_eq!(out["groups"][1]["microphoneIds"], json!(["20260720-BCZ9"]));
    assert_eq!(read(&r).await, before);
    let mut stale = input;
    stale["expectedRevision"] = json!(0);
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.multicam.cameras.suggest",
                InvocationContext::default(),
                stale
            )
            .await
            .is_err()
    );
}
