//! The Director's persistent editing state. Credentials and provider IO are host-only.
use crate::ModelError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub const KEY: &str = "generative";
pub const INSTRUCTIONS: &str = include_str!("generative-director.md");
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerativeDocument {
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub references: Vec<Reference>,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub transcript: String,
    #[serde(default)]
    pub jobs: Vec<Job>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub id: String,
    pub name: String,
    pub kind: ReferenceKind,
    pub mime: String,
    pub bytes: u64,
    #[serde(default)]
    pub storyboard: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceKind {
    Image,
    Audio,
    Video,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub id: String,
    pub digest: String,
    pub status: String,
    #[serde(default)]
    pub media_id: Option<String>,
}
impl GenerativeDocument {
    pub fn validate(&self) -> Result<(), ModelError> {
        let fail = || ModelError::Invalid("Invalid or oversized Director document".into());
        if self.messages.len() > 200
            || self.references.len() > 100
            || self.jobs.len() > 200
            || self.direction.len() > 100_000
            || self.transcript.len() > 100_000
        {
            return Err(fail());
        }
        let mut ids = std::collections::BTreeSet::new();
        for m in &self.messages {
            if m.id.is_empty() || !ids.insert(&m.id) || m.text.len() > 100_000 {
                return Err(fail());
            }
        }
        ids.clear();
        for r in &self.references {
            if r.id.len() != 32
                || !r.id.bytes().all(|c| c.is_ascii_hexdigit())
                || !ids.insert(&r.id)
                || r.name.len() > 300
                || r.bytes > 100 * 1024 * 1024
                || r.mime.len() > 100
            {
                return Err(fail());
            }
        }
        for j in &self.jobs {
            if j.id.len() != 32
                || j.digest.len() != 64
                || !j.digest.bytes().all(|c| c.is_ascii_hexdigit())
                || ![
                    "review",
                    "rejected",
                    "submitting",
                    "pending",
                    "processing",
                    "ready",
                    "error",
                    "uncertain",
                    "session_expired",
                ]
                .contains(&j.status.as_str())
            {
                return Err(fail());
            }
        }
        Ok(())
    }
}
