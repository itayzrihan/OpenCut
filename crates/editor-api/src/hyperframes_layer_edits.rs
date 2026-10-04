use crate::{
    ClassicProject, HyperframesLayerKind, HyperframesRuntimeManifest, HyperframesSource, ModelError,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Per-occurrence visual overrides. Original package bytes and animation stay intact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesLayerEdits {
    pub source_fingerprint: String,
    pub manifest_fingerprint: String,
    pub opacity: BTreeMap<String, f64>,
}

pub fn hyperframes_manifest_fingerprint(manifest: &HyperframesRuntimeManifest) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(manifest).expect("validated serializable manifest"))
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesLayerRenderEdit {
    pub key: String,
    pub element_id: String,
    pub opacity: f64,
}

fn invalid(message: &str) -> ModelError {
    ModelError::Invalid(format!("HyperFrames layer edits: {message}"))
}

pub fn hyperframes_layer_is_editable(layer: &crate::HyperframesRuntimeLayer) -> bool {
    let Some(path) = layer.key.strip_prefix("dom/") else {
        return false;
    };
    let parts: Vec<_> = path.split('/').collect();
    layer.kind != HyperframesLayerKind::Audio
        && layer.file.is_some()
        && layer.element_id.as_ref().is_some_and(|id| !id.is_empty())
        && !parts.is_empty()
        && parts.len() <= 128
        && parts.iter().all(|part| {
            part.parse::<u32>()
                .is_ok_and(|index| index.to_string() == *part)
        })
}

impl HyperframesLayerEdits {
    pub fn prepare(
        &self,
        source: &HyperframesSource,
        manifest: &HyperframesRuntimeManifest,
    ) -> Result<Vec<HyperframesLayerRenderEdit>, ModelError> {
        manifest.validate(source)?;
        if self.source_fingerprint != manifest.source_fingerprint
            || self.manifest_fingerprint != hyperframes_manifest_fingerprint(manifest)
            || self.opacity.len() > 20_000
        {
            return Err(invalid("source fingerprint or edit count is invalid"));
        }
        let layers: BTreeMap<_, _> = manifest
            .layers
            .iter()
            .map(|layer| (layer.key.as_str(), layer))
            .collect();
        self.opacity
            .iter()
            .map(|(key, opacity)| {
                let layer = layers
                    .get(key.as_str())
                    .ok_or_else(|| invalid("layer no longer exists"))?;
                if !hyperframes_layer_is_editable(layer) {
                    return Err(invalid("layer has no unique visual DOM occurrence"));
                }
                if !opacity.is_finite() || !(0.0..=1.0).contains(opacity) {
                    return Err(invalid("opacity must be between zero and one"));
                }
                Ok(HyperframesLayerRenderEdit {
                    key: key.clone(),
                    element_id: layer.element_id.clone().unwrap(),
                    opacity: *opacity,
                })
            })
            .collect()
    }
}

impl ClassicProject {
    pub fn set_hyperframes_layer_opacity(
        &mut self,
        scene_id: &str,
        element_id: &str,
        layer_key: &str,
        opacity: f64,
    ) -> Result<(), ModelError> {
        let scene = self
            .scenes()?
            .iter()
            .find(|scene| scene["id"] == scene_id)
            .ok_or_else(|| invalid("scene does not exist"))?;
        let tracks = crate::classic::tracks(scene)?;
        let (track, element) = tracks
            .iter()
            .find_map(|track| {
                track["elements"]
                    .as_array()?
                    .iter()
                    .find(|element| element["id"] == element_id)
                    .map(|element| (*track, element))
            })
            .ok_or_else(|| invalid("clip does not exist"))?;
        if track["locked"] == true || element["locked"] == true {
            return Err(invalid("clip or track is locked"));
        }
        if element["definitionId"] != "hyperframes" {
            return Err(invalid("clip is not a HyperFrames composition"));
        }
        let compositions = self.compositions()?;
        let composition = element["params"]["hyperframesAssetId"]
            .as_str()
            .and_then(|id| compositions.get(id))
            .ok_or_else(|| invalid("composition is missing"))?;
        let manifest = composition
            .runtime_manifest
            .as_ref()
            .ok_or_else(|| invalid("analyze the composition layers first"))?;
        let mut edits = match element.get("hyperframesLayerEdits") {
            Some(value) => serde_json::from_value::<HyperframesLayerEdits>(value.clone())
                .map_err(|error| invalid(&error.to_string()))?,
            None => HyperframesLayerEdits {
                source_fingerprint: manifest.source_fingerprint.clone(),
                manifest_fingerprint: hyperframes_manifest_fingerprint(manifest),
                opacity: BTreeMap::new(),
            },
        };
        // Validate even a reset, so stale or ambiguous layer targets cannot silently succeed.
        edits.opacity.insert(layer_key.to_owned(), opacity);
        edits.prepare(&composition.source, manifest)?;
        if opacity == 1.0 {
            edits.opacity.remove(layer_key);
        }
        let value = if edits.opacity.is_empty() {
            None
        } else {
            Some(serde_json::to_value(edits).map_err(|error| invalid(&error.to_string()))?)
        };
        let track_id = track["id"].clone();
        let scene = self
            .document
            .get_mut("scenes")
            .and_then(Value::as_array_mut)
            .unwrap()
            .iter_mut()
            .find(|scene| scene["id"] == scene_id)
            .unwrap();
        let tracks = scene["tracks"].as_object_mut().unwrap();
        for group in ["main", "overlay", "audio"] {
            let group = tracks.get_mut(group).unwrap();
            let candidates: Vec<&mut Value> = if group.is_array() {
                group.as_array_mut().unwrap().iter_mut().collect()
            } else {
                vec![group]
            };
            for track in candidates {
                if track["id"] != track_id {
                    continue;
                }
                let element = track["elements"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|element| element["id"] == element_id)
                    .unwrap()
                    .as_object_mut()
                    .unwrap();
                if let Some(value) = value {
                    element.insert("hyperframesLayerEdits".into(), value);
                } else {
                    element.remove("hyperframesLayerEdits");
                }
                return Ok(());
            }
        }
        Err(invalid("clip track is missing"))
    }
}
