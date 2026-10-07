use opencut_editor_agent::*;
use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

#[tokio::test]
async fn registering_a_future_feature_exposes_it_to_the_running_agent_without_tool_wiring() {
    use opencut_editor_api::{
        CapabilityDescriptor, CapabilityExecution, CapabilityResult, DocumentSupport, FnCapability,
    };
    use std::sync::Arc;
    let (runtime, mut agent) = setup().await;
    assert!(agent.discover("future-feature", 10).unwrap().is_empty());
    let mut descriptor = CapabilityDescriptor::read(
        "test.future-feature",
        "New editor feature",
        "A dynamically registered feature",
        "test",
        json!({"type":"object","additionalProperties":false}),
        json!({"type":"object"}),
    );
    descriptor.execution = CapabilityExecution::Immediate;
    descriptor.document_support = DocumentSupport::Classic;
    runtime
        .registry()
        .register(Arc::new(FnCapability::new(descriptor, |_, _| {
            Box::pin(async { Ok(CapabilityResult::data(json!({"discovered":true}))) })
        })))
        .unwrap();
    assert_eq!(
        agent.discover("future-feature", 10).unwrap()[0].id,
        "test.future-feature"
    );
    let epoch = agent.run().epoch();
    agent
        .model_action(
            epoch,
            "describe",
            ModelAction::Describe {
                id: "test.future-feature".into(),
            },
        )
        .unwrap();
    let result = agent
        .model_action(
            epoch,
            "invoke",
            ModelAction::Invoke {
                id: "test.future-feature".into(),
                input: json!({}),
            },
        )
        .unwrap();
    assert_eq!(result["result"]["data"]["discovered"], true);
}

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
            run_id: "run-1".into(),
        },
        "Rename the film".into(),
        AccessLevel::Write,
    )
    .unwrap();
    (runtime, agent)
}

fn provider_call(id: &str, action: Value) -> Value {
    json!({"id":id,"status":"completed","output":[{"type":"function_call","call_id":format!("call-{id}"),"name":"opencut_editor","arguments":action.to_string()}]})
}

#[tokio::test]
async fn follow_up_restores_public_context_without_replaying_provider_actions() {
    let (runtime, mut agent) = setup().await;
    let mut archive = ConversationArchive::new("alice".into(), "classic-project".into());
    for event in [
        ConversationEvent::User {
            text: "Add a blue title to clip-1".into(),
            attachments: vec![],
        },
        ConversationEvent::Round { review: false },
        ConversationEvent::Text {
            text: "Added the title; target clip-1, title text-42".into(),
        },
        ConversationEvent::Close,
        ConversationEvent::User {
            text: "Rename the film".into(),
            attachments: vec![],
        },
    ] {
        archive.apply("alice", "classic-project", event).unwrap();
    }
    let restored: ConversationArchive =
        serde_json::from_str(&serde_json::to_string(&archive).unwrap()).unwrap();
    agent.load_conversation(&restored).unwrap();
    let request = agent.provider_request("fixture-model").unwrap();
    let context: Value =
        serde_json::from_str(request.body["input"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(context["priorConversation"].as_array().unwrap().len(), 2);
    assert!(
        context["priorConversation"][1]["text"]
            .as_str()
            .unwrap()
            .contains("text-42")
    );
    assert_eq!(request.body["input"].as_array().unwrap().len(), 2);
    assert!(agent.run().receipts().is_empty());
    assert_eq!(runtime.snapshot().unwrap().revision, 1);
    let checkpoint = agent.checkpoint().unwrap();
    let mut reopened = RuntimeAgent::restore_checkpoint(
        runtime.clone(),
        "alice",
        "classic-project",
        AccessLevel::Write,
        None,
        &checkpoint,
    )
    .unwrap();
    reopened
        .command(AgentCommand::Resume {
            scope: reopened.run().scope().clone(),
        })
        .unwrap();
    let request = reopened.provider_request("fixture-model").unwrap();
    assert!(
        request.body["input"][1]["content"]
            .as_str()
            .unwrap()
            .contains("text-42")
    );
    let before = reopened.checkpoint().unwrap();
    let foreign = ConversationArchive::new("bob".into(), "classic-project".into());
    assert!(reopened.load_conversation(&foreign).is_err());
    assert_eq!(reopened.checkpoint().unwrap(), before);
}

#[tokio::test]
async fn future_image_capabilities_feed_bounded_current_revision_pixels_without_checkpoint_bloat() {
    use opencut_editor_api::{
        CapabilityDescriptor, CapabilityExecution, CapabilityResult, DocumentSupport, FnCapability,
    };
    use std::sync::Arc;
    let (runtime, mut agent) = setup().await;
    let mut descriptor = CapabilityDescriptor::read(
        "test.future-image",
        "Future image feature",
        "Image result",
        "test",
        json!({"type":"object"}),
        json!({"type":"object"}),
    );
    descriptor.execution = CapabilityExecution::Immediate;
    descriptor.document_support = DocumentSupport::Classic;
    let store = runtime.artifacts().clone();
    let refs = vec![
        store
            .put(vec![1; 2_000_001], "image/jpeg", Some(100), Some(100), None)
            .unwrap(),
        store
            .put(vec![2; 900_000], "image/png", Some(100), Some(100), None)
            .unwrap(),
        store
            .put(vec![3; 900_000], "image/webp", Some(100), Some(100), None)
            .unwrap(),
        store
            .put(vec![4; 900_000], "image/jpeg", Some(100), Some(100), None)
            .unwrap(),
        store
            .put(vec![5; 10], "text/plain", None, None, None)
            .unwrap(),
    ];
    let result_refs = refs.clone();
    runtime
        .registry()
        .register(Arc::new(FnCapability::new(descriptor, move |_, _| {
            let artifacts = result_refs.clone();
            Box::pin(async move {
                let mut result = CapabilityResult::data(json!({"captured":true}));
                result.artifacts = artifacts;
                Ok(result)
            })
        })))
        .unwrap();
    let epoch = agent.run().epoch();
    agent.describe(epoch, "test.future-image").unwrap();
    agent
        .model_action(
            epoch,
            "capture",
            ModelAction::Invoke {
                id: "test.future-image".into(),
                input: json!({}),
            },
        )
        .unwrap();
    let request = agent.provider_request("fixture-model").unwrap();
    let content = request.body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(
        content
            .iter()
            .filter(|item| item["type"] == "input_image")
            .count(),
        2
    );
    assert!(request.body.to_string().len() < 4_000_000);
    assert!(!agent.checkpoint().unwrap().contains(";base64,"));
    // Another run sharing the runtime has no receipt for these images.
    let mut other = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "alice".into(),
            project_id: "classic-project".into(),
            run_id: "other-run".into(),
        },
        "Other request".into(),
        AccessLevel::Write,
    )
    .unwrap();
    assert!(
        !other
            .provider_request("fixture-model")
            .unwrap()
            .body
            .to_string()
            .contains("input_image")
    );
    for artifact in &refs {
        store.remove(&artifact.uri).unwrap();
    }
    assert!(
        !agent
            .provider_request("fixture-model")
            .unwrap()
            .body
            .to_string()
            .contains("input_image")
    );
    // A fresh receipt may attach new images, but an editor write invalidates them.
    let state = runtime.snapshot().unwrap();
    runtime.registry().invoke("project.classic.settings.update", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":state.revision,"settings":{"fps":{"numerator":30,"denominator":1}}})).await.unwrap();
    assert!(
        !agent
            .provider_request("fixture-model")
            .unwrap()
            .body
            .to_string()
            .contains("input_image")
    );
}

#[tokio::test]
async fn knowledge_registry_round_reconciles_a_lost_durable_response_while_paused() {
    use opencut_editor_agent::knowledge::*;
    use opencut_editor_api::{HostBridge, HostEffectResult};
    let (runtime, agent) = setup().await;
    let bridge = HostBridge::default();
    register_knowledge_capabilities(runtime.registry(), &bridge).unwrap();
    let mut agent = agent.with_host_bridge(bridge);
    assert!(
        agent
            .discover("memory", 20)
            .unwrap()
            .iter()
            .any(|d| d.id == "knowledge.change")
    );
    let epoch = agent.run().epoch();
    agent.describe(epoch, "knowledge.change").unwrap();
    agent
        .plan(
            epoch,
            vec![PlanStep {
                title: "Remember the user's caption preference".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    let request = agent.provider_request("test-model").unwrap();
    let response = provider_call(
        "save-memory",
        json!({"action":"invoke","id":"knowledge.change","input":{
            "expectedKnowledgeRevision":0,"change":{"type":"create","key":{"kind":"memory","id":"captions"},"location":{"type":"global"},
            "content":{"title":"Caption language","body":"הכתוביות בעברית","enabled":true,"tags":["captions"]}}
        }}),
    );
    let round = agent
        .provider_response(request.epoch, response.clone())
        .unwrap();
    assert_eq!(round.phase, RunPhase::AwaitingTool);
    assert_eq!(round.activities[0].status, Some(ActivityStatus::Running));
    assert!(round.activities[0].completed_at.is_none());
    let effect = round.pending_host.unwrap();
    assert_eq!(effect.adapter, "knowledge");
    assert_eq!(effect.project_id, "classic-project");
    assert!(agent.provider_request("test-model").is_err());
    let authority = KnowledgeAuthority {
        account_id: "alice".into(),
        project_id: "classic-project".into(),
        owned_projects: std::collections::BTreeSet::from(["classic-project".into()]),
    };
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let first = store
        .dispatch(
            &authority,
            serde_json::from_value(effect.request.clone()).unwrap(),
            10,
        )
        .unwrap();
    assert!(first.changed);
    // Server committed but the HTTP response was lost. Pausing must neither
    // forget the request identity nor allow another write before reconciliation.
    agent.pause();
    let same = agent.pending_host_effect().unwrap().unwrap();
    assert_eq!(same.request, effect.request);
    assert!(agent.resume(&agent.run().scope().clone()).is_err());
    let retried = store
        .dispatch(
            &authority,
            serde_json::from_value(same.request).unwrap(),
            11,
        )
        .unwrap();
    assert!(!retried.changed);
    assert_eq!(retried.revision, 1);
    let receipt = HostEffectResult::Success {
        data: serde_json::to_value(retried).unwrap(),
    };
    assert!(
        agent
            .settle_host_effect("bob", "classic-project", effect.id, receipt.clone())
            .is_err()
    );
    let settled = agent
        .settle_host_effect("alice", "classic-project", effect.id, receipt.clone())
        .unwrap();
    assert_eq!(settled.phase, RunPhase::Paused);
    assert_eq!(settled.activities.len(), 1);
    assert!(settled.activities[0].ok);
    assert_eq!(settled.activities[0].status, Some(ActivityStatus::Completed));
    assert!(settled.activities[0].duration_ms.is_some());
    assert!(agent.run().receipts().last().unwrap().committed);
    assert!(agent.run().receipts().last().unwrap().external_only);
    assert!(
        agent
            .settle_host_effect("alice", "classic-project", effect.id, receipt)
            .is_err()
    );
    let scope = agent.run().scope().clone();
    agent.resume(&scope).unwrap();
    let next = agent.provider_request("test-model").unwrap();
    assert!(next.body.to_string().contains("call-save-memory"));
    assert!(next.body.to_string().contains("function_call_output"));
    assert!(agent.provider_response(next.epoch, response).is_err());
    agent
        .plan(
            next.epoch,
            vec![PlanStep {
                title: "Remember the user's caption preference".into(),
                status: PlanStatus::Complete,
            }],
        )
        .unwrap();
    // No video change occurred; empty-project rendering cannot verify memory.
    agent.finish(next.epoch, "ההעדפה נשמרה".into()).unwrap();
}

#[tokio::test]
async fn a_new_host_feature_uses_the_same_registry_without_agent_tool_wiring() {
    use opencut_editor_api::{
        CapabilityDescriptor, CapabilityExecution, DocumentSupport, FnCapability, HostBridge,
        HostEffectResult,
    };
    let (runtime, agent) = setup().await;
    let bridge = HostBridge::default();
    let mut agent = agent.with_host_bridge(bridge.clone());
    let mut descriptor = CapabilityDescriptor::read(
        "test.future-host",
        "Future host feature",
        "Newly installed bounded host feature",
        "test",
        json!({"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}),
        json!({"type":"object","properties":{"found":{"type":"boolean"}},"required":["found"],"additionalProperties":false}),
    );
    descriptor.execution = CapabilityExecution::Async;
    descriptor.document_support = DocumentSupport::Both;
    descriptor.open_world = true;
    let handler = bridge.clone();
    runtime
        .registry()
        .register(std::sync::Arc::new(FnCapability::new(
            descriptor.clone(),
            move |_, input| {
                let host = handler.clone();
                Box::pin(async move {
                    host.execute(
                        "test.future-host",
                        "future-adapter",
                        input["projectId"].as_str().unwrap(),
                        json!({"operation":"find"}),
                    )
                    .await
                })
            },
        )))
        .unwrap();
    assert!(
        agent
            .catalog()
            .unwrap()
            .capabilities
            .iter()
            .find(|d| d.id == descriptor.id)
            .unwrap()
            .available
            == false
    );
    bridge.install(&descriptor).unwrap();
    assert!(
        agent
            .discover("future-host", 20)
            .unwrap()
            .iter()
            .any(|d| d.id == descriptor.id)
    );
    let epoch = agent.run().epoch();
    agent.describe(epoch, &descriptor.id).unwrap();
    // Neither privilege injection nor an invalid schema reaches a host effect.
    agent
        .provider_response(
            epoch,
            provider_call(
                "invalid",
                json!({"action":"invoke","id":descriptor.id,"input":{"endpoint":"file:///secret"}}),
            ),
        )
        .unwrap();
    assert!(agent.pending_host_effect().unwrap().is_none());
    let request = agent.provider_request("test-model").unwrap();
    let round = agent
        .provider_response(
            request.epoch,
            provider_call(
                "future",
                json!({"action":"invoke","id":descriptor.id,"input":{}}),
            ),
        )
        .unwrap();
    let effect = round.pending_host.unwrap();
    assert_eq!(effect.project_id, "classic-project");
    assert!(
        agent
            .settle_host_effect(
                "alice",
                "classic-project",
                effect.id,
                HostEffectResult::Success {
                    data: json!({"wrong":"output"})
                }
            )
            .is_err()
    );
    assert_eq!(agent.pending_host_effect().unwrap().unwrap().id, effect.id);
    let result = agent
        .settle_host_effect(
            "alice",
            "classic-project",
            effect.id,
            HostEffectResult::Success {
                data: json!({"found":true}),
            },
        )
        .unwrap();
    assert!(result.activities[0].ok);
    assert!(!result.needs_verification);
}

#[tokio::test]
async fn knowledge_context_is_scoped_budgeted_and_fences_older_provider_work() {
    use opencut_editor_agent::knowledge::*;
    let (_, mut agent) = setup().await;
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let authority = KnowledgeAuthority {
        account_id: "alice".into(),
        project_id: "classic-project".into(),
        owned_projects: std::collections::BTreeSet::from(["classic-project".into()]),
    };
    store
        .apply(
            &authority,
            KnowledgeMutation {
                expected_revision: 0,
                idempotency_key: "remember".into(),
                change: KnowledgeChange::Create {
                    key: KnowledgeKey {
                        kind: KnowledgeKind::Memory,
                        id: "captions".into(),
                    },
                    location: KnowledgeLocation::Project {
                        project_id: "classic-project".into(),
                    },
                    content: KnowledgeContent {
                        title: "Caption style".into(),
                        body: "Keep Hebrew captions to two lines".into(),
                        tags: vec!["captions".into()],
                        enabled: true,
                    },
                },
            },
            1,
        )
        .unwrap();
    let knowledge = store.context(&authority, "captions", 24_000).unwrap();
    assert!(
        agent
            .load_knowledge("bob", "classic-project", knowledge.clone())
            .is_err()
    );
    assert!(
        agent
            .load_knowledge("alice", "other-project", knowledge.clone())
            .is_err()
    );
    let old = agent.provider_request("model").unwrap();
    agent
        .load_knowledge("alice", "classic-project", knowledge)
        .unwrap();
    assert!(
        agent
            .provider_response(
                old.epoch,
                provider_call("old", json!({"action":"complete","text":"Done"}))
            )
            .is_err()
    );
    let request = agent.provider_request("model").unwrap();
    assert!(
        request
            .body
            .to_string()
            .contains("Keep Hebrew captions to two lines")
    );
}

#[tokio::test]
async fn paused_round_budget_can_resume_without_forgetting_replay_protection() {
    let (_, mut agent) = setup().await;
    for index in 0..160 {
        let request = agent.provider_request("model").unwrap();
        agent
            .provider_response(
                request.epoch,
                provider_call(
                    &format!("round-{index}"),
                    json!({"action":"discover","query":"rename","limit":3}),
                ),
            )
            .unwrap();
    }
    assert_eq!(agent.run().phase(), RunPhase::Paused);
    let scope = agent.run().scope().clone();
    agent.resume(&scope).unwrap();
    let request = agent.provider_request("model").unwrap();
    assert!(
        agent
            .provider_response(
                request.epoch,
                provider_call(
                    "round-159",
                    json!({"action":"discover","query":"rename","limit":3})
                )
            )
            .is_err()
    );
    let round = agent
        .provider_response(
            request.epoch,
            provider_call(
                "fresh-round",
                json!({"action":"discover","query":"rename","limit":3}),
            ),
        )
        .unwrap();
    assert_eq!(round.phase, RunPhase::Ready);
}

#[tokio::test]
async fn provider_rounds_preserve_context_and_reject_partial_duplicate_and_stale_calls() {
    let (runtime, mut agent) = setup().await;
    let request = agent.provider_request("account-model").unwrap();
    assert_eq!(request.body["tools"][0]["name"], "opencut_editor");
    let mut partial = provider_call(
        "partial",
        json!({"action":"describe","id":"project.classic.commit"}),
    );
    partial["status"] = json!("incomplete");
    assert!(agent.provider_response(request.epoch, partial).is_err());
    assert!(agent.run().contracts().descriptors().is_empty());
    let describe = provider_call(
        "learn",
        json!({"action":"describe","id":"project.classic.commit"}),
    );
    assert!(
        agent
            .provider_response(request.epoch, describe.clone())
            .unwrap()
            .activities[0]
            .ok
    );
    assert!(agent.provider_response(request.epoch, describe).is_err());
    assert!(
        agent
            .provider_request("account-model")
            .unwrap()
            .body
            .to_string()
            .contains("function_call_output")
    );
    let plan = provider_call(
        "plan",
        json!({"action":"plan","steps":[{"title":"Rename","status":"inProgress"}]}),
    );
    assert!(
        agent
            .provider_response(agent.run().epoch(), plan)
            .unwrap()
            .activities[0]
            .ok
    );
    let before = runtime.snapshot().unwrap();
    let mut classic = serde_json::to_value(before.project.unwrap().classic.unwrap()).unwrap();
    classic["document"]["metadata"]["name"] = json!("Edited through provider");
    let epoch = agent.run().epoch();
    let write = provider_call(
        "rename",
        json!({"action":"invoke","id":"project.classic.commit","input":{"classic":classic}}),
    );
    let round = agent.provider_response(epoch, write.clone()).unwrap();
    assert!(round.activities[0].ok);
    assert!(round.needs_verification);
    assert_eq!(
        runtime.snapshot().unwrap().project.unwrap().name,
        "Edited through provider"
    );
    assert!(agent.provider_response(epoch, write).is_err());
    let stale = agent.provider_request("account-model").unwrap();
    agent
        .steer("Keep the new name; inspect the title".into())
        .unwrap();
    assert!(
        agent
            .provider_response(
                stale.epoch,
                provider_call("late", json!({"action":"complete","text":"Done"}))
            )
            .is_err()
    );
}

#[tokio::test]
async fn rendered_review_is_bound_to_current_revision_and_cannot_self_attest_without_artifacts() {
    let (runtime, mut agent) = setup().await;
    let epoch = agent.run().epoch();
    agent.describe(epoch, "project.classic.commit").unwrap();
    agent
        .plan(
            epoch,
            vec![PlanStep {
                title: "Rename".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    let mut classic = serde_json::to_value(
        runtime
            .snapshot()
            .unwrap()
            .project
            .unwrap()
            .classic
            .unwrap(),
    )
    .unwrap();
    classic["document"]["metadata"]["name"] = json!("Review this");
    agent
        .invoke_immediate(
            epoch,
            "write",
            "project.classic.commit",
            json!({"classic":classic.clone()}),
        )
        .unwrap();
    let plan = agent.review_plan().unwrap();
    assert!(!plan.times.is_empty());
    assert!(
        agent
            .review_request("model", plan.epoch, plan.revision, vec![])
            .is_err()
    );
    let artifact = runtime
        .artifacts()
        .put(include_bytes!("fixtures/color-frame.jpg").to_vec(), "image/jpeg", None, None, None)
        .unwrap();
    let frames: Vec<ReviewFrame> = plan
        .times
        .iter()
        .map(|t| ReviewFrame {
            artifact_id: artifact.id.clone(),
            time_ticks: *t,
        })
        .collect();
    let request = agent
        .review_request("model", plan.epoch, plan.revision, frames.clone())
        .unwrap();
    assert!(request.body["tools"].as_array().unwrap().is_empty());
    assert!(request.body.to_string().contains("data:image/jpeg;base64,"));
    assert!(request.body.to_string().contains("nativePixelEvidence"));
    let review = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json!({"issues":[],"summary":"The new name matches canonical state; rendered samples are readable."}).to_string()}]}]});
    // Human edits between capture and the review response invalidate evidence.
    classic["document"]["metadata"]["name"] = json!("User changed it again");
    runtime.registry().invoke("project.classic.commit",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":plan.revision,"classic":classic})).await.unwrap();
    assert!(agent.review_response(plan.epoch, review.clone()).is_err());
    agent.observe().unwrap();
    let plan = agent.review_plan().unwrap();
    agent
        .review_request("model", plan.epoch, plan.revision, frames)
        .unwrap();
    let mut issues = review.clone();
    issues["output"][0]["content"][0]["text"] = json!(
        json!({"issues":["Name differs from requested rename"],"summary":"Needs correction"})
            .to_string()
    );
    agent.review_response(plan.epoch, issues).unwrap();
    assert!(agent.finish(plan.epoch, "Done".into()).is_err());
    let round = agent
        .provider_response(
            plan.epoch,
            provider_call(
                "learn-again",
                json!({"action":"describe","id":"app.state.read"}),
            ),
        )
        .unwrap();
    assert!(
        !round.needs_verification,
        "do not pay for an identical failed review again without an edit"
    );
    for (id, pointer) in [
        ("read-after-review", "/project/classic/document/metadata"),
        ("bad-read-after-review", "/missing-field"),
    ] {
        let request = agent.provider_request("model").unwrap();
        let round = agent
            .provider_response(
                request.epoch,
                provider_call(
                    id,
                    json!({"action":"invoke","id":"app.state.read","input":{"pointer":pointer}}),
                ),
            )
            .unwrap();
        assert!(
            !round.needs_verification,
            "reads and rejected reads do not create new visual evidence"
        );
    }
    assert!(
        agent
            .provider_request("model")
            .unwrap()
            .body
            .to_string()
            .contains("Name differs")
    );
}

#[tokio::test]
async fn host_adapter_writes_and_undoes_the_actual_classic_document() {
    let (runtime, mut agent) = setup().await;
    let epoch = agent.run().epoch();
    let hits = agent.discover("classic commit", 50).unwrap();
    assert!(
        hits.iter()
            .any(|h| h.id == "project.classic.commit" && h.available)
    );
    assert!(
        !hits
            .iter()
            .any(|h| h.id == "timeline.track.add" && h.available)
    );
    agent.describe(epoch, "project.classic.commit").unwrap();
    agent
        .plan(
            epoch,
            vec![PlanStep {
                title: "Rename and verify".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    let before = runtime.snapshot().unwrap();
    let mut classic =
        serde_json::to_value(before.project.as_ref().unwrap().classic.as_ref().unwrap()).unwrap();
    classic["document"]["metadata"]["name"] = json!("Renamed by agent");
    agent
        .invoke_immediate(
            epoch,
            "rename",
            "project.classic.commit",
            json!({"classic":classic}),
        )
        .unwrap();
    assert_eq!(
        runtime.snapshot().unwrap().project.unwrap().name,
        "Renamed by agent"
    );
    assert!(agent.finish(agent.run().epoch(), "Done".into()).is_err());
    let epoch = agent.run().epoch();
    agent
        .plan(
            epoch,
            vec![PlanStep {
                title: "Rename and verify".into(),
                status: PlanStatus::Complete,
            }],
        )
        .unwrap();
    agent
        .verify(epoch, runtime.snapshot().unwrap().revision, &[])
        .unwrap();
    agent.finish(epoch, "Renamed and verified".into()).unwrap();
    runtime
        .registry()
        .invoke("history.undo", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().project, before.project);
    let read = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap();
    assert_eq!(read.result.data["canUndo"], false);
}

#[tokio::test]
async fn invalid_edit_rolls_back_and_stale_ui_state_cannot_be_overwritten() {
    let (runtime, mut agent) = setup().await;
    let epoch = agent.run().epoch();
    agent.describe(epoch, "project.classic.commit").unwrap();
    agent
        .plan(
            epoch,
            vec![PlanStep {
                title: "Rename and verify".into(),
                status: PlanStatus::InProgress,
            }],
        )
        .unwrap();
    let before = runtime.snapshot().unwrap();
    assert!(
        agent
            .invoke_immediate(
                epoch,
                "bad",
                "project.classic.commit",
                json!({"classic":{}})
            )
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), before);
    assert_eq!(agent.run().receipts().len(), 1);
    assert!(!agent.run().receipts()[0].committed);
    let mut classic =
        serde_json::to_value(before.project.as_ref().unwrap().classic.as_ref().unwrap()).unwrap();
    classic["document"]["metadata"]["name"] = json!("User edit");
    runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":before.revision,"classic":classic})).await.unwrap();
    let after_user = runtime.snapshot().unwrap();
    classic["document"]["metadata"]["name"] = json!("Stale agent edit");
    assert!(
        agent
            .invoke_immediate(
                agent.run().epoch(),
                "stale",
                "project.classic.commit",
                json!({"classic":classic})
            )
            .is_err()
    );
    assert_eq!(runtime.snapshot().unwrap(), after_user);
}
