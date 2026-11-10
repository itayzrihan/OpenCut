//! The Director's persistent editing state. Credentials and provider IO are host-only.
use crate::ModelError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub const KEY: &str = "generative";
pub const INSTRUCTIONS: &str = include_str!("generative-director.md");
pub mod chapters;
pub mod storyboard;
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
    /// Client-facing proposal copy. Generation prompts remain in `direction`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storyboard: Option<storyboard::Storyboard>,
    #[serde(default)]
    pub chapter_plans: Vec<chapters::Plan>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub production_handoff:Option<crate::production::ProductionHandoff>,
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
        if let Some(handoff)=&self.production_handoff {handoff.validate()?;}
        if self.chapter_plans.len() > 16 {
            return Err(ModelError::Invalid(
                "At most 16 chapter collections per project".into(),
            ));
        }
        let mut plans = std::collections::BTreeSet::new();
        for plan in &self.chapter_plans {
            plan.validate()?;
            if !plans.insert(&plan.id) {
                return Err(ModelError::Invalid("Duplicate chapter collection".into()));
            }
        }
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
        if let Some(storyboard) = &self.storyboard {
            storyboard.validate(&self.references)?;
        }
        Ok(())
    }
}
