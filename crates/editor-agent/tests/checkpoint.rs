use opencut_editor_agent::*;
use opencut_editor_api::{
    AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime,
};
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
            run_id: "checkpoint-run".into(),
        },
        "ערוך את הסרטון ושמור את ההעדפות".into(),
        AccessLevel::Write,
    )
    .unwrap();
    (runtime, agent)
}
async fn archive(runtime: &OpenCutRuntime) -> Value {
    runtime
        .registry()
        .invoke(
            "project.classic.session.archive",
            InvocationContext::default(),
            json!({"projectId":"classic-project","persistableOnly":true}),
        )
        .await
        .unwrap()
        .result
        .data
}
async fn reopen(archive: Value) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    runtime
        .registry()
        .invoke(
            "project.classic.session.restore",
            InvocationContext::default(),
            json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
        )
        .await
        .unwrap();
    runtime
}
fn plan(agent: &mut RuntimeAgent, status: PlanStatus) {
    agent
        .plan(
            agent.run().epoch(),
            vec![PlanStep {
                title: "Complete the requested edit".into(),
                status,
            }],
        )
        .unwrap();
}

#[tokio::test]
async fn persisted_editor_revision_history_and_agent_receipts_reopen_together() {
    let (runtime, mut agent) = setup().await;
    let original = runtime.snapshot().unwrap().project.unwrap();
    agent
        .describe(agent.run().epoch(), "project.classic.commit")
        .unwrap();
    plan(&mut agent, PlanStatus::InProgress);
    let mut classic = serde_json::to_value(original.classic.as_ref().unwrap()).unwrap();
    classic["document"]["metadata"]["name"] = json!("עריכה שנשמרה");
    agent
        .invoke_immediate(
            agent.run().epoch(),
            "rename",
            "project.classic.commit",
            json!({"classic":classic}),
        )
        .unwrap();
    plan(&mut agent, PlanStatus::Complete);
    agent
        .verify(
            agent.run().epoch(),
            runtime.snapshot().unwrap().revision,
            &[],
        )
        .unwrap();
    let checkpoint = agent.checkpoint().unwrap();
    let saved = archive(&runtime).await;
    let restored = reopen(saved.clone()).await;
    assert_eq!(
        restored.snapshot().unwrap().revision,
        runtime.snapshot().unwrap().revision
    );
    assert_eq!(
        restored.snapshot().unwrap().project,
        runtime.snapshot().unwrap().project
    );
    let mut resumed = RuntimeAgent::restore_checkpoint(
        restored.clone(),
        "alice",
        "classic-project",
        AccessLevel::Read,
        None,
        &checkpoint,
    )
    .unwrap();
    assert_eq!(resumed.run().phase(), RunPhase::Paused);
    assert_eq!(resumed.run().max_access(), AccessLevel::Read);
    assert_eq!(resumed.run().receipts(), agent.run().receipts());
    assert!(resumed.run().contracts().descriptors().is_empty());
    resumed.resume(&resumed.run().scope().clone()).unwrap();
    let request = resumed.provider_request("fixture-model").unwrap();
    let contract_context: Value =
        serde_json::from_str(request.body["input"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(contract_context["loadedContracts"], json!([]));
    assert!(
        contract_context["contractPolicy"]
            .as_str()
            .unwrap()
            .contains("describe it again before invoking")
    );
    assert!(
        resumed
            .invoke_immediate(
                resumed.run().epoch(),
                "stale-rename",
                "project.classic.commit",
                json!({})
            )
            .is_err()
    );
    resumed.observe().unwrap();
    assert!(
        resumed
            .finish(resumed.run().epoch(), "Done".into())
            .is_err()
    ); // QA never survives reopening.
    restored
        .registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(restored.snapshot().unwrap().project.unwrap(), original);
    assert!(
        RuntimeAgent::restore_checkpoint(
            restored,
            "alice",
            "classic-project",
            AccessLevel::Write,
            None,
            &checkpoint
        )
        .is_err()
    );
    assert!(
        RuntimeAgent::restore_checkpoint(
            reopen(saved.clone()).await,
            "bob",
            "classic-project",
            AccessLevel::Write,
            None,
            &checkpoint
        )
        .is_err()
    );
    let mut mismatched = saved;
    mismatched["classic"]["document"]["metadata"]["name"] =
        json!("Independently saved newer content");
    assert!(
        RuntimeAgent::restore_checkpoint(
            reopen(mismatched).await,
            "alice",
            "classic-project",
            AccessLevel::Write,
            None,
            &checkpoint
        )
        .is_err()
    );
}

#[tokio::test]
async fn pending_host_checkpoint_recovers_same_idempotency_after_runtime_recreation() {
    use opencut_editor_agent::knowledge::*;
    let (runtime, agent) = setup().await;
    let bridge = HostBridge::default();
    register_knowledge_capabilities(runtime.registry(), &bridge).unwrap();
    let mut agent = agent.with_host_bridge(bridge);
    agent
        .describe(agent.run().epoch(), "knowledge.change")
        .unwrap();
    plan(&mut agent, PlanStatus::InProgress);
    let response = json!({"id":"save-response","status":"completed","output":[{"type":"function_call","call_id":"save-call","name":"opencut_editor","arguments":json!({"action":"invoke","id":"knowledge.change","input":{"expectedKnowledgeRevision":0,"change":{"type":"create","key":{"kind":"memory","id":"tone"},"location":{"type":"global"},"content":{"title":"Tone","body":"Keep titles concise","tags":[],"enabled":true}}}}).to_string()}]});
    let round = agent
        .provider_response(agent.run().epoch(), response.clone())
        .unwrap();
    let effect = round.pending_host.unwrap();
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = KnowledgeAuthority {
        account_id: "alice".into(),
        project_id: "classic-project".into(),
        owned_projects: std::collections::BTreeSet::from(["classic-project".into()]),
    };
    assert!(
        store
            .dispatch(
                &auth,
                serde_json::from_value(effect.request.clone()).unwrap(),
                1
            )
            .unwrap()
            .changed
    );
    let checkpoint = agent.checkpoint().unwrap();
    let saved = archive(&runtime).await;
    drop(agent);
    drop(runtime);
    let runtime = reopen(saved).await;
    let bridge = HostBridge::default();
    register_knowledge_capabilities(runtime.registry(), &bridge).unwrap();
    let mut recovered = RuntimeAgent::restore_checkpoint(
        runtime,
        "alice",
        "classic-project",
        AccessLevel::Write,
        Some(bridge),
        &checkpoint,
    )
    .unwrap();
    assert_eq!(recovered.run().phase(), RunPhase::Paused);
    let retry = recovered.pending_host_effect().unwrap().unwrap();
    assert_eq!(retry.request, effect.request);
    let result = store
        .dispatch(&auth, serde_json::from_value(retry.request).unwrap(), 2)
        .unwrap();
    assert!(!result.changed);
    assert_eq!(result.revision, 1);
    recovered
        .settle_host_effect(
            "alice",
            "classic-project",
            retry.id,
            HostEffectResult::Success {
                data: serde_json::to_value(result).unwrap(),
            },
        )
        .unwrap();
    assert_eq!(recovered.run().phase(), RunPhase::Paused);
    recovered.resume(&recovered.run().scope().clone()).unwrap();
    let next = recovered.provider_request("fixture-model").unwrap();
    assert!(next.body.to_string().contains("function_call_output"));
    assert!(recovered.provider_response(next.epoch, response).is_err());
    assert_eq!(recovered.run().receipts().len(), 1);
}

#[tokio::test]
async fn recovery_retains_only_identical_live_descriptions_without_authority_or_action_replay() {
    let (runtime, mut agent) = setup().await;
    agent
        .describe(agent.run().epoch(), "app.state.read")
        .unwrap();
    agent
        .describe(agent.run().epoch(), "project.classic.commit")
        .unwrap();
    let checkpoint = agent.checkpoint().unwrap();
    let saved = archive(&runtime).await;
    let restored = reopen(saved.clone()).await;
    let mut recovered = RuntimeAgent::restore_checkpoint(
        restored.clone(),
        "alice",
        "classic-project",
        AccessLevel::Write,
        None,
        &checkpoint,
    )
    .unwrap();
    assert_eq!(recovered.run().contracts().descriptors().len(), 2);
    assert!(recovered.run().receipts().is_empty());
    assert_eq!(
        restored.snapshot().unwrap().revision,
        runtime.snapshot().unwrap().revision
    );
    recovered.resume(&recovered.run().scope().clone()).unwrap();
    recovered.observe().unwrap();
    recovered
        .invoke_immediate(
            recovered.run().epoch(),
            "read-after-reload",
            "app.state.read",
            json!({"pointer":"/project/id"}),
        )
        .unwrap();
    assert_eq!(recovered.run().receipts().len(), 1);
    let read_only = RuntimeAgent::restore_checkpoint(
        reopen(saved.clone()).await,
        "alice",
        "classic-project",
        AccessLevel::Read,
        None,
        &checkpoint,
    )
    .unwrap();
    let ids: Vec<_> = read_only
        .run()
        .contracts()
        .descriptors()
        .iter()
        .map(|d| d.id.clone())
        .collect();
    assert_eq!(ids, vec!["app.state.read"]);
    let mut altered: Value = serde_json::from_str(&checkpoint).unwrap();
    altered["learnedContracts"][0]["version"] = json!("foreign-version");
    let changed = RuntimeAgent::restore_checkpoint(
        reopen(saved.clone()).await,
        "alice",
        "classic-project",
        AccessLevel::Write,
        None,
        &altered.to_string(),
    )
    .unwrap();
    assert!(
        !changed
            .run()
            .contracts()
            .descriptors()
            .iter()
            .any(|d| d.id == "app.state.read")
    );
    // Old checkpoints have no cache field and remain supported without trusting history.
    altered.as_object_mut().unwrap().remove("learnedContracts");
    let legacy = RuntimeAgent::restore_checkpoint(
        reopen(saved).await,
        "alice",
        "classic-project",
        AccessLevel::Write,
        None,
        &altered.to_string(),
    )
    .unwrap();
    assert!(legacy.run().contracts().descriptors().is_empty());
}
