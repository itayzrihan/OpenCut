use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
    register_classic_automation_host,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};

async fn setup(action: &str) -> (OpenCutRuntime, HostBridge) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_classic_automation_host(&rt, &host).unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["metadata"]["id"] = json!("11111111-1111-4111-8111-111111111111");
    rt.registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    rt.registry().invoke("project.classic.automation.edit", InvocationContext::default(), json!({"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":rt.snapshot().unwrap().revision,"change":{"type":"enqueue","jobs":[{"id":"22222222-2222-4222-8222-222222222222","sceneId":"main-scene","workerProjectId":"33333333-3333-4333-8333-333333333333","outputSceneId":"output","action":action,"options":{"zoom":false,"transitions":false,"wordAnimation":true,"music":false,"soundEffects":true}}]}})).await.unwrap();
    (rt, host)
}
fn input(rt: &OpenCutRuntime) -> Value {
    json!({"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":rt.snapshot().unwrap().revision,"jobId":"22222222-2222-4222-8222-222222222222"})
}
async fn inspect_effect(
    rt: &OpenCutRuntime,
    host: &HostBridge,
    operation: &str,
    candidate: bool,
    tamper: bool,
) -> bool {
    let id = format!("project.classic.automation.{operation}");
    let args = input(rt);
    let mut invocation = std::pin::pin!(rt.registry().invoke(
        &id,
        InvocationContext::default(),
        args.clone()
    ));
    assert!(
        invocation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(effect.adapter, "sceneAutomation");
    assert_eq!(effect.request["operation"], operation);
    assert_eq!(!effect.request["worker"].is_null(), candidate);
    let job = &effect.request["job"];
    if candidate {
        assert_eq!(
            effect.request["worker"]["automationSource"]["sourceFingerprint"],
            job["sourceFingerprint"]
        );
        assert_eq!(
            effect.request["worker"]["metadata"]["id"],
            "33333333-3333-4333-8333-333333333333"
        );
    }
    let reply = json!({"projectId":"11111111-1111-4111-8111-111111111111","revision":args["expectedRevision"],"jobId":if tamper {"foreign"} else {"22222222-2222-4222-8222-222222222222"},"workerProjectId":"33333333-3333-4333-8333-333333333333","outputSceneId":"output","action":job["action"],"status":if operation=="cancel" {"cancelled"} else {"ready"},"completedStages":0,"cancelRequested":operation=="cancel","published":false,"message":"Scoped queue receipt"});
    host.settle(effect.id, HostEffectResult::Success { data: reply })
        .unwrap();
    invocation.await.is_ok()
}
#[tokio::test]
async fn all_earshot_workflows_launch_from_canonical_intent_without_a_second_edit() {
    for action in ["sound-effects", "word-animation", "full-auto"] {
        let (rt, host) = setup(action).await;
        let before = rt.snapshot().unwrap();
        let read = rt
            .registry()
            .invoke(
                "app.state.read",
                InvocationContext::default(),
                json!({"pointer":"/project/classic/document/automationEdits"}),
            )
            .await
            .unwrap();
        assert!(read.result.data.to_string().contains("sourceFingerprint"));
        assert!(read.result.data.to_string().contains("soundEffects"));
        assert!(inspect_effect(&rt, &host, "start", true, false).await);
        assert!(inspect_effect(&rt, &host, "start", true, false).await); // Same durable job, no re-enqueue.
        assert_eq!(rt.snapshot().unwrap(), before);
        for operation in ["status", "cancel"] {
            assert!(inspect_effect(&rt, &host, operation, false, false).await);
        }
        assert_eq!(rt.snapshot().unwrap(), before);
    }
}
#[tokio::test]
async fn stale_scope_dry_run_and_unknown_jobs_never_dispatch_host_io() {
    let (rt, host) = setup("sound-effects").await;
    let before = rt.snapshot().unwrap();
    for kind in [
        "revision",
        "project",
        "22222222-2222-4222-8222-222222222222",
        "dry",
    ] {
        let mut args = input(&rt);
        let mut context = InvocationContext::default();
        match kind {
            "revision" => args["expectedRevision"] = json!(0),
            "project" => args["projectId"] = json!("foreign"),
            "22222222-2222-4222-8222-222222222222" => args["jobId"] = json!("missing"),
            _ => context.dry_run = true,
        }
        assert!(
            rt.registry()
                .invoke("project.classic.automation.start", context, args)
                .await
                .is_err()
        );
        assert!(host.pending().unwrap().is_empty());
    }
    assert_eq!(rt.snapshot().unwrap(), before);
    let start = rt
        .registry()
        .descriptor("project.classic.automation.start")
        .unwrap()
        .unwrap();
    assert_eq!(start.access, AccessLevel::Write);
    assert!(
        start.idempotent
            && start.cancellable
            && start.open_world
            && !start.transactional
            && !start.supports_dry_run
    );
    assert_eq!(
        rt.registry()
            .descriptor("project.classic.automation.status")
            .unwrap()
            .unwrap()
            .access,
        AccessLevel::Write
    );
}
#[tokio::test]
async fn changed_source_never_recaptures_a_different_worker_and_bad_receipts_fail() {
    let (rt, host) = setup("word-animation").await;
    let args = input(&rt);
    rt.registry().invoke("app.state.patch", InvocationContext::default(), json!({"expectedRevision":args["expectedRevision"],"patch":[{"op":"replace","path":"/project/classic/document/scenes/0/name","value":"User changed the source"}]})).await.unwrap();
    assert!(inspect_effect(&rt, &host, "start", false, false).await);
    assert!(!inspect_effect(&rt, &host, "status", false, true).await);
}
#[tokio::test]
async fn cancelled_host_response_does_not_mutate_or_reenqueue_intent() {
    let (rt, host) = setup("full-auto").await;
    let before = rt.snapshot().unwrap();
    let context = InvocationContext::default();
    let cancellation = context.cancellation.clone();
    let mut invocation = std::pin::pin!(rt.registry().invoke(
        "project.classic.automation.start",
        context,
        input(&rt)
    ));
    assert!(
        invocation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    cancellation.cancel();
    host.settle(
        effect.id,
        HostEffectResult::Rejected {
            message: "Cancelled before launch".into(),
        },
    )
    .unwrap();
    assert!(invocation.await.is_err());
    assert_eq!(rt.snapshot().unwrap(), before);
}

#[tokio::test]
async fn status_cancels_without_waiting_for_a_missing_host_reply() {
    let (rt, host) = setup("sound-effects").await;
    let context = InvocationContext::default();
    let cancellation = context.cancellation.clone();
    let mut invocation = std::pin::pin!(rt.registry().invoke(
        "project.classic.automation.status",
        context,
        input(&rt)
    ));
    assert!(
        invocation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    assert_eq!(host.pending().unwrap().len(), 1);
    cancellation.cancel();
    assert!(invocation.await.is_err());
    assert!(host.pending().unwrap().is_empty());
}

#[tokio::test]
async fn publication_rejects_wrong_worker_origin_and_preserves_source() {
    let (rt, host) = setup("sound-effects").await;
    let before = rt.snapshot().unwrap();
    let mut invocation = std::pin::pin!(rt.registry().invoke(
        "project.classic.automation.start",
        InvocationContext::default(),
        input(&rt)
    ));
    assert!(
        invocation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    let mut worker = effect.request["worker"].clone();
    host.settle(
        effect.id,
        HostEffectResult::Rejected {
            message: "Inspection only".into(),
        },
    )
    .unwrap();
    assert!(invocation.await.is_err());
    worker["automationSource"]["jobId"] = json!("wrong-job");
    let media = &before
        .project
        .as_ref()
        .unwrap()
        .classic
        .as_ref()
        .unwrap()
        .media_assets;
    let result = rt.registry().invoke("project.classic.automation.edit", InvocationContext::default(), json!({"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":before.revision,"change":{"type":"publish","jobId":"22222222-2222-4222-8222-222222222222","worker":{"document":worker,"mediaAssets":media}}})).await;
    assert!(result.unwrap_err().to_string().contains("origin"));
    assert_eq!(rt.snapshot().unwrap(), before);
}
