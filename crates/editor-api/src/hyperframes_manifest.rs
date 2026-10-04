//! Validated runtime observations. Source packages remain the editable authority.
//! The host executes the pinned renderer; Rust owns the persisted contract.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{HyperframesSource, ModelError};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesRuntimeManifest {
    pub source_fingerprint: String,
    pub runtime_version: String,
    pub duration_seconds: f64,
    pub layers: Vec<HyperframesRuntimeLayer>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesRuntimeLayer {
    /// Runtime occurrence identity, not an author ID shared by nested hosts.
    pub key: String,
    pub parent_key: Option<String>,
    pub file: Option<String>,
    pub element_id: Option<String>,
    pub label: String,
    pub kind: HyperframesLayerKind,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub track_index: i32,
    /// Package path only; never persist a temporary preview URL or local path.
    pub resource_path: Option<String>,
    pub playback_start_seconds: f64,
    pub playback_rate: f64,
    pub media: Option<HyperframesRuntimeMedia>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HyperframesLayerKind {
    Composition,
    Element,
    Image,
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesRuntimeMedia {
    pub source_duration_seconds: Option<f64>,
    pub muted: bool,
    pub looping: bool,
    /// Authored audio/rate attributes remain intact for the audio adapter.
    /// Runtime-forced mute/volume must not replace the author's values.
    pub attributes: BTreeMap<String, String>,
}

impl HyperframesRuntimeManifest {
    pub fn validate(&self, source: &HyperframesSource) -> Result<(), ModelError> {
        source.validate()?;
        if self.source_fingerprint != source.fingerprint() {
            return invalid("runtime manifest belongs to a different HyperFrames source");
        }
        if self.runtime_version.is_empty() || self.runtime_version.len() > 128 {
            return invalid("runtime manifest requires a bounded runtime version");
        }
        if !self.duration_seconds.is_finite() || self.duration_seconds <= 0.0 {
            return invalid("runtime manifest duration must be finite and positive");
        }
        if self.layers.len() > 20_000
            || self.diagnostics.len() > 256
            || self.diagnostics.iter().any(|message| message.len() > 2048)
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > 4 * 1024 * 1024)
        {
            return invalid("runtime manifest exceeds its size limit");
        }
        let mut parents = BTreeMap::new();
        for layer in &self.layers {
            if layer.key.is_empty() || layer.key.len() > 1024 || layer.label.len() > 2048 {
                return invalid("runtime layer requires a bounded key and label");
            }
            if parents
                .insert(layer.key.as_str(), layer.parent_key.as_deref())
                .is_some()
            {
                return invalid("runtime layer occurrence keys must be unique");
            }
            if layer.element_id.as_ref().is_some_and(|id| id.len() > 1024)
                || layer
                    .file
                    .as_ref()
                    .is_some_and(|file| !source.files.contains_key(file))
                || layer.resource_path.as_ref().is_some_and(|path| {
                    !source.files.contains_key(path)
                        && !source.resource_asset_ids.contains_key(path)
                })
            {
                return invalid("runtime layer references an unknown package file");
            }
            if !layer.start_seconds.is_finite()
                || !layer.duration_seconds.is_finite()
                || layer.duration_seconds <= 0.0
                || !(layer.start_seconds + layer.duration_seconds).is_finite()
                || !layer.playback_start_seconds.is_finite()
                || layer.playback_start_seconds < 0.0
                || !layer.playback_rate.is_finite()
                || layer.playback_rate <= 0.0
            {
                return invalid(
                    "runtime layer timing must be finite with positive duration and rate",
                );
            }
            if let Some(media) = &layer.media
                && (!matches!(
                    layer.kind,
                    HyperframesLayerKind::Audio | HyperframesLayerKind::Video
                ) || media
                    .source_duration_seconds
                    .is_some_and(|duration| !duration.is_finite() || duration <= 0.0)
                    || media.attributes.len() > 64
                    || media.attributes.iter().any(|(key, value)| {
                        !key.starts_with("data-") || key.len() > 128 || value.len() > 16_384
                    }))
            {
                return invalid("runtime media metadata is invalid or exceeds its size limit");
            }
        }
        for layer in &self.layers {
            let mut seen = BTreeSet::from([layer.key.as_str()]);
            let mut parent = layer.parent_key.as_deref();
            while let Some(key) = parent {
                if !seen.insert(key) || seen.len() > 128 {
                    return invalid("runtime layer parents contain a cycle or exceed 128 levels");
                }
                parent = *parents
                    .get(key)
                    .ok_or_else(|| ModelError::Invalid("runtime layer parent is missing".into()))?;
            }
        }
        Ok(())
    }
}

fn invalid<T>(message: &str) -> Result<T, ModelError> {
    Err(ModelError::Invalid(message.into()))
}
