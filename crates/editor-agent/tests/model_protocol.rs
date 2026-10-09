use opencut_editor_agent::{AgentCommand, ModelAction, model_action_schema};
use serde_json::json;

#[test]
fn model_cannot_supply_host_identity_revision_or_verification() {
    for input in [
        json!({"action":"verify","revision":10,"issues":[]}),
        json!({"action":"resume","scope":{"accountId":"bob"}}),
        json!({"action":"invoke","id":"app.state.read","input":{},"epoch":100}),
        json!({"action":"invoke","id":"app.state.read","input":{},"callId":"another-call"}),
    ] {
        assert!(serde_json::from_value::<ModelAction>(input).is_err());
    }
    let action: ModelAction = serde_json::from_value(
        json!({"action":"invoke","id":"future.feature","input":{"value":12}}),
    )
    .unwrap();
    match action.bind(8, "provider-call").unwrap() {
        AgentCommand::Invoke {
            epoch,
            call_id,
            id,
            input,
        } => {
            assert_eq!(epoch, 8);
            assert_eq!(call_id, "provider-call");
            assert_eq!(id, "future.feature");
            assert_eq!(input["value"], 12);
        }
        _ => panic!("expected registry invocation"),
    }
    let schema = model_action_schema();
    assert!(schema.to_string().contains("discover"));
    assert!(!schema.to_string().contains("future.feature"));
    assert!(!schema.to_string().contains("verify"));
}
