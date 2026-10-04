//! Timeline views of runtime layers inside an existing Classic compound clip.
use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::Serialize;

use crate::{
    CLASSIC_TICKS_PER_SECOND, ClassicProject, HyperframesLayerKind, HyperframesRuntimeLayer,
    ModelError,
};

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassicHyperframesLayerRow {
    pub key: String,
    pub parent_key: Option<String>,
    pub label: String,
    pub kind: HyperframesLayerKind,
    pub depth: usize,
    /// Classic timeline ticks, clipped to the compound and all ancestor windows.
    pub start_time: i64,
    pub duration: i64,
    pub source_start_seconds: f64,
    pub source_end_seconds: f64,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassicHyperframesLayerRows {
    pub track_id: String,
    pub element_id: String,
    pub composition_id: String,
    pub name: String,
    pub rows: Vec<ClassicHyperframesLayerRow>,
}

impl ClassicProject {
    pub fn hyperframes_layer_rows(
        &self,
        scene_id: &str,
        element_id: &str,
    ) -> Result<ClassicHyperframesLayerRows, ModelError> {
        let scene = self
            .scenes()?
            .iter()
            .find(|scene| scene["id"] == scene_id)
            .ok_or_else(|| ModelError::Invalid("HyperFrames layer scene is missing".into()))?;
        let (track, element) = crate::classic::tracks(scene)?
            .into_iter()
            .find_map(|track| {
                track["elements"]
                    .as_array()?
                    .iter()
                    .find(|element| element["id"] == element_id)
                    .map(|element| (track, element))
            })
            .ok_or_else(|| ModelError::Invalid("HyperFrames compound clip is missing".into()))?;
        if element["type"] != "graphic" || element["definitionId"] != "hyperframes" {
            return Err(ModelError::Invalid(
                "Layer rows require a HyperFrames compound clip".into(),
            ));
        }
        let id = element["params"]["hyperframesAssetId"]
            .as_str()
            .ok_or_else(|| ModelError::Invalid("HyperFrames composition is missing".into()))?;
        let compositions = self.compositions()?;
        let composition = compositions
            .get(id)
            .ok_or_else(|| ModelError::Invalid("HyperFrames composition is missing".into()))?;
        let manifest = composition.runtime_manifest.as_ref().ok_or_else(|| {
            ModelError::Invalid("Read this composition's layers in the inspector first".into())
        })?;
        let ticks = CLASSIC_TICKS_PER_SECOND as f64;
        let clip_start = element["startTime"].as_i64().unwrap_or(0);
        let trim_start = element["trimStart"].as_i64().unwrap_or(0) as f64 / ticks;
        let source_end = (trim_start + element["duration"].as_i64().unwrap_or(0) as f64 / ticks)
            .min(composition.duration_seconds);
        let mut children: BTreeMap<Option<&str>, Vec<&HyperframesRuntimeLayer>> = BTreeMap::new();
        for layer in &manifest.layers {
            children
                .entry(layer.parent_key.as_deref())
                .or_default()
                .push(layer);
        }
        // The validated manifest bounds nesting to 128 and rejects missing parents/cycles.
        let mut pending: Vec<_> = children
            .get(&None)
            .into_iter()
            .flatten()
            .rev()
            .map(|layer| (*layer, 0, trim_start, source_end))
            .collect();
        let mut rows = Vec::new();
        while let Some((layer, depth, parent_start, parent_end)) = pending.pop() {
            let start = layer.start_seconds.max(parent_start);
            let end = (layer.start_seconds + layer.duration_seconds).min(parent_end);
            if end <= start {
                continue;
            }
            let start_time = clip_start + ((start - trim_start) * ticks).round() as i64;
            let end_time = clip_start + ((end - trim_start) * ticks).round() as i64;
            if end_time <= start_time {
                continue;
            }
            rows.push(ClassicHyperframesLayerRow {
                key: layer.key.clone(),
                parent_key: layer.parent_key.clone(),
                label: layer.label.clone(),
                kind: layer.kind,
                depth,
                start_time,
                duration: end_time - start_time,
                source_start_seconds: start,
                source_end_seconds: end,
            });
            if let Some(descendants) = children.get(&Some(layer.key.as_str())) {
                pending.extend(
                    descendants
                        .iter()
                        .rev()
                        .map(|child| (*child, depth + 1, start, end)),
                );
            }
        }
        Ok(ClassicHyperframesLayerRows {
            track_id: track["id"].as_str().unwrap_or_default().into(),
            element_id: element_id.into(),
            composition_id: id.into(),
            name: element["name"].as_str().unwrap_or_default().into(),
            rows,
        })
    }
}
