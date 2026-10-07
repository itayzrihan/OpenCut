use opencut_editor_api::{
    CapabilityDescriptor, CapabilityExecution, CapabilityResult, DocumentSupport, FnCapability,
    InvocationContext, OpenCutRuntime,
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn attach(runtime: &OpenCutRuntime) {
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            InvocationContext::default(),
            json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn classic_catalog_and_invocation_reject_invisible_rewrite_edits() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime).await;
    let before = runtime.snapshot().unwrap();
    let catalog = runtime.registry().snapshot().unwrap();
    let rewrite = catalog
        .capabilities
        .iter()
        .find(|c| c.id == "timeline.track.add")
        .unwrap();
    assert!(!rewrite.available);
    assert_eq!(rewrite.document_support, DocumentSupport::Rewrite);
    assert!(
        rewrite
            .unavailable_reason
            .as_deref()
            .unwrap()
            .contains("Classic")
    );
    assert!(
        catalog
            .capabilities
            .iter()
            .find(|c| c.id == "app.state.read")
            .unwrap()
            .available
    );
    assert!(
        catalog
            .capabilities
            .iter()
            .find(|c| c.id == "hyperframes.library.read")
            .unwrap()
            .available
    );
    let error = runtime
        .registry()
        .invoke(
            "timeline.track.add",
            InvocationContext::default(),
            json!({"kind":"video", "name":"Invisible track"}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Classic"), "{error}");
    assert_eq!(runtime.snapshot().unwrap(), before);
}

#[tokio::test]
async fn dynamic_feature_declaration_is_immediately_discovered_and_enforced() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime).await;
    let before = runtime.registry().snapshot().unwrap().revision;
    let mut descriptor = CapabilityDescriptor::read(
        "test.future.inspect",
        "Future feature",
        "Tests descriptor-only discovery",
        "test",
        json!({"type":"object", "additionalProperties":false}),
        json!({"type":"object"}),
    );
    descriptor.document_support = DocumentSupport::Classic;
    descriptor.execution = CapabilityExecution::Immediate;
    runtime
        .registry()
        .register(Arc::new(FnCapability::new(descriptor, |_, _| {
            Box::pin(async { Ok(CapabilityResult::data(json!({"visible":true}))) })
        })))
        .unwrap();
    let manifest = runtime
        .registry()
        .invoke(
            "app.capabilities.list",
            InvocationContext::default(),
            json!({}),
        )
        .await
        .unwrap();
    assert!(manifest.result.data["revision"].as_u64().unwrap() > before);
    assert!(
        manifest.result.data["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "test.future.inspect" && c["available"] == true)
    );
    assert_eq!(
        runtime
            .registry()
            .invoke(
                "test.future.inspect",
                InvocationContext::default(),
                json!({})
            )
            .await
            .unwrap()
            .result
            .data["visible"],
        true
    );
    runtime
        .registry()
        .invoke(
            "project.create",
            InvocationContext::default(),
            json!({"name":"Rewrite"}),
        )
        .await
        .unwrap();
    assert!(
        !runtime
            .registry()
            .descriptor("test.future.inspect")
            .unwrap()
            .unwrap()
            .available
    );
    assert!(
        runtime
            .registry()
            .invoke(
                "test.future.inspect",
                InvocationContext::default(),
                json!({})
            )
            .await
            .is_err()
    );
    assert!(
        runtime
            .registry()
            .descriptor("timeline.track.add")
            .unwrap()
            .unwrap()
            .available
    );
    assert!(
        !runtime
            .registry()
            .descriptor("project.classic.commit")
            .unwrap()
            .unwrap()
            .available
    );
}

#[tokio::test]
async fn explicit_inactive_project_is_resolved_instead_of_the_active_representation() {
    let runtime = OpenCutRuntime::default();
    attach(&runtime).await;
    runtime
        .registry()
        .invoke(
            "project.create",
            InvocationContext::default(),
            json!({"name":"Rewrite"}),
        )
        .await
        .unwrap();
    // The descriptor gate resolves the requested representation. The handler
    // then independently enforces its documented active-session requirement.
    let error = runtime
        .registry()
        .invoke(
            "project.classic.session.read",
            InvocationContext::default(),
            json!({"projectId":"classic-project"}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("target project is not active"));
    let receipt = runtime.registry().invoke("app.state.read", InvocationContext::default(), json!({"projectId":"classic-project", "pointer":"/project/classic/document/metadata/id"})).await.unwrap();
    assert_eq!(receipt.result.data["value"], "classic-project");
}
