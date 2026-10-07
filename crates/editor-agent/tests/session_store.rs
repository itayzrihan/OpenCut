use opencut_editor_agent::{AgentScope, RuntimeAgent, session_store::*};
use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const PROJECT: &str = "classic-project";

#[tokio::test]
async fn pending_editor_host_features_can_be_saved_and_reopened_without_host_io() {
    for (capability, adapter, input) in [
        ("editor.ui.snapshot", "editorUi", json!({})),
        ("editor.ui.screenshot", "editorScreenshot", json!({})),
        (
            "editor.ui.control",
            "editorUiControl",
            json!({"snapshotId":"snapshot-1","targetId":"target-1","gesture":{"type":"click"}}),
        ),
        (
            "hyperframes.examples.embed",
            "hyperframesEmbedding",
            json!({"query":"glass title"}),
        ),
        (
            "imagegen.generate",
            "subscriptionImage",
            json!({"operationId":"same-image-operation","title":"Turquoise circle","prompt":"A turquoise circle on transparent background","transparentBackground":true}),
        ),
    ] {
        let saved = bundle().await;
        let runtime = OpenCutRuntime::default();
        runtime
            .registry()
            .invoke(
                "project.classic.session.restore",
                InvocationContext::default(),
                json!({"projectId":PROJECT,"expectedRevision":0,"archive":saved.archive}),
            )
            .await
            .unwrap();
        let bridge = opencut_editor_api::HostBridge::default();
        opencut_editor_api::register_editor_host_capabilities(&runtime, &bridge).unwrap();
        opencut_editor_api::register_editor_screenshot_capability(&runtime, &bridge).unwrap();
        let mut agent = RuntimeAgent::new(
            runtime.clone(),
            AgentScope {
                account_id: "alice".into(),
                project_id: PROJECT.into(),
                run_id: "ui-observation".into(),
            },
            "Inspect the editing controls".into(),
            AccessLevel::Write,
        )
        .unwrap()
        .with_host_bridge(bridge);
        agent.describe(agent.run().epoch(), capability).unwrap();
        agent
            .plan(
                agent.run().epoch(),
                vec![opencut_editor_agent::PlanStep {
                    title: "Inspect or perform the requested host action".into(),
                    status: opencut_editor_agent::PlanStatus::InProgress,
                }],
            )
            .unwrap();
        let request = agent.provider_request("fixture-model").unwrap();
        let response = agent.provider_response(request.epoch, json!({"id":"response-ui","status":"completed","output":[{
        "type":"function_call","call_id":"ui-call","name":"opencut_editor","arguments":json!({"action":"invoke","id":capability,"input":input}).to_string()
    }]})).unwrap();
        let effect = response
            .pending_host
            .clone()
            .unwrap_or_else(|| panic!("{capability}: {response:?}"));
        assert_eq!(effect.adapter, adapter);
        let archive = runtime
            .registry()
            .invoke(
                "project.classic.session.archive",
                InvocationContext::default(),
                json!({"projectId":PROJECT,"persistableOnly":true}),
            )
            .await
            .unwrap()
            .result
            .data;
        let checkpoint = agent.checkpoint().unwrap();
        let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
        apply(&mut record, acquire("tab-a", 0, false), 1).unwrap();
        apply(
            &mut record,
            commit(
                SessionBundle {
                    conversation: None,
                    artifacts: None,
                    archive,
                    agent_checkpoint: Some(checkpoint.clone()),
                    thumbnail: None,
                },
                "save-ui",
                0,
                1,
            ),
            2,
        )
        .unwrap();
        assert_eq!(
            record
                .saved
                .as_ref()
                .unwrap()
                .bundle
                .agent_checkpoint
                .as_deref(),
            Some(checkpoint.as_str())
        );
        let before = record.to_json().unwrap();
        assert!(
            record
                .apply("bob", PROJECT, SessionRequest::Read, 3)
                .is_err()
        );
        assert_eq!(record.to_json().unwrap(), before);
        let reopened = SessionRecord::from_json("alice", PROJECT, &before).unwrap();
        let reopened_bundle = reopened.saved.unwrap().bundle;
        let fresh_runtime = OpenCutRuntime::default();
        fresh_runtime
            .registry()
            .invoke(
                "project.classic.session.restore",
                InvocationContext::default(),
                json!({"projectId":PROJECT,"expectedRevision":0,"archive":reopened_bundle.archive}),
            )
            .await
            .unwrap();
        let fresh_bridge = opencut_editor_api::HostBridge::default();
        opencut_editor_api::register_editor_host_capabilities(&fresh_runtime, &fresh_bridge)
            .unwrap();
        opencut_editor_api::register_editor_screenshot_capability(&fresh_runtime, &fresh_bridge)
            .unwrap();
        let resumed = RuntimeAgent::restore_checkpoint(
            fresh_runtime.clone(),
            "alice",
            PROJECT,
            AccessLevel::Write,
            Some(fresh_bridge),
            reopened_bundle.agent_checkpoint.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(
            resumed.run().phase(),
            opencut_editor_agent::RunPhase::Paused
        );
        let recovered = resumed.pending_host_effect().unwrap().unwrap();
        assert_eq!(
            recovered.request, effect.request,
            "Recovery must preserve the operation identity, scope and content"
        );
        assert_eq!(recovered.adapter, effect.adapter);
        assert_eq!(
            fresh_runtime.snapshot().unwrap(),
            runtime.snapshot().unwrap()
        );
    }
}

#[test]
fn external_writes_require_the_current_owner_after_adoption() {
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    let write = |session: Option<&str>, generation| SessionRequest::AssertWrite {
        session_id: session.map(str::to_string),
        generation,
    };
    apply(&mut record, write(None, None), 1).unwrap();
    assert!(apply(&mut record, write(Some("tab-a"), Some(1)), 2).is_err());
    apply(&mut record, acquire("tab-a", 0, false), 10).unwrap();
    apply(&mut record, write(Some("tab-a"), Some(1)), 11).unwrap();
    for request in [
        write(None, None),
        write(Some("tab-a"), None),
        write(None, Some(1)),
        write(Some("tab-b"), Some(1)),
    ] {
        let before = record.to_json().unwrap();
        assert!(apply(&mut record, request, 12).is_err());
        assert_eq!(record.to_json().unwrap(), before);
    }
    apply(&mut record, acquire("tab-b", 1, true), 20).unwrap();
    assert!(apply(&mut record, write(Some("tab-a"), Some(1)), 21).is_err());
    apply(&mut record, write(Some("tab-b"), Some(2)), 21).unwrap();
    assert!(apply(&mut record, write(Some("tab-b"), Some(2)), 90_020).is_err());
    apply(&mut record, SessionRequest::Read, 90_020).unwrap();
    assert!(apply(&mut record, write(Some("tab-b"), Some(2)), 30).is_err());
    assert!(
        record
            .apply("bob", PROJECT, write(Some("tab-b"), Some(2)), 30)
            .is_err()
    );
}
fn apply(
    record: &mut SessionRecord,
    request: SessionRequest,
    time: u64,
) -> Result<Value, opencut_editor_agent::AgentError> {
    record.apply("alice", PROJECT, request, time)
}
fn acquire(session: &str, generation: u64, take_over: bool) -> SessionRequest {
    SessionRequest::Acquire {
        session_id: session.into(),
        expected_generation: generation,
        take_over,
    }
}
fn commit(bundle: SessionBundle, id: &str, revision: u64, generation: u64) -> SessionRequest {
    SessionRequest::Commit {
        session_id: "tab-a".into(),
        generation,
        expected_storage_revision: revision,
        request_id: id.into(),
        bundle,
    }
}
async fn bundle() -> SessionBundle {
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
            json!({"projectId":PROJECT,"expectedRevision":0,"classic":classic}),
        )
        .await
        .unwrap();
    let agent = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "alice".into(),
            project_id: PROJECT.into(),
            run_id: "saved-run".into(),
        },
        "Edit the film".into(),
        AccessLevel::Write,
    )
    .unwrap();
    SessionBundle {
        conversation: None,
        artifacts: None,
        thumbnail: None,
        archive: runtime
            .registry()
            .invoke(
                "project.classic.session.archive",
                InvocationContext::default(),
                json!({"projectId":PROJECT,"persistableOnly":true}),
            )
            .await
            .unwrap()
            .result
            .data,
        agent_checkpoint: Some(agent.checkpoint().unwrap()),
    }
}

#[tokio::test]
async fn atomic_commit_materializes_project_and_retries_without_duplicate_revision() {
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    apply(&mut record, acquire("tab-a", 0, false), 100).unwrap();
    let bundle = bundle().await;
    let receipt = apply(&mut record, commit(bundle.clone(), "save", 0, 1), 200).unwrap();
    assert_eq!(receipt["storageRevision"], 1);
    assert_eq!(
        record.saved.as_ref().unwrap().project["metadata"]["id"],
        PROJECT
    );
    assert_eq!(
        record.saved.as_ref().unwrap().bundle.agent_checkpoint,
        bundle.agent_checkpoint
    );
    assert_eq!(
        apply(&mut record, commit(bundle.clone(), "save", 0, 1), 300).unwrap(),
        receipt
    );
    assert_eq!(record.storage_revision, 1);
    let before = record.to_json().unwrap();
    assert!(apply(&mut record, commit(bundle.clone(), "different", 0, 1), 400).is_err());
    assert_eq!(record.to_json().unwrap(), before);
    assert!(apply(&mut record, commit(bundle, "save", 1, 1), 400).is_err());
    assert_eq!(record.to_json().unwrap(), before);
    let reopened = SessionRecord::from_json("alice", PROJECT, &before).unwrap();
    assert_eq!(reopened.storage_revision, 1);
    assert!(SessionRecord::from_json("bob", PROJECT, &before).is_err());
    assert!(SessionRecord::from_json("alice", "another-project", &before).is_err());
}

#[tokio::test]
async fn ownership_transfer_and_expiry_fence_old_requests_including_replays() {
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    let bundle = bundle().await;
    apply(&mut record, acquire("tab-a", 0, false), 100).unwrap();
    apply(&mut record, commit(bundle.clone(), "save", 0, 1), 200).unwrap();
    assert!(apply(&mut record, acquire("tab-b", 1, false), 300).is_err());
    apply(&mut record, acquire("tab-b", 1, true), 300).unwrap();
    assert!(apply(&mut record, commit(bundle.clone(), "save", 0, 1), 400).is_err());
    assert!(
        apply(
            &mut record,
            SessionRequest::Release {
                session_id: "tab-a".into(),
                generation: 1
            },
            400
        )
        .is_err()
    );
    assert!(apply(&mut record, acquire("tab-a", 1, true), 400).is_err());
    assert!(
        apply(
            &mut record,
            SessionRequest::Renew {
                session_id: "tab-b".into(),
                generation: 2
            },
            90_300
        )
        .is_err()
    );
    assert!(apply(&mut record, SessionRequest::Read, 90_300).unwrap()["lease"].is_null());
    // A rolled-back wall clock must not revive the expired owner.
    assert!(
        apply(
            &mut record,
            SessionRequest::Renew {
                session_id: "tab-b".into(),
                generation: 2
            },
            500
        )
        .is_err()
    );
    apply(&mut record, acquire("tab-a", 2, false), 90_301).unwrap();
    assert_eq!(record.generation, 3);
    assert!(apply(&mut record, commit(bundle.clone(), "old", 1, 1), 90_302).is_err());
    apply(&mut record, commit(bundle, "new", 1, 3), 90_302).unwrap();
    assert_eq!(record.storage_revision, 2);
}

#[tokio::test]
async fn conversation_is_paired_with_the_archive_and_foreign_scope_is_atomic() {
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    apply(&mut record, acquire("tab-a", 0, false), 100).unwrap();
    let mut saved = bundle().await;
    let mut conversation =
        opencut_editor_agent::ConversationArchive::new("alice".into(), PROJECT.into());
    conversation
        .apply(
            "alice",
            PROJECT,
            opencut_editor_agent::ConversationEvent::User {
                text: "ערוך את הסרטון".into(),
                attachments: vec![],
            },
        )
        .unwrap();
    conversation
        .apply(
            "alice",
            PROJECT,
            opencut_editor_agent::ConversationEvent::Round { review: false },
        )
        .unwrap();
    conversation
        .apply(
            "alice",
            PROJECT,
            opencut_editor_agent::ConversationEvent::Summary {
                text: "Checking the result".into(),
            },
        )
        .unwrap();
    saved.conversation = Some(conversation);
    apply(&mut record, commit(saved.clone(), "chat-save", 0, 1), 200).unwrap();
    let json = record.to_json().unwrap();
    let restored = SessionRecord::from_json("alice", PROJECT, &json).unwrap();
    assert_eq!(
        restored.saved.unwrap().bundle.conversation.unwrap().entries[0].text,
        "ערוך את הסרטון"
    );
    saved.conversation = Some(opencut_editor_agent::ConversationArchive::new(
        "bob".into(),
        PROJECT.into(),
    ));
    assert!(apply(&mut record, commit(saved, "foreign-chat", 1, 1), 300).is_err());
    assert_eq!(record.to_json().unwrap(), json);
}

#[tokio::test]
async fn binary_artifacts_survive_record_reopen_and_foreign_or_corrupt_bytes_are_rejected() {
    use opencut_editor_api::ArtifactStore;
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    apply(&mut record, acquire("tab-a", 0, false), 100).unwrap();
    let store = ArtifactStore::default();
    let artifact = store
        .put(vec![1, 2, 3], "image/jpeg", Some(16), Some(9), None)
        .unwrap();
    store.pin(&artifact.id).unwrap();
    let mut saved = bundle().await;
    saved.artifacts = Some(opencut_editor_agent::ScopedArtifactArchive {
        account_id: "alice".into(),
        project_id: PROJECT.into(),
        archive: store.archive(&[artifact.id.clone()]).unwrap(),
        unavailable_ids: vec![],
    });
    apply(
        &mut record,
        commit(saved.clone(), "artifact-save", 0, 1),
        200,
    )
    .unwrap();
    let before = record.to_json().unwrap();
    let reopened = SessionRecord::from_json("alice", PROJECT, &before).unwrap();
    let archive = reopened.saved.unwrap().bundle.artifacts.unwrap();
    let target = ArtifactStore::default();
    archive.restore("alice", PROJECT, &target).unwrap();
    assert_eq!(target.get(&artifact.id).unwrap().bytes.as_ref(), &[1, 2, 3]);
    saved.artifacts.as_mut().unwrap().account_id = "bob".into();
    assert!(
        apply(
            &mut record,
            commit(saved.clone(), "foreign-artifact", 1, 1),
            300
        )
        .is_err()
    );
    assert_eq!(record.to_json().unwrap(), before);
    let archive = saved.artifacts.as_mut().unwrap();
    archive.account_id = "alice".into();
    archive.archive.items[0].metadata.sha256 = "wrong".into();
    assert!(apply(&mut record, commit(saved, "corrupt-artifact", 1, 1), 300).is_err());
    assert_eq!(record.to_json().unwrap(), before);
}

#[tokio::test]
async fn invalid_archive_or_mismatched_checkpoint_cannot_partially_commit() {
    let mut record = SessionRecord::new("alice".into(), PROJECT.into()).unwrap();
    apply(&mut record, acquire("tab-a", 0, false), 100).unwrap();
    let valid = bundle().await;
    let before = record.to_json().unwrap();
    let mut bad = valid.clone();
    bad.archive["projectId"] = json!("another-project");
    assert!(apply(&mut record, commit(bad, "wrong-project", 0, 1), 200).is_err());
    assert_eq!(record.to_json().unwrap(), before);
    let mut bad = valid.clone();
    bad.archive["classic"]["document"]["metadata"]["name"] = json!("Unsaved independent edit");
    assert!(apply(&mut record, commit(bad, "mismatched", 0, 1), 200).is_err());
    assert_eq!(record.to_json().unwrap(), before);
    apply(&mut record, commit(valid.clone(), "valid", 0, 1), 200).unwrap();
    let before = record.to_json().unwrap();
    let mut same_revision = valid;
    same_revision.agent_checkpoint = None;
    same_revision.archive["classic"]["document"]["metadata"]["name"] = json!("Revision reuse");
    assert!(
        apply(
            &mut record,
            commit(same_revision, "reused-revision", 1, 1),
            300
        )
        .is_err()
    );
    assert_eq!(record.to_json().unwrap(), before);
}
