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
