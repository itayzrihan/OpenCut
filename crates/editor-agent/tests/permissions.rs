use opencut_editor_agent::{
    AgentCommand, AgentScope, ModelAction, PlanStatus, PlanStep, RuntimeAgent,
};
use opencut_editor_api::{
    AccessLevel, CapabilityDescriptor, CapabilityExecution, CapabilityResult, DocumentSupport,
    FnCapability, HostBridge, InvocationContext, OpenCutRuntime, register_computer_capabilities,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn setup(mode: &str, computer: bool) -> (OpenCutRuntime, RuntimeAgent, Arc<AtomicUsize>) {
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
    let revision = runtime.snapshot().unwrap().revision;
    runtime.registry().invoke("agent.policy.set",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":revision,"mode":mode,"computerAccess":computer})).await.unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let hit = count.clone();
    let mut descriptor = CapabilityDescriptor::read(
        "test.destructive",
        "Delete test data",
        "A destructive action",
        "test",
        json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}),
        json!({"type":"object"}),
    );
    descriptor.access = AccessLevel::Destructive;
    descriptor.execution = CapabilityExecution::Immediate;
    descriptor.transactional = true;
    descriptor.document_support = DocumentSupport::Both;
    runtime
        .registry()
        .register(Arc::new(FnCapability::new(descriptor, move |_, _| {
            let hit = hit.clone();
            Box::pin(async move {
                hit.fetch_add(1, Ordering::SeqCst);
                Ok(CapabilityResult::data(json!({})))
            })
        })))
        .unwrap();
    let mut agent = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "alice".into(),
            project_id: "classic-project".into(),
            run_id: "policy-run".into(),
        },
        "Test permissions".into(),
        AccessLevel::Destructive,
    )
    .unwrap();
    agent
        .plan(
            agent.run().epoch(),
            vec![PlanStep {
                title: "Perform requested action".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    (runtime, agent, count)
}
fn invoke(
    agent: &mut RuntimeAgent,
    call: &str,
    value: i32,
) -> Result<Value, opencut_editor_agent::AgentError> {
    let epoch = agent.run().epoch();
    agent.describe(epoch, "test.destructive").unwrap();
    agent.model_action(
        epoch,
        call,
        ModelAction::Invoke {
            id: "test.destructive".into(),
            input: json!({"value":value}),
        },
    )
}
#[tokio::test]
async fn plan_blocks_writes_and_can_finish_a_proposal() {
    let (_, mut agent, count) = setup("plan", false).await;
    let epoch = agent.run().epoch();
    assert!(
        agent
            .invoke_immediate(epoch, "blocked", "test.destructive", json!({"value":1}))
            .unwrap_err()
            .to_string()
            .contains("Plan mode")
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    agent
        .plan(
            agent.run().epoch(),
            vec![PlanStep {
                title: "Proposed edit".into(),
                status: PlanStatus::Pending,
            }],
        )
        .unwrap();
    agent
        .finish(
            agent.run().epoch(),
            "Proposed plan, no edits executed".into(),
        )
        .unwrap();
}
#[tokio::test]
async fn destructive_approval_is_host_only_exact_and_one_use() {
    let (_, mut agent, count) = setup("askDestructive", false).await;
    assert!(invoke(&mut agent, "first", 1).is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let snapshot = serde_json::to_value(agent.run()).unwrap();
    let id = snapshot["pendingApproval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        serde_json::from_value::<ModelAction>(
            json!({"action":"approve","approvalId":id,"allow":true})
        )
        .is_err()
    );
    agent
        .command(AgentCommand::Approve {
            approval_id: id,
            allow: true,
        })
        .unwrap();
    let scope = agent.run().scope().clone();
    agent.resume(&scope).unwrap();
    agent.observe().unwrap();
    assert!(invoke(&mut agent, "changed-args", 2).is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let id = serde_json::to_value(agent.run()).unwrap()["pendingApproval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_owned();
    agent
        .command(AgentCommand::Approve {
            approval_id: id,
            allow: true,
        })
        .unwrap();
    agent.resume(&scope).unwrap();
    agent.observe().unwrap();
    invoke(&mut agent, "approved", 2).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    agent.observe().unwrap();
    assert!(invoke(&mut agent, "again", 2).is_err());
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn full_access_runs_without_prompts_but_cannot_change_policy() {
    let (_, mut agent, count) = setup("fullAccess", false).await;
    invoke(&mut agent, "full", 1).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    agent.observe().unwrap();
    let epoch = agent.run().epoch();
    assert!(
        agent
            .model_action(
                epoch,
                "escalate",
                ModelAction::Invoke {
                    id: "agent.policy.set".into(),
                    input: json!({})
                }
            )
            .is_err()
    );
}
#[tokio::test]
async fn policy_registry_is_readable_revision_guarded_and_not_restored_by_undo() {
    let (runtime, _, _) = setup("plan", false).await;
    assert!(
        runtime
            .registry()
            .descriptor("agent.policy.set")
            .unwrap()
            .unwrap()
            .transactional
    );
    let revision = runtime.snapshot().unwrap().revision;
    let read = runtime
        .registry()
        .invoke(
            "app.state.read",
            InvocationContext::default(),
            json!({"projectId":"classic-project","pointer":"/agentPolicy"}),
        )
        .await
        .unwrap();
    assert!(
        serde_json::to_value(read)
            .unwrap()
            .to_string()
            .contains("plan")
    );
    assert!(runtime.registry().invoke("agent.policy.set",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":revision-1,"mode":"fullAccess","computerAccess":true})).await.is_err());
    runtime
        .registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(
        runtime.snapshot().unwrap().agent_policy.mode,
        opencut_editor_api::AgentMode::Plan
    );
}
#[tokio::test]
async fn computer_tools_require_explicit_desktop_install_and_policy() {
    let (runtime, _, _) = setup("askDestructive", false).await;
    assert!(
        runtime
            .registry()
            .descriptor("computer.files.inspect")
            .unwrap()
            .is_none()
    );
    let bridge = HostBridge::default();
    register_computer_capabilities(&runtime, &bridge).unwrap();
    let revision = runtime.snapshot().unwrap().revision;
    let error=runtime.registry().invoke("computer.files.inspect",InvocationContext{request_id:Some("host-op".into()),..Default::default()},json!({"projectId":"classic-project","expectedRevision":revision,"operation":{"type":"list","path":"/tmp"}})).await.unwrap_err();
    assert!(error.to_string().contains("disabled"));
    assert!(bridge.pending().unwrap().is_empty());
}

#[tokio::test]
async fn changing_policy_expires_a_pending_project_approval() {
    let (runtime, mut agent, count) = setup("askDestructive", false).await;
    assert!(invoke(&mut agent, "request", 1).is_err());
    let id = serde_json::to_value(agent.run()).unwrap()["pendingApproval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_owned();
    runtime.registry().invoke("agent.policy.set", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"mode":"fullAccess","computerAccess":false})).await.unwrap();
    assert!(
        agent
            .command(AgentCommand::Approve {
                approval_id: id,
                allow: true
            })
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn checkpoint_recovery_does_not_restore_an_approved_ticket() {
    let (runtime, mut agent, count) = setup("askDestructive", false).await;
    assert!(invoke(&mut agent, "request", 1).is_err());
    let id = serde_json::to_value(agent.run()).unwrap()["pendingApproval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_owned();
    agent
        .command(AgentCommand::Approve {
            approval_id: id,
            allow: true,
        })
        .unwrap();
    let checkpoint = agent.checkpoint().unwrap();
    let mut restored = RuntimeAgent::restore_checkpoint(
        runtime,
        "alice",
        "classic-project",
        AccessLevel::Destructive,
        None,
        &checkpoint,
    )
    .unwrap();
    let scope = restored.run().scope().clone();
    restored.resume(&scope).unwrap();
    restored.observe().unwrap();
    assert!(invoke(&mut restored, "after-recovery", 1).is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
