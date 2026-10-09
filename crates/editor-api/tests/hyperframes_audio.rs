use opencut_editor_api::{
    HyperframesAudioPlan, HyperframesSource, InvocationContext, OpenCutRuntime,
};
use serde_json::{Value, json};

fn fixture() -> (HyperframesSource, Value) {
    let source: HyperframesSource = serde_json::from_value(json!({
        "entryFile":"index.html", "files":{"index.html":"<div data-composition-id='main' data-duration='6'></div>"},
        "resourceAssetIds":{"voice.wav":"voice", "video.mp4":"video"}
    })).unwrap();
    let plan = json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115",
    "durationSeconds":6.0,"elements":[{
        "id":"../author:voice", "src":"voice.wav", "start":0.5,"end":3.0,
        "mediaStart":0.25,"playbackRate":2,"layer":1,"volume":0.5,
        "fadeIn":0.2,"fadeOut":0.4,"groupId":"../author:bus","groupVolume":0.75,
        "groupFxChain":"[]", "volumeKeyframes":[{"time":0.5,"volume":0.25},{"time":2,"volume":1.5}],
        "type":"audio"
    },{
        "id":"second", "src":"video.mp4", "start":3,"end":6,"mediaStart":0,
        "playbackRate":{"target":"rate","points":[{"t":0,"v":1},{"t":1,"v":2,"curve":0.5}]},
        "layer":2,"volume":1,"groupId":"../author:bus","groupVolume":0.75,
        "groupFxChain":"[]", "type":"video"
    }]});
    (source, plan)
}

#[tokio::test]
async fn prepares_safe_mixer_ids_without_changing_timing_automation_or_editor_state() {
    let runtime = OpenCutRuntime::default();
    let before = runtime.snapshot().unwrap();
    let (source, plan) = fixture();
    let result = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"plan":plan}),
        )
        .await
        .unwrap()
        .result
        .data;
    let mut expected = plan;
    for (index, element) in expected["elements"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        element["id"] = json!(format!("track-{index}"));
        element["groupId"] = json!("group-0");
    }
    assert_eq!(
        serde_json::from_value::<HyperframesAudioPlan>(result.clone()).unwrap(),
        serde_json::from_value::<HyperframesAudioPlan>(expected.clone()).unwrap()
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
    // The prepared result is valid input again, allowing verification at the
    // final host boundary without changing its occurrence/group identity.
    let again = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"plan":result}),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(again, result);
}

#[tokio::test]
async fn rejects_stale_external_unbounded_and_inconsistent_audio_plans() {
    let runtime = OpenCutRuntime::default();
    let (source, plan) = fixture();
    let cases = [
        ("/sourceFingerprint", json!("stale")),
        ("/runtimeVersion", json!("future")),
        ("/durationSeconds", json!(1801)),
        ("/elements/0/src", json!("https://example.com/voice.wav")),
        ("/elements/0/src", json!("C:/private/voice.wav")),
        ("/elements/0/src", json!("index.html")),
        ("/elements/0/start", json!(-1)),
        ("/elements/0/end", json!(7)),
        ("/elements/0/mediaStart", json!(-1)),
        ("/elements/0/playbackRate", json!(0)),
        ("/elements/0/volume", json!(4.1)),
        ("/elements/0/fadeIn", json!(-0.1)),
        ("/elements/0/groupVolume", json!(0.8)),
        ("/elements/0/groupFxChain", json!("invalid JSON")),
        ("/elements/0/groupId", Value::Null),
        ("/elements/0/volumeKeyframes/1/time", json!(0.5)),
        ("/elements/0/volumeKeyframes/1/volume", json!(-1)),
        ("/elements/1/id", json!("../author:voice")),
        ("/elements/1/playbackRate/target", json!("volume")),
        ("/elements/1/playbackRate/points/1/t", json!(0)),
        ("/elements/1/playbackRate/points/1/v", json!(0)),
    ];
    for (path, value) in cases {
        let mut bad = plan.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.audio.prepare",
                    InvocationContext::default(),
                    json!({"source":source,"plan":bad})
                )
                .await
                .is_err(),
            "accepted {path}"
        );
    }
    let mut bad = plan.clone();
    bad["elements"] = json!(vec![plan["elements"][0].clone(); 33]);
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.prepare",
                InvocationContext::default(),
                json!({"source":source,"plan":bad})
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn empty_plan_is_valid_and_cancelled_plan_is_not_processed() {
    let runtime = OpenCutRuntime::default();
    let (source, mut plan) = fixture();
    plan["elements"] = json!([]);
    let result = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"plan":plan}),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(result, plan);
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.prepare",
                context,
                json!({"source":source,"plan":plan})
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn preparing_many_bus_instances_twice_keeps_the_same_membership() {
    let runtime = OpenCutRuntime::default();
    let (source, mut plan) = fixture();
    let original = plan["elements"][0].clone();
    plan["elements"] = Value::Array(
        (0..12)
            .map(|index| {
                let mut element = original.clone();
                element["id"] = json!(format!("instance-{index}"));
                element["groupId"] = json!(format!("nested-bus-{index}"));
                element
            })
            .collect(),
    );
    let first = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"plan":plan}),
        )
        .await
        .unwrap()
        .result
        .data;
    let second = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"plan":first}),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(first, second);
    assert_eq!(second["elements"][10]["groupId"], "group-10");
    assert_eq!(second["elements"][11]["groupId"], "group-11");
}

#[tokio::test]
async fn rejects_nested_audio_overhang_before_the_browser_probe() {
    let runtime = OpenCutRuntime::default();
    let (source, mut plan) = fixture();
    plan["elements"] = json!([]);
    let mut manifest = json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"0.8.115",
        "durationSeconds":6.0,"layers":[
            {"key":"host","parentKey":null,"file":"index.html","elementId":"host","label":"Host",
            "kind":"composition","startSeconds":0,"durationSeconds":1,"trackIndex":0,
            "resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null},
            {"key":"voice","parentKey":"host","file":"index.html","elementId":"voice","label":"Voice",
            "kind":"audio","startSeconds":0.5,"durationSeconds":2,"trackIndex":1,
            "resourcePath":"voice.wav","playbackStartSeconds":0,"playbackRate":1,
            "media":{"sourceDurationSeconds":6,"muted":false,"looping":false,"attributes":{}}}
        ],"diagnostics":[]});
    let error = runtime
        .registry()
        .invoke(
            "hyperframes.audio.prepare",
            InvocationContext::default(),
            json!({"source":source,"manifest":manifest,"plan":plan}),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("outside a nested composition window")
    );
    manifest["layers"][1]["media"]["muted"] = json!(true);
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.prepare",
                InvocationContext::default(),
                json!({"source":source,"manifest":manifest,"plan":plan})
            )
            .await
            .is_ok()
    );
    manifest["durationSeconds"] = json!(5);
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.audio.prepare",
                InvocationContext::default(),
                json!({"source":source,"manifest":manifest,"plan":plan})
            )
            .await
            .is_err()
    );
}
