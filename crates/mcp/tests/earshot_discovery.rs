use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use opencut_mcp::OpenCutMcp;
use serde_json::json;

#[tokio::test]
async fn earshot_library_projects_to_mcp_from_live_registry_without_transport_tools() {
    let runtime = OpenCutRuntime::default();
    let server = OpenCutMcp::from_runtime(&runtime);
    let tools = server.tools().unwrap();
    for suffix in [
        "catalog.search",
        "catalog.read",
        "repository.list",
        "repository.read",
        "repository.search",
        "repository.artifact",
    ] {
        let id = format!("audio.earshot.{suffix}");
        let tool = tools
            .iter()
            .find(|tool| tool.name == format!("opencut.{id}"))
            .expect("registry projects Earshot tool");
        let descriptor = server.registry().descriptor(&id).unwrap().unwrap();
        assert_eq!(descriptor.access, AccessLevel::Read);
        assert!(!descriptor.open_world);
        assert_eq!(
            tool.input_schema.as_ref(),
            descriptor.input_schema.as_object().unwrap()
        );
        assert!(tool.output_schema.is_some());
    }
    let result = server
        .registry()
        .invoke(
            "audio.earshot.repository.list",
            InvocationContext {
                source: "mcp".into(),
                ..Default::default()
            },
            json!({"prefix":"skills/","limit":80}),
        )
        .await
        .unwrap();
    assert!(result.result.data["totalMatches"].as_u64().unwrap() > 0);
    assert!(
        result.result.data["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["path"].as_str().unwrap().starts_with("skills/"))
    );
}
