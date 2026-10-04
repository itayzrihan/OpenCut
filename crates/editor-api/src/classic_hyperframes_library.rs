//! Read-only library metadata for preserved Classic source packages.
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::Serialize;

use crate::{ClassicProject, ModelError};

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassicHyperframesLibraryItem {
    pub asset_id: String,
    pub name: String,
    pub entry_file: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_seconds: f64,
    pub source_file_count: usize,
    pub resource_asset_ids: Vec<String>,
    pub occurrences: Vec<ClassicHyperframesLibraryOccurrence>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassicHyperframesLibraryOccurrence {
    pub scene_id: String,
    pub scene_name: String,
    pub track_id: String,
    pub element_id: String,
    pub name: String,
    pub start_time: i64,
}

impl ClassicProject {
    pub fn hyperframes_library(&self) -> Result<Vec<ClassicHyperframesLibraryItem>, ModelError> {
        let mut occurrences: BTreeMap<String, Vec<ClassicHyperframesLibraryOccurrence>> =
            BTreeMap::new();
        for scene in self.scenes()? {
            for track in crate::classic::tracks(scene)? {
                for element in track["elements"].as_array().into_iter().flatten() {
                    if element["type"] != "graphic" || element["definitionId"] != "hyperframes" {
                        continue;
                    }
                    let Some(asset_id) = element["params"]["hyperframesAssetId"].as_str() else {
                        continue;
                    };
                    occurrences.entry(asset_id.into()).or_default().push(
                        ClassicHyperframesLibraryOccurrence {
                            scene_id: scene["id"].as_str().unwrap_or_default().into(),
                            scene_name: scene["name"].as_str().unwrap_or_default().into(),
                            track_id: track["id"].as_str().unwrap_or_default().into(),
                            element_id: element["id"].as_str().unwrap_or_default().into(),
                            name: element["name"].as_str().unwrap_or_default().into(),
                            start_time: element["startTime"].as_i64().unwrap_or(0),
                        },
                    );
                }
            }
        }
        self.compositions()?
            .into_iter()
            .map(|(asset_id, composition)| {
                let occurrences = occurrences.remove(&asset_id).unwrap_or_default();
                Ok(ClassicHyperframesLibraryItem {
                    name: occurrences
                        .iter()
                        .find(|item| !item.name.trim().is_empty())
                        .map(|item| item.name.clone())
                        .unwrap_or(composition.composition_id),
                    asset_id,
                    entry_file: composition.source.entry_file.clone(),
                    width: composition.width,
                    height: composition.height,
                    fps: composition.fps,
                    duration_seconds: composition.duration_seconds,
                    source_file_count: composition.source.files.len(),
                    resource_asset_ids: composition
                        .source
                        .resource_asset_ids
                        .values()
                        .cloned()
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect(),
                    occurrences,
                })
            })
            .collect()
    }
}
