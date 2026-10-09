use crate::AgentError;
use opencut_editor_api::{ArtifactArchive, ArtifactStore};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedArtifactArchive {
    pub account_id: String,
    pub project_id: String,
    pub archive: ArtifactArchive,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable_ids: Vec<String>,
}
impl ScopedArtifactArchive {
    pub fn validate_scope(&self, account: &str, project: &str) -> Result<(), AgentError> {
        if self.account_id != account || self.project_id != project {
            return Err(AgentError::Denied(
                "Artifact archive belongs to another account or project".into(),
            ));
        }
        Ok(())
    }
    pub fn restore(
        &self,
        account: &str,
        project: &str,
        store: &ArtifactStore,
    ) -> Result<(), AgentError> {
        self.validate_scope(account, project)?;
        store
            .restore(&self.archive)
            .map_err(|e| AgentError::Invalid(e.to_string()))
    }
}
