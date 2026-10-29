use base64::{Engine as _, engine::general_purpose::STANDARD};
use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_earshot_preview,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};

async fn setup() -> (OpenCutRuntime, HostBridge, Value) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_earshot_preview(&rt, &host).unwrap();
    rt.registry().invoke("project.classic.session.attach", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":0,"classic":serde_json::from_str::<Value>(include_str!("fixtures/classic-project.json")).unwrap()})).await.unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":rt.snapshot().unwrap().revision,
        "procedural":{"version":1,"engine":"earshot","bankRevision":"591fa3e028032e6dce56620a20e932e35667e8d8","presetId":"whoosh_fast/whip","seed":42,"duration":0.1},"offsetSeconds":0.02,"durationSeconds":0.02});
    (rt, host, input)
}

#[tokio::test]
async fn preview_is_canonical_bounded_audio_evidence_without_document_mutation() {
    let (rt, host, input) = setup().await;
    let before = rt.snapshot().unwrap();
    let descriptor = rt
        .registry()
        .descriptor("audio.earshot.preview")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Write);
    assert!(
        descriptor.open_world
            && descriptor.cancellable
            && !descriptor.transactional
            && !descriptor.supports_dry_run
    );
    let mut pending = std::pin::pin!(rt.registry().invoke(
        "audio.earshot.preview",
        InvocationContext::default(),
        input
    ));
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "earshotPreview");
    assert_eq!(effect.request["startFrame"], 960);
    assert_eq!(effect.request["frames"], 960);
    let bytes: Vec<u8> = (0..960).flat_map(|_| 16384_i16.to_le_bytes()).collect();
    host.settle(
        effect.id,
        HostEffectResult::Success {
            data: json!({"channels":1,"pcm16Base64":STANDARD.encode(&bytes)}),
        },
    )
    .unwrap();
    let result = pending.await.unwrap().result;
    assert_eq!(result.data["peak"], 0.5);
    assert_eq!(result.data["rms"], 0.5);
    assert_eq!(result.artifacts.len(), 1);
    let artifact = rt.artifacts().get(&result.artifacts[0].uri).unwrap();
    assert_eq!(artifact.metadata.mime_type, "audio/wav");
    assert_eq!(&artifact.bytes[..4], b"RIFF");
    assert_eq!(&artifact.bytes[44..], &bytes);
    assert_eq!(rt.snapshot().unwrap(), before);
}

#[tokio::test]
async fn invalid_scope_and_windows_do_not_execute_host() {
    let (rt, host, input) = setup().await;
    for patch in [
        json!({"projectId":"other"}),
        json!({"expectedRevision":0}),
        json!({"offsetSeconds":0.1}),
        json!({"durationSeconds":9}),
        json!({"durationSeconds":0.001}),
        json!({"offsetSeconds":-1}),
    ] {
        let mut bad = input.clone();
        bad.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(
            rt.registry()
                .invoke("audio.earshot.preview", InvocationContext::default(), bad)
                .await
                .is_err()
        );
        assert!(host.pending().unwrap().is_empty());
    }
    let context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    assert!(
        rt.registry()
            .invoke("audio.earshot.preview", context, input)
            .await
            .is_err()
    );
    assert!(host.pending().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_stale_scope_or_wrong_pcm_never_publish_artifacts() {
    for mode in 0..3 {
        let (rt, host, input) = setup().await;
        let context = InvocationContext::default();
        let token = context.cancellation.clone();
        let mut pending = std::pin::pin!(rt.registry().invoke(
            "audio.earshot.preview",
            context,
            input
        ));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        if mode == 0 {
            token.cancel();
        }
        if mode == 1 {
            rt.registry()
                .invoke(
                    "project.close",
                    InvocationContext::default(),
                    json!({"projectId":"classic-project"}),
                )
                .await
                .unwrap();
        }
        host.settle(effect.id, HostEffectResult::Success {data:json!({"channels":1,"pcm16Base64":STANDARD.encode(vec![0_u8; if mode==2 {2} else {1920}])})}).unwrap();
        assert!(pending.await.is_err());
        assert!(rt.artifacts().list().unwrap().is_empty());
        assert!(host.pending().unwrap().is_empty());
    }
}

#[tokio::test]
async fn cancelling_without_a_host_reply_releases_the_noncommitting_slot() {
    let (rt, host, input) = setup().await;
    let context = InvocationContext::default();
    let token = context.cancellation.clone();
    let mut pending = std::pin::pin!(
        rt.registry()
            .invoke("audio.earshot.preview", context, input)
    );
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    assert_eq!(host.pending().unwrap().len(), 1);
    token.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_millis(250), pending)
        .await
        .expect("cancel must not wait for the host");
    assert!(result.is_err());
    assert!(host.pending().unwrap().is_empty());
    assert!(rt.artifacts().list().unwrap().is_empty());
}
