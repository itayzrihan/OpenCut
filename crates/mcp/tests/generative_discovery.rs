use opencut_editor_api::{HostBridge, OpenCutRuntime, register_generative_host};
use opencut_mcp::OpenCutMcp;
#[test]
fn director_review_is_discovered_from_registry_with_no_approval_tool() {
    let rt = OpenCutRuntime::full_access().unwrap();
    let server = OpenCutMcp::from_runtime(&rt);
    assert!(
        !server
            .tools()
            .unwrap()
            .iter()
            .any(|t| t.name == "opencut.project.generative.request")
    );
    register_generative_host(&rt, &HostBridge::default()).unwrap();
    let tools = server.tools().unwrap();
    let tool = tools
        .iter()
        .find(|t| t.name == "opencut.project.generative.request")
        .unwrap();
    let mut projected=tool.input_schema.as_ref().clone();
    projected.get_mut("properties").unwrap().as_object_mut().unwrap().remove("idempotencyKey");
    assert_eq!(&projected,rt.registry().descriptor("project.generative.request").unwrap().unwrap().input_schema.as_object().unwrap());
    for denied in ["approve", "unlock", "setup", "key"] {
        assert!(
            !tools
                .iter()
                .any(|t| t.name == format!("opencut.project.generative.{denied}"))
        );
    }
}
