//! Canonical, serializable Classic render queue. Hosts persist bytes and render;
//! they never implement a parallel queue state machine.
use crate::{ClassicProject, ModelError, Rational};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueExportOptions {
    pub format: QueueFormat,
    pub quality: QueueQuality,
    pub preferences: QueuePreferences,
    pub fps: Rational,
    pub include_audio: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum QueueFormat {
    Mp4,
    Webm,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueueQuality {
    Low,
    Medium,
    High,
    VeryHigh,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuePreferences {
    pub resolution: QueueResolution,
    pub encoding: QueueEncoding,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum QueueResolution {
    Project,
    Source,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum QueueEncoding {
    Compatible,
    Compact,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum QueueStatus {
    Queued,
    Rendering,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedRender {
    pub id: String,
    pub project_id: String,
    pub scene_id: String,
    pub source_revision: u64,
    pub snapshot: ClassicProject,
    pub snapshot_hash: String,
    pub options: QueueExportOptions,
    pub status: QueueStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub progress: f64,
    pub message: String,
    pub attempt: Option<String>,
    pub cancel_requested: bool,
    pub output_id: Option<String>,
}
impl QueuedRender {
    pub fn validate(&self) -> Result<(), ModelError> {
        let bad = |s: &str| ModelError::Invalid(s.into());
        if [&self.id, &self.project_id, &self.scene_id]
            .iter()
            .any(|s| s.is_empty() || s.len() > 160)
        {
            return Err(bad("Invalid render job identity"));
        }
        self.snapshot.validate()?;
        if self.snapshot.document["metadata"]["id"] != self.project_id
            || !self.snapshot.document["scenes"]
                .as_array()
                .is_some_and(|s| s.iter().any(|s| s["id"] == self.scene_id))
        {
            return Err(bad("Render snapshot does not match its project and scene"));
        }
        self.options.fps.validate("Render fps")?;
        let fps = self.options.fps.numerator as f64 / self.options.fps.denominator as f64;
        if fps > 240.0
            || !self.progress.is_finite()
            || !(0.0..=1.0).contains(&self.progress)
            || self.message.len() > 4000
        {
            return Err(bad("Invalid render progress, frame rate or message"));
        }
        if self.snapshot_hash != snapshot_hash(&self.snapshot, &self.options, &self.scene_id) {
            return Err(bad("Render snapshot integrity mismatch"));
        }
        if self.status == QueueStatus::Completed && self.output_id.as_deref() != Some(&self.id) {
            return Err(bad("Completed render requires its output identity"));
        }
        if self.status == QueueStatus::Rendering
            && self
                .attempt
                .as_ref()
                .is_none_or(|s| s.is_empty() || s.len() > 160)
        {
            return Err(bad("Rendering requires a fenced worker attempt"));
        }
        Ok(())
    }
}
pub fn snapshot_hash(
    snapshot: &ClassicProject,
    options: &QueueExportOptions,
    scene: &str,
) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(snapshot, options, scene)).expect("Serializable snapshot")
        )
    )
}
