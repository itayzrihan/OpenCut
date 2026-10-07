use opencut_editor_agent::*;
use opencut_editor_api::{AccessLevel, DocumentKind, InvocationContext, OpenCutRuntime};
use serde_json::json;

fn scope() -> AgentScope {
    AgentScope {
        account_id: "alice".into(),
        project_id: "project-1".into(),
        run_id: "run-1".into(),
    }
}

async fn setup() -> (OpenCutRuntime, AgentRun) {
    let runtime = OpenCutRuntime::default();
    runtime
        .registry()
        .invoke(
            "project.create",
            InvocationContext::default(),
            json!({"name":"Agent film"}),
        )
        .await
        .unwrap();
    let state = runtime.snapshot().unwrap();
    let mut scope = scope();
    scope.project_id = state.project.as_ref().unwrap().id.clone();
    let mut run = AgentRun::new(
        scope,
        DocumentKind::Rewrite,
        "Add a video track".into(),
        AccessLevel::Write,
        false,
    )
    .unwrap();
    run.observe(state.revision).unwrap();
    (runtime, run)
}

fn plan(run: &mut AgentRun, status: PlanStatus) {
    run.set_plan(
        run.epoch(),
        vec![PlanStep {
            title: "Add and verify video track".into(),
            status,
        }],
    )
    .unwrap();
}

#[tokio::test]
async fn real_registry_edit_requires_description_plan_observation_and_verification() {
    let (runtime, mut run) = setup().await;
    let catalog = runtime.registry().snapshot().unwrap();
    let args = json!({"kind":"video", "name":"Agent video"});
    assert!(
        run.prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            args.clone()
        )
        .is_err()
    );
    run.describe(run.epoch(), &catalog, "timeline.track.add")
        .unwrap();
    assert!(
        run.prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            args.clone()
        )
        .is_err()
    );
    plan(&mut run, PlanStatus::InProgress);
    let epoch = run.epoch();
    let pending = run
        .prepare_tool(epoch, &catalog, "c1", "timeline.track.add", args)
        .unwrap();
    assert_eq!(
        pending.invocation.context.metadata["opencut/projectId"],
        run.scope().project_id
    );
    runtime
        .registry()
        .invoke(
            &pending.invocation.capability_id,
            pending.invocation.context,
            pending.invocation.input,
        )
        .await
        .unwrap();
    let state = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert!(state.result.data.to_string().contains("Agent video"));
    let revision = runtime.snapshot().unwrap().revision;
    run.settle_tool(
        "c1",
        ToolOutcome::Applied {
            revision,
            artifact_ids: vec![],
        },
    )
    .unwrap();
    assert_eq!(run.phase(), RunPhase::NeedsObservation);
    assert!(run.finish(epoch, "Done".into()).is_err());
    run.observe(revision).unwrap();
    plan(&mut run, PlanStatus::Complete);
    assert!(run.finish(run.epoch(), "Done".into()).is_err());
    run.verify(run.epoch(), revision, &["Preview needs correction".into()])
        .unwrap();
    assert!(run.finish(run.epoch(), "Done".into()).is_err());
    run.verify(run.epoch(), revision, &[]).unwrap();
    run.finish(run.epoch(), "Added and verified the video track".into())
        .unwrap();
    assert_eq!(run.phase(), RunPhase::Completed);
    assert!(run.receipts()[0].committed);
}

#[tokio::test]
async fn pause_and_unknown_commit_preserve_receipt_and_never_repeat_the_write() {
    let (runtime, mut run) = setup().await;
    let catalog = runtime.registry().snapshot().unwrap();
    run.describe(run.epoch(), &catalog, "timeline.track.add")
        .unwrap();
    plan(&mut run, PlanStatus::InProgress);
    let pending = run
        .prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            json!({"kind":"video", "name":"Only once"}),
        )
        .unwrap();
    run.settle_tool("c1", ToolOutcome::Unknown).unwrap();
    assert_eq!(run.phase(), RunPhase::Paused);
    assert!(run.resume(&run.scope().clone()).is_err());
    let bytes = serde_json::to_vec(&run).unwrap();
    let mut restored: AgentRun = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(restored.pending().unwrap().call_id, "c1");
    runtime
        .registry()
        .invoke(
            &pending.invocation.capability_id,
            pending.invocation.context.clone(),
            pending.invocation.input.clone(),
        )
        .await
        .unwrap();
    let revision = runtime.snapshot().unwrap().revision;
    // Retry for reconciliation uses precisely the original identity and input.
    runtime
        .registry()
        .invoke(
            &pending.invocation.capability_id,
            pending.invocation.context,
            pending.invocation.input,
        )
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().revision, revision);
    restored
        .settle_tool(
            "c1",
            ToolOutcome::Applied {
                revision,
                artifact_ids: vec![],
            },
        )
        .unwrap();
    assert_eq!(restored.phase(), RunPhase::Paused);
    let mut foreign = restored.scope().clone();
    foreign.account_id = "bob".into();
    assert!(restored.resume(&foreign).is_err());
    restored.resume(&restored.scope().clone()).unwrap();
    restored.observe(revision).unwrap();
    assert!(
        restored
            .prepare_tool(
                restored.epoch(),
                &catalog,
                "c1",
                "timeline.track.add",
                json!({"kind":"video"})
            )
            .is_err()
    );
    assert_eq!(restored.receipts().len(), 1);
}

#[tokio::test]
async fn steering_fences_buffered_calls_and_external_edits_invalidate_verification() {
    let (runtime, mut run) = setup().await;
    let catalog = runtime.registry().snapshot().unwrap();
    let epoch = run.epoch();
    run.steer("Actually use two tracks".into()).unwrap();
    assert!(run.describe(epoch, &catalog, "timeline.track.add").is_err());
    run.observe(runtime.snapshot().unwrap().revision).unwrap();
    assert!(run.describe(epoch, &catalog, "timeline.track.add").is_err());
    run.describe(run.epoch(), &catalog, "timeline.track.add")
        .unwrap();
    plan(&mut run, PlanStatus::InProgress);
    let revision = run.revision().unwrap();
    run.verify(run.epoch(), revision, &[]).unwrap();
    run.observe(revision + 1).unwrap();
    assert!(run.verify(run.epoch(), revision, &[]).is_err());
    assert!(
        run.prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            json!({"kind":"video", "projectId":"foreign-project"})
        )
        .is_err()
    );
    assert!(
        run.prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            json!({"kind":"video", "expectedRevision":revision})
        )
        .is_err()
    );
}

#[tokio::test]
async fn description_becomes_stale_when_feature_contract_changes() {
    let (runtime, mut run) = setup().await;
    let mut catalog = runtime.registry().snapshot().unwrap();
    run.describe(run.epoch(), &catalog, "timeline.track.add")
        .unwrap();
    plan(&mut run, PlanStatus::InProgress);
    catalog
        .capabilities
        .iter_mut()
        .find(|d| d.id == "timeline.track.add")
        .unwrap()
        .version = "2.0.0".into();
    assert!(
        run.prepare_tool(
            run.epoch(),
            &catalog,
            "c1",
            "timeline.track.add",
            json!({"kind":"video"})
        )
        .unwrap_err()
        .to_string()
        .contains("contract changed")
    );
}

#[test]
fn context_keeps_whole_rounds_and_committed_receipts_without_truncating_user_input() {
    let receipt = ReceiptReference {
        external_only: false,
        call_id: "c1".into(),
        capability_id: "timeline.track.add".into(),
        revision: Some(4),
        committed: true,
        artifact_ids: vec![],
    };
    let output = compile_context(ContextInput {
        request: "הוסף שכבה בלי לשנות את המוזיקה".into(),
        steering: vec!["Keep the original audio".into()],
        plan: json!([]),
        contracts: vec![],
        knowledge: vec![json!({"large":"x".repeat(6000)})],
        conversation: vec![],
        groups: vec![
            ContextGroup {
                id: "old".into(),
                items: vec![json!({"output":"x".repeat(5000)})],
                receipts: vec![receipt.clone()],
            },
            ContextGroup {
                id: "new".into(),
                items: vec![json!({"call":"c2"}), json!({"result":"read"})],
                receipts: vec![],
            },
        ],
        max_bytes: 4096,
    })
    .unwrap();
    assert_eq!(output.groups.len(), 1);
    assert_eq!(output.groups[0].items.len(), 2);
    assert_eq!(output.earlier_receipts, vec![receipt]);
    assert!(output.knowledge.is_empty());
    assert!(output.request.contains("המוזיקה"));
    assert!(serde_json::to_vec(&output).unwrap().len() <= 4096);
    assert!(
        compile_context(ContextInput {
            request: "x".repeat(5000),
            steering: vec![],
            plan: json!([]),
            contracts: vec![],
            knowledge: vec![],
            conversation: vec![],
            groups: vec![],
            max_bytes: 4096
        })
        .is_err()
    );
}
