//! Lossless Classic document boundary. Presentation-specific fields remain in
//! the document; this module validates identity, timing and composition links.

use std::collections::{BTreeMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{HyperframesComposition, ModelError, ProjectSettings, Rational};

// The established Classic media clock (classic/rust/crates/time).
pub const CLASSIC_TICKS_PER_SECOND: i64 = 120_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClassicProject {
    /// Serialized TProject, including fields not understood by this bridge.
    pub document: Map<String, Value>,
    /// Host-owned durable media records. File/Blob/AudioBuffer/URL objects are
    /// excluded by the host; resource bytes stay in existing media storage.
    pub media_assets: Vec<Map<String, Value>>,
}

impl ClassicProject {
    pub fn id(&self) -> Result<&str, ModelError> {
        string_at(
            self.document
                .get("metadata")
                .ok_or_else(|| invalid("metadata is required"))?,
            "id",
        )
    }

    pub fn name(&self) -> Result<&str, ModelError> {
        string_at(
            self.document
                .get("metadata")
                .ok_or_else(|| invalid("metadata is required"))?,
            "name",
        )
    }

    pub fn settings(&self) -> Result<ProjectSettings, ModelError> {
        let settings = self
            .document
            .get("settings")
            .ok_or_else(|| invalid("settings are required"))?;
        let frame_rate: Rational = serde_json::from_value(settings["fps"].clone())
            .map_err(|_| invalid("fps must be a rational frame rate"))?;
        frame_rate.validate("Classic fps")?;
        let width = settings["canvasSize"]["width"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("canvas width must be positive"))?;
        let height = settings["canvasSize"]["height"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("canvas height must be positive"))?;
        Ok(ProjectSettings {
            width,
            height,
            frame_rate: frame_rate.numerator as f64 / frame_rate.denominator as f64,
            frame_rate_rational: frame_rate,
            time_base: Rational::new(1, CLASSIC_TICKS_PER_SECOND),
            ..ProjectSettings::default()
        })
    }

    pub fn validate(&self) -> Result<(), ModelError> {
        self.id()?;
        self.name()?;
        self.settings()?;
        let scenes = self.scenes()?;
        let active = self
            .document
            .get("currentSceneId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("currentSceneId is required"))?;
        let mut scene_ids = HashSet::new();
        let mut entity_ids = HashSet::new();
        let compositions = self.compositions()?;
        let mut asset_ids = HashSet::new();
        for asset in &self.media_assets {
            if ["file", "url", "buffer"]
                .iter()
                .any(|key| asset.contains_key(*key))
            {
                return Err(invalid(
                    "media bindings must omit transient file, URL and buffer handles",
                ));
            }
            let id = asset
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("media id is required"))?;
            if !asset_ids.insert(id) {
                return Err(invalid("duplicate media id"));
            }
        }
        for (id, composition) in &compositions {
            if id.trim().is_empty() {
                return Err(invalid("composition id must not be empty"));
            }
            composition.validate()?;
            for resource in composition.source.resource_asset_ids.values() {
                if !asset_ids.contains(resource.as_str())
                    || self.media_assets.iter().any(|asset| {
                        asset.get("id").and_then(Value::as_str) == Some(resource.as_str())
                            && asset
                                .get("unifiedAngles")
                                .is_some_and(|value| !value.is_null())
                    })
                {
                    return Err(invalid(&format!(
                        "unbound HyperFrames resource `{resource}`"
                    )));
                }
            }
        }
        for scene in scenes {
            if !scene_ids.insert(string_at(scene, "id")?) {
                return Err(invalid("duplicate scene id"));
            }
            for track in tracks(scene)? {
                let track_id = string_at(track, "id")?;
                if !entity_ids.insert(track_id) {
                    return Err(invalid("duplicate track or element id"));
                }
                string_at(track, "type")?;
                for element in elements(track)? {
                    if !entity_ids.insert(string_at(element, "id")?) {
                        return Err(invalid("duplicate track or element id"));
                    }
                    string_at(element, "type")?;
                    let start = ticks(element, "startTime")?;
                    let duration = ticks(element, "duration")?;
                    ticks(element, "trimStart")?;
                    ticks(element, "trimEnd")?;
                    if start
                        .checked_add(duration)
                        .is_none_or(|end| end > MAX_SAFE_INTEGER)
                    {
                        return Err(invalid("element end exceeds safe integer timing"));
                    }
                    if element["definitionId"] == "hyperframes" {
                        let id = element["params"]["hyperframesAssetId"]
                            .as_str()
                            .ok_or_else(|| invalid("HyperFrames clip is missing its source ID"))?;
                        if element["type"] != "graphic" || !compositions.contains_key(id) {
                            return Err(invalid(
                                "HyperFrames clip must reference an existing composition",
                            ));
                        }
                    }
                }
            }
        }
        if !scene_ids.contains(active) {
            return Err(invalid("active scene does not exist"));
        }
        Ok(())
    }

    pub fn compositions(&self) -> Result<BTreeMap<String, HyperframesComposition>, ModelError> {
        match self.document.get("hyperframesCompositions") {
            None => Ok(BTreeMap::new()),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|e| invalid(&format!("invalid composition collection: {e}"))),
        }
    }

    pub fn scenes(&self) -> Result<&Vec<Value>, ModelError> {
        self.document
            .get("scenes")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("scenes must be an array"))
    }

    pub fn duration(&self) -> f64 {
        self.scenes()
            .ok()
            .and_then(|scenes| {
                scenes
                    .iter()
                    .find(|scene| scene["id"] == self.document["currentSceneId"])
            })
            .and_then(|scene| tracks(scene).ok())
            .into_iter()
            .flatten()
            .flat_map(|track| elements(track).into_iter().flatten())
            .filter_map(|e| {
                e["startTime"]
                    .as_i64()?
                    .checked_add(e["duration"].as_i64()?)
            })
            .max()
            .unwrap_or(0) as f64
            / CLASSIC_TICKS_PER_SECOND as f64
    }

    pub fn main_scene_duration(&self) -> f64 {
        self.scenes()
            .ok()
            .and_then(|scenes| {
                scenes
                    .iter()
                    .find(|scene| scene["isMain"] == true)
                    .or_else(|| scenes.first())
            })
            .and_then(|scene| tracks(scene).ok())
            .into_iter()
            .flatten()
            .flat_map(|track| elements(track).into_iter().flatten())
            .filter_map(|e| {
                e["startTime"]
                    .as_i64()?
                    .checked_add(e["duration"].as_i64()?)
            })
            .max()
            .unwrap_or(0) as f64
            / CLASSIC_TICKS_PER_SECOND as f64
    }
}

pub(crate) fn tracks(scene: &Value) -> Result<Vec<&Value>, ModelError> {
    let tracks = scene
        .get("tracks")
        .ok_or_else(|| invalid("scene tracks are required"))?;
    let mut result = vec![
        tracks
            .get("main")
            .filter(|v| v.is_object())
            .ok_or_else(|| invalid("main track is required"))?,
    ];
    for group in ["overlay", "audio"] {
        result.extend(
            tracks[group]
                .as_array()
                .ok_or_else(|| invalid("track groups must be arrays"))?,
        );
    }
    Ok(result)
}

fn elements(track: &Value) -> Result<&Vec<Value>, ModelError> {
    track["elements"]
        .as_array()
        .ok_or_else(|| invalid("track elements must be an array"))
}

fn string_at<'a>(value: &'a Value, key: &str) -> Result<&'a str, ModelError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| invalid(&format!("{key} must be a non-empty string")))
}

fn ticks(value: &Value, key: &str) -> Result<i64, ModelError> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|v| (0..=MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid(&format!("{key} must be non-negative safe integer ticks")))
}

fn invalid(message: &str) -> ModelError {
    ModelError::Invalid(format!("Classic project: {message}"))
}
