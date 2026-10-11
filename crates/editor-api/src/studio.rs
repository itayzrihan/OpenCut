//! Canonical source document for the full HyperFrames Studio host.
//! Materialized files are disposable host caches; these records own editing state.
use crate::ModelError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const STUDIO_KEY: &str = "hypercutStudio";
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioDocument {
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub assets: BTreeMap<String, StudioAsset>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAsset {
    pub sha256: String,
    pub bytes: u64,
}
pub fn validate_path(path: &str) -> Result<(), ModelError> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains(['\\', ':', '\0'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return Err(ModelError::Invalid(format!(
            "Invalid Studio relative path: {path}"
        )));
    }
    Ok(())
}
impl StudioDocument {
    pub fn validate(&self) -> Result<(), ModelError> {
        if !self.files.contains_key("index.html") || self.files.len() + self.assets.len() > 4096 {
            return Err(ModelError::Invalid(
                "Studio requires index.html and at most 4096 files".into(),
            ));
        }
        let mut size = 0usize;
        for (path, content) in &self.files {
            validate_path(path)?;
            size += content.len();
            if content.contains('\0') || content.len() > 8 * 1024 * 1024 || size > 32 * 1024 * 1024
            {
                return Err(ModelError::Invalid(
                    "Studio text exceeds its bounded source budget".into(),
                ));
            }
        }
        for (path, asset) in &self.assets {
            validate_path(path)?;
            if self.files.contains_key(path)
                || asset.sha256.len() != 64
                || !asset
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            {
                return Err(ModelError::Invalid("Invalid Studio asset binding".into()));
            }
        }
        Ok(())
    }
}
