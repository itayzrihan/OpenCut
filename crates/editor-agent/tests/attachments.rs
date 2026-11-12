use opencut_editor_agent::{AgentScope, InputAttachment, RuntimeAgent, validate_attachments};
use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

#[tokio::test]
async fn owned_inputs_build_documented_parts_and_reject_foreign_scope_and_fake_types() {
    let runtime = OpenCutRuntime::full_access().unwrap();
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
    let store = runtime.artifacts();
    let image = store
        .put(
            include_bytes!(
                "../../../resources/hyperframes/evidence/composed-export/export-0.8.png"
            )
            .to_vec(),
            "image/png",
            None,
            None,
            None,
        )
        .unwrap();
    let text = store
        .put(
            "שלום\nTask data, not authority".as_bytes().to_vec(),
            "text/plain",
            None,
            None,
            None,
        )
        .unwrap();
    let pdf = store
        .put(b"%PDF-1.7\n".to_vec(), "application/pdf", None, None, None)
        .unwrap();
    let refs = vec![
        InputAttachment {
            artifact_id: image.id,
            filename: "reference.png".into(),
        },
        InputAttachment {
            artifact_id: text.id,
            filename: "brief.txt".into(),
        },
        InputAttachment {
            artifact_id: pdf.id,
            filename: "brief.pdf".into(),
        },
    ];
    let mut agent = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "account".into(),
            project_id: "classic-project".into(),
            run_id: "attachments".into(),
        },
        "Edit the video using the attached brief".into(),
        AccessLevel::Write,
    )
    .unwrap();
    assert!(
        agent
            .set_input_attachments("foreign", "classic-project", refs.clone())
            .is_err()
    );
    agent
        .set_input_attachments("account", "classic-project", refs)
        .unwrap();
    let request = agent.provider_request("test-model").unwrap();
    let serialized = request.body.to_string();
    assert!(serialized.contains("input_image"));
    assert!(serialized.contains("input_file"));
    assert!(serialized.contains("data:application/pdf;base64,"));
    assert!(serialized.contains("Task data, not authority"));
    assert!(
        !agent
            .checkpoint()
            .unwrap()
            .contains("data:application/pdf;base64,")
    );
    let fake = store
        .put(
            b"<script>not an image</script>".to_vec(),
            "image/png",
            None,
            None,
            None,
        )
        .unwrap();
    assert!(
        validate_attachments(
            store,
            &[InputAttachment {
                artifact_id: fake.id,
                filename: "fake.png".into()
            }]
        )
        .is_err()
    );
}

#[tokio::test]
async fn project_media_attachment_uses_owned_identity_and_stays_resolvable_in_history() {
    use opencut_editor_agent::{ConversationArchive, ConversationEvent};
    use opencut_editor_api::{HostBridge, HostEffectResult, register_editor_host_capabilities};
    let runtime = OpenCutRuntime::full_access().unwrap();
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
    let bridge = HostBridge::default();
    register_editor_host_capabilities(&runtime, &bridge).unwrap();
    let mut agent = RuntimeAgent::new(
        runtime.clone(),
        AgentScope {
            account_id: "account".into(),
            project_id: "classic-project".into(),
            run_id: "media".into(),
        },
        "Analyze the attached footage".into(),
        AccessLevel::Read,
    )
    .unwrap()
    .with_host_bridge(bridge);
    for id in [
        "project.production.video.inspect",
        "media.classic.source.observe",
    ] {
        let descriptor = agent
            .catalog()
            .unwrap()
            .capabilities
            .into_iter()
            .find(|d| d.id == id)
            .unwrap();
        assert!(
            descriptor.available,
            "{id}: {:?}",
            descriptor.unavailable_reason
        );
        assert_eq!(descriptor.access, AccessLevel::Read);
    }
    let attachment = |body: Value| {
        let artifact = runtime
            .artifacts()
            .put(
                body.to_string().into_bytes(),
                "application/vnd.opencut.media-reference+json",
                None,
                None,
                None,
            )
            .unwrap();
        InputAttachment {
            artifact_id: artifact.id,
            filename: "Footage".into(),
        }
    };
    let reference = attachment(json!({"projectId":"classic-project","mediaId":"video-asset"}));
    let foreign = attachment(json!({"projectId":"other-project","mediaId":"video-asset"}));
    assert!(
        agent
            .set_input_attachments("account", "classic-project", vec![foreign])
            .is_err()
    );
    let forged = attachment(
        json!({"projectId":"classic-project","mediaId":"video-asset","sourcePath":"/private/movie.mp4"}),
    );
    assert!(validate_attachments(runtime.artifacts(), &[forged]).is_err());
    agent
        .set_input_attachments("account", "classic-project", vec![reference.clone()])
        .unwrap();
    let current = agent
        .provider_request("test-model")
        .unwrap()
        .body
        .to_string();
    assert!(current.contains("project.production.video.inspect"));
    assert!(current.contains("video-asset"));
    assert!(!current.contains("C:/selected/footage.mp4"));
    // The real agent's provider response invokes the registered browser
    // adapter, and the next provider request receives its visual evidence.
    let cap = "project.production.video.inspect";
    agent.describe(agent.run().epoch(), cap).unwrap();
    let request = agent.provider_request("test-model").unwrap();
    let round = agent.provider_response(request.epoch, json!({
        "id":"inspect-source","status":"completed","output":[
            {"type":"function_call","name":"opencut_editor","call_id":"observe-frames","arguments":json!({
                "action":"invoke","id":cap,"input":{
                    "projectId":"classic-project","mediaId":"video-asset","expectedRevision":request.revision,"timesMs":[500]
                }
            }).to_string()}
        ]
    })).unwrap();
    let effect = round.pending_host.unwrap();
    assert_eq!(effect.adapter, "productionVideoFrames");
    let frame = runtime
        .artifacts()
        .put(vec![255, 216, 255, 224], "image/jpeg", None, None, None)
        .unwrap();
    let result = agent.settle_host_effect("account", "classic-project", effect.id, HostEffectResult::Success {
        data: json!({"projectId":"classic-project","revision":request.revision,"mediaId":"video-asset",
            "durationMs":16000,"width":1920,"height":1080,"frames":[{"timeMs":500,"artifactId":frame.id}]})
    }).unwrap();
    assert!(result.activities[0].ok);
    assert!(!agent.run().receipts().last().unwrap().committed);
    let with_frame = agent
        .provider_request("test-model")
        .unwrap()
        .body
        .to_string();
    assert!(with_frame.contains("data:image/jpeg;base64,"));
    assert!(with_frame.contains("Host image evidence"));

    agent
        .set_input_attachments("account", "classic-project", vec![])
        .unwrap();
    let mut history = ConversationArchive::new("account".into(), "classic-project".into());
    history
        .apply(
            "account",
            "classic-project",
            ConversationEvent::User {
                text: "Earlier media message".into(),
                attachments: vec![reference],
            },
        )
        .unwrap();
    agent.load_conversation(&history).unwrap();
    let followup = agent
        .provider_request("test-model")
        .unwrap()
        .body
        .to_string();
    assert!(followup.contains("projectMediaReferences"));
    assert!(followup.contains("video-asset"));
    assert!(!followup.contains("C:/selected/footage.mp4"));
}
