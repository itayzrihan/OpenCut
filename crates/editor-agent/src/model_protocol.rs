use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AgentCommand, AgentError, PlanStep};

/// The model's small, stable control vocabulary. Feature contracts are loaded
/// on demand from the registry. Lifecycle, identity, revisions, receipts and QA
/// attestation are intentionally supplied only by the authenticated host.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ModelAction {
    Discover { query: String, limit: usize },
    Describe { id: String },
    Plan { steps: Vec<PlanStep> },
    Invoke { id: String, input: Value },
    Complete { text: String },
    Fail { text: String },
}

impl ModelAction {
    /// epoch and call_id come from the provider request envelope captured by
    /// the host, never from generated tool arguments.
    pub fn bind(self, epoch: u64, call_id: &str) -> Result<AgentCommand, AgentError> {
        if call_id.is_empty() || call_id.len() > 256 || call_id.chars().any(char::is_control) {
            return Err(AgentError::Invalid(
                "invalid provider tool call identity".into(),
            ));
        }
        Ok(match self {
            Self::Discover { query, limit } => AgentCommand::Discover { query, limit },
            Self::Describe { id } => AgentCommand::Describe { epoch, id },
            Self::Plan { steps } => AgentCommand::Plan { epoch, steps },
            Self::Invoke { id, input } => AgentCommand::Invoke {
                epoch,
                call_id: call_id.into(),
                id,
                input,
            },
            Self::Complete { text } => AgentCommand::Finish { epoch, text },
            Self::Fail { text } => AgentCommand::Fail { epoch, text },
        })
    }
}

pub fn model_action_schema() -> Value {
    serde_json::to_value(schema_for!(ModelAction))
        .expect("generated protocol schema is serializable")
}
