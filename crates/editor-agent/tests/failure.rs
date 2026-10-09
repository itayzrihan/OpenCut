use opencut_editor_agent::*;
use opencut_editor_api::{AccessLevel, HostBridge, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn setup() -> (OpenCutRuntime, RuntimeAgent) {
    let runtime = OpenCutRuntime::default();
    let classic: Value = serde_json::from_str(include_str!(
        "../../editor-api/tests/fixtures/classic-project.json"
    ))
    .unwrap();
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    let agent = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "alice".into(),
            project_id: "classic-project".into(),
            run_id: "failure-run".into(),
        },
        "Edit and verify".into(),
        AccessLevel::Write,
    )
    .unwrap();
    (runtime, agent)
}
#[tokio::test]
async fn unverified_edits_can_end_as_failed_without_success_or_replay_after_reopening() {
    let (runtime, mut agent) = setup().await;
    agent
        .plan(
            agent.run().epoch(),
            vec![PlanStep {
                title: "Edit and inspect".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    agent
        .describe(agent.run().epoch(), "timeline.classic.transitions.apply")
        .unwrap();
    agent.invoke_immediate(agent.run().epoch(),"fade","timeline.classic.transitions.apply",json!({"sceneId":"main-scene","applications":[{"trackId":"video-track","elementId":"item-2","presetId":"fade","side":"in"}]})).unwrap();
    let changed = runtime.snapshot().unwrap();
    assert!(agent.finish(agent.run().epoch(), "Success".into()).is_err());
    agent
        .model_action(
            agent.run().epoch(),
            "report",
            ModelAction::Fail {
                text: "לא הושלם: המעבר נוסף, אך בדיקת התמונה נכשלה.".into(),
            },
        )
        .unwrap();
    assert_eq!(agent.run().phase(), RunPhase::Failed);
    assert!(agent.is_closed());
    assert_eq!(runtime.snapshot().unwrap(), changed);
    assert_eq!(agent.run().plan()[0].status, PlanStatus::InProgress);
    let epoch = agent.run().epoch();
    agent.pause();
    assert_eq!(agent.run().phase(), RunPhase::Failed);
    assert_eq!(agent.run().epoch(), epoch);
    assert!(agent.resume(&agent.run().scope().clone()).is_err());
    let checkpoint = agent.checkpoint().unwrap();
    let restored = RuntimeAgent::restore_checkpoint(
        runtime.clone(),
        "alice",
        "classic-project",
        AccessLevel::Read,
        None,
        &checkpoint,
    )
    .unwrap();
    assert_eq!(restored.run().phase(), RunPhase::Failed);
    assert!(restored.is_closed());
    assert_eq!(restored.run().receipts(), agent.run().receipts());
    assert_eq!(restored.run().final_message(), agent.run().final_message());
    assert_eq!(runtime.snapshot().unwrap(), changed);
}
#[tokio::test]
async fn failure_cannot_discard_an_unreconciled_host_operation() {
    let (runtime, agent) = setup().await;
    let bridge = HostBridge::default();
    opencut_editor_api::register_editor_host_capabilities(&runtime, &bridge).unwrap();
    let mut agent = agent.with_host_bridge(bridge);
    agent
        .describe(agent.run().epoch(), "editor.ui.snapshot")
        .unwrap();
    let round=agent.provider_response(agent.run().epoch(),json!({"id":"snapshot-round","status":"completed","output":[{"type":"function_call","call_id":"snapshot","name":"opencut_editor","arguments":json!({"action":"invoke","id":"editor.ui.snapshot","input":{}}).to_string()}]})).unwrap();
    let pending = round.pending_host.unwrap();
    let before = runtime.snapshot().unwrap();
    assert!(
        agent
            .model_action(
                agent.run().epoch(),
                "premature-failure",
                ModelAction::Fail {
                    text: "Stop".into()
                }
            )
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(agent.pending_host_effect().unwrap().unwrap()).unwrap(),
        serde_json::to_value(pending).unwrap()
    );
    assert!(!agent.is_closed());
    assert_eq!(runtime.snapshot().unwrap(), before);
    let mut forged: Value = serde_json::from_str(&agent.checkpoint().unwrap()).unwrap();
    forged["run"]["phase"] = json!("failed");
    assert!(
        RuntimeAgent::restore_checkpoint(
            runtime.clone(),
            "alice",
            "classic-project",
            AccessLevel::Write,
            None,
            &forged.to_string()
        )
        .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
}
