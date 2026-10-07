use opencut_editor_api::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    task::{Context, Waker},
};

async fn setup() -> (OpenCutRuntime, HostBridge) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_hyperframes_authoring(&rt, &host).unwrap();
    register_editor_render_capabilities(&rt, &host).unwrap();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    rt.registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    (rt, host)
}
fn source() -> HyperframesSource {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../resources/hyperframes/catalog.json")).unwrap();
    let prepared = &catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "lt-clean-bar")
        .unwrap()["prepared"];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/hyperframes")
        .join(prepared["sourcePath"].as_str().unwrap());
    let files = prepared["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let name = f["path"].as_str().unwrap();
            (
                name.to_owned(),
                std::fs::read_to_string(root.join(name)).unwrap(),
            )
        })
        .collect();
    HyperframesSource {
        entry_file: "lt-clean-bar.html".into(),
        files,
        resource_asset_ids: BTreeMap::new(),
        variables: BTreeMap::new(),
    }
}
fn manifest(source: &HyperframesSource) -> Value {
    json!({"sourceFingerprint":source.fingerprint(),"runtimeVersion":"fixture","durationSeconds":4.8,"layers":[],"diagnostics":[]})
}

#[tokio::test]
async fn reference_import_remix_readback_and_undo_use_one_document() {
    let (rt, host) = setup().await;
    let input = json!({"projectId":"classic-project","expectedRevision":1,"id":"lt-clean-bar","upstreamCommit":"4c4b8574406cc566d28778a13f22c072d727a871","name":"Reference","startSeconds":0});
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("import-once"));
    let mut call = std::pin::pin!(rt.registry().invoke(
        "hyperframes.examples.import",
        context.clone(),
        input.clone()
    ));
    assert!(
        call.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    let source = source();
    host.settle(
        effect.id,
        HostEffectResult::Success {
            data: json!({"source":source,"manifest":manifest(&source)}),
        },
    )
    .unwrap();
    let imported = call.await.unwrap();
    let replay = rt
        .registry()
        .invoke("hyperframes.examples.import", context, input)
        .await
        .unwrap();
    assert_eq!(imported.result, replay.result);
    assert!(host.pending().unwrap().is_empty());
    let element = &imported.result.data["itemId"];
    let input = json!({"projectId":"classic-project","expectedRevision":2,"sceneId":"main-scene","elementId":element,"replacements":[{"filePath":"lt-clean-bar.html","find":"</style>","replace":".qa { color: red; }</style>"}]});
    let mut call = std::pin::pin!(rt.registry().invoke(
        "hyperframes.composition.remix",
        InvocationContext::default(),
        input
    ));
    assert!(
        call.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    let remixed: HyperframesSource =
        serde_json::from_value(effect.request["source"].clone()).unwrap();
    host.settle(
        effect.id,
        HostEffectResult::Success {
            data: json!({"source":remixed,"manifest":manifest(&remixed)}),
        },
    )
    .unwrap();
    call.await.unwrap();
    let state = rt
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert!(
        state
            .result
            .data
            .to_string()
            .contains(".qa { color: red; }")
    );
    rt.registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&rt.snapshot().unwrap())
            .unwrap()
            .contains(".qa { color: red; }")
    );
}
#[tokio::test]
async fn rejected_preflight_or_changed_revision_never_imports() {
    for mode in 0..3 {
        let (rt, host) = setup().await;
        let mut call=std::pin::pin!(rt.registry().invoke("hyperframes.examples.import",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":1,"id":"lt-clean-bar","upstreamCommit":"4c4b8574406cc566d28778a13f22c072d727a871","name":"Reference"})));
        assert!(
            call.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        let mut source = source();
        if mode == 0 {
            source.files.get_mut("lt-clean-bar.html").unwrap().push(' ');
        }
        if mode == 1 {
            rt.registry().invoke("project.classic.settings.update",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":1,"settings":{"fps":{"numerator":30,"denominator":1}}})).await.unwrap();
        }
        host.settle(
            effect.id,
            if mode == 2 {
                HostEffectResult::Rejected {
                    message: "Renderer failed".into(),
                }
            } else {
                HostEffectResult::Success {
                    data: json!({"manifest":manifest(&source),"source":source}),
                }
            },
        )
        .unwrap();
        assert!(call.await.is_err());
        assert!(
            rt.snapshot()
                .unwrap()
                .project
                .unwrap()
                .classic
                .unwrap()
                .document
                .compositions
                .is_none()
        );
    }
}
#[tokio::test]
async fn export_artifact_is_scope_bound_and_does_not_change_timeline() {
    for bad in [false, true] {
        let (rt, host) = setup().await;
        let before = serde_json::to_value(rt.snapshot().unwrap()).unwrap();
        let mut call=std::pin::pin!(rt.registry().invoke("editor.export.render",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":1,"sceneId":"main-scene","format":"webm","includeAudio":false})));
        assert!(
            call.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        let artifact = rt
            .artifacts()
            .put(vec![0x1a, 0x45, 0xdf, 0xa3], "video/webm", None, None, None)
            .unwrap();
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":if bad{"other"}else{"classic-project"},"revision":1,"sceneId":"main-scene","artifact":artifact,"media":{"durationSeconds":4.8,"width":1920,"height":1080,"frameRate":10.0,"packetCount":48,"videoTracks":1,"audioTracks":0,"codec":"vp9"}})}).unwrap();
        assert_eq!(call.await.is_err(), bad);
        assert_eq!(
            serde_json::to_value(rt.snapshot().unwrap()).unwrap(),
            before
        );
    }
}
