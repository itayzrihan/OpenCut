//! The editing harness's decisions belong here. Hosts perform effects (provider
//! IO, persistence and editor invocation) and feed verified results back in.
//! This crate never owns a second editor document or executes arbitrary code.

mod catalog;
mod checkpoint;
mod conversation;
mod attachments;
pub use attachments::{InputAttachment, validate_attachments};
mod artifact_storage;
pub use artifact_storage::ScopedArtifactArchive;
pub use conversation::{ConversationArchive, ConversationEntry, ConversationEvent};
mod context;
mod harness;
pub mod knowledge;
mod knowledge_capabilities;
pub use knowledge_capabilities::register_knowledge_capabilities;
mod model_protocol;
mod provider;
mod transport_policy;
pub use transport_policy::provider_retry_plan;
mod runtime;
pub mod session_store;

pub use catalog::*;
pub use context::*;
pub use harness::*;
pub use model_protocol::*;
pub use provider::*;
pub use runtime::*;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentScope {
    pub account_id: String,
    pub project_id: String,
    pub run_id: String,
}

impl AgentScope {
    pub fn validate(&self) -> Result<(), AgentError> {
        for value in [&self.account_id, &self.project_id, &self.run_id] {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err(AgentError::Invalid("invalid agent scope".into()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentError {
    #[error("invalid agent request: {0}")]
    Invalid(String),
    #[error("agent operation denied: {0}")]
    Denied(String),
    #[error("agent state conflict: {0}")]
    Conflict(String),
    #[error("agent context limit: {0}")]
    ContextLimit(String),
}
mod review;
pub use review::{ReviewFrame, ReviewPlan, ReviewResult};
