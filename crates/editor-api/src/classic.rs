//! Lossless Classic document boundary. Presentation-specific fields remain in
//! the document; this module validates identity, timing and composition links.

use std::{
    collections::{BTreeMap, HashSet},
    ops::{Deref, DerefMut},
    sync::Arc,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{HyperframesComposition, HyperframesSource, ModelError, ProjectSettings, Rational};

// The established Classic media clock (classic/rust/crates/time).
pub const CLASSIC_TICKS_PER_SECOND: i64 = 120_000;
pub(crate) const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClassicProject {
    /// Serialized TProject, including fields not understood by this bridge.
    #[schemars(with = "Map<String, Value>")]
    pub document: ClassicDocument,
    /// Host-owned durable media records. File/Blob/AudioBuffer/URL objects are
    /// excluded by the host; resource bytes stay in existing media storage.
    pub media_assets: Vec<Map<String, Value>>,
}

/// Keep the established JSON shape while sharing immutable source text across
/// snapshots. Unknown Classic and composition properties remain lossless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassicDocument {
    #[serde(flatten)]
    pub fields: Map<String, Value>,
    #[serde(
        rename = "hyperframesCompositions",
        default,
        deserialize_with = "deserialize_compositions",
        skip_serializing_if = "Option::is_none"
    )]
    pub compositions: Option<BTreeMap<String, ClassicComposition>>,
}

impl Deref for ClassicDocument {
    type Target = Map<String, Value>;
    fn deref(&self) -> &Self::Target {
        &self.fields
    }
}
impl DerefMut for ClassicDocument {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.fields
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassicComposition {
    pub source: Arc<HyperframesSource>,
    #[serde(flatten)]
    pub properties: Map<String, Value>,
}

fn deserialize_compositions<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, ClassicComposition>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    BTreeMap::deserialize(deserializer).map(Some)
}

impl ClassicComposition {
    fn typed(&self) -> Result<HyperframesComposition, ModelError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Properties {
            composition_id: String,
            width: u32,
            height: u32,
            fps: f64,
            duration_seconds: f64,
            #[serde(default)]
            runtime_manifest: Option<crate::HyperframesRuntimeManifest>,
        }
        let p: Properties = serde_json::from_value(Value::Object(self.properties.clone()))
            .map_err(|e| invalid(&format!("invalid composition: {e}")))?;
        Ok(HyperframesComposition {
            source: self.source.clone(),
            composition_id: p.composition_id,
            width: p.width,
            height: p.height,
            fps: p.fps,
            duration_seconds: p.duration_seconds,
            runtime_manifest: p.runtime_manifest,
        })
    }
}

impl From<HyperframesComposition> for ClassicComposition {
    fn from(value: HyperframesComposition) -> Self {
        let mut properties = serde_json::json!({"compositionId":value.composition_id,
            "width":value.width, "height":value.height, "fps":value.fps,
            "durationSeconds":value.duration_seconds})
        .as_object()
        .unwrap()
        .clone();
        if let Some(manifest) = value.runtime_manifest {
            properties.insert(
                "runtimeManifest".into(),
                serde_json::to_value(manifest).unwrap(),
            );
        }
        Self {
            source: value.source,
            properties,
        }
    }
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
        crate::operations::classic_settings::validate_settings(settings)
            .map_err(|e| invalid(&e))?;
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
        let mut import_ids = HashSet::new();
        for (id, composition) in &compositions {
            if id.trim().is_empty() {
                return Err(invalid("composition id must not be empty"));
            }
            composition.validate()?;
            if let Some(value) = self
                .document
                .compositions
                .as_ref()
                .and_then(|items| items.get(id))
                .and_then(|item| item.properties.get("importId"))
            {
                let import_id = value
                    .as_str()
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= 160
                            && value.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
                            })
                    })
                    .ok_or_else(|| invalid("invalid HyperFrames import id"))?;
                if !import_ids.insert(import_id) {
                    return Err(invalid("duplicate HyperFrames import id"));
                }
            }
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
            crate::operations::classic_takes::validate_scene(scene, &asset_ids).map_err(|e| invalid(&e))?;
            if !scene_ids.insert(string_at(scene, "id")?) {
                return Err(invalid("duplicate scene id"));
            }
            if scene.get("isMain").is_some_and(|value| !value.is_boolean()) {
                return Err(invalid("scene isMain must be a boolean"));
            }
            if let Some(bookmarks) = scene.get("bookmarks") {
                let bookmarks = bookmarks
                    .as_array()
                    .ok_or_else(|| invalid("bookmarks must be an array"))?;
                for bookmark in bookmarks {
                    let start = ticks(bookmark, "time")?;
                    for key in ["note", "color", "groupId"] {
                        if bookmark
                            .get(key)
                            .is_some_and(|value| !value.is_null() && !value.is_string())
                        {
                            return Err(invalid("bookmark text properties must be strings"));
                        }
                    }
                    if bookmark
                        .get("duration")
                        .is_some_and(|value| !value.is_null())
                    {
                        let duration = ticks(bookmark, "duration")?;
                        if start
                            .checked_add(duration)
                            .is_none_or(|end| end > MAX_SAFE_INTEGER)
                        {
                            return Err(invalid("bookmark end exceeds safe integer timing"));
                        }
                    }
                }
            }
            for track in tracks(scene)? {
                let track_id = string_at(track, "id")?;
                if !entity_ids.insert(track_id) {
                    return Err(invalid("duplicate track or element id"));
                }
                string_at(track, "type")?;
                if track["type"] == "parallax" {
                    if !scene.get("parallax").is_some_and(Value::is_object)
                        || !matches!(
                            track["direction"].as_str(),
                            Some("with-camera" | "against-camera")
                        )
                        || !track["speedPercent"].as_f64().is_some_and(|speed| {
                            speed.is_finite() && (0.0..=400.0).contains(&speed)
                        })
                        || !elements(track)?.is_empty()
                    {
                        return Err(invalid(
                            "parallax marker requires a canvas scene, direction, speed in 0..400 and no elements",
                        ));
                    }
                }
                for flag in ["muted", "hidden", "keepEmpty"] {
                    if track.get(flag).is_some_and(|value| !value.is_boolean()) {
                        return Err(invalid(&format!("track {flag} must be a boolean")));
                    }
                }
                for element in elements(track)? {
                    if !entity_ids.insert(string_at(element, "id")?) {
                        return Err(invalid("duplicate track or element id"));
                    }
                    string_at(element, "type")?;
                    crate::classic_effects::validate_effects(element)
                        .map_err(|e| invalid(&e.to_string()))?;
                    if element
                        .get("isSourceAudioEnabled")
                        .is_some_and(|value| !value.is_boolean())
                    {
                        return Err(invalid("isSourceAudioEnabled must be a boolean"));
                    }
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
                        let composition = &compositions[id];
                        if let Some(value) = element.get("hyperframesLayerEdits") {
                            let edits: crate::HyperframesLayerEdits =
                                serde_json::from_value(value.clone())
                                    .map_err(|error| invalid(&error.to_string()))?;
                            let manifest =
                                composition.runtime_manifest.as_ref().ok_or_else(|| {
                                    invalid("HyperFrames layer edits require a runtime manifest")
                                })?;
                            edits.prepare(&composition.source, manifest)?;
                        }
                        for (key, expected) in [
                            ("sourceWidth", composition.width),
                            ("sourceHeight", composition.height),
                        ] {
                            if let Some(value) = element["params"].get(key)
                                && value.as_f64() != Some(f64::from(expected))
                            {
                                return Err(invalid(
                                    "HyperFrames intrinsic dimensions must match its composition",
                                ));
                            }
                        }
                    } else if element.get("hyperframesLayerEdits").is_some() {
                        return Err(invalid(
                            "HyperFrames layer edits require a HyperFrames clip",
                        ));
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
        self.document
            .compositions
            .iter()
            .flat_map(|items| items.iter())
            .map(|(id, composition)| Ok((id.clone(), composition.typed()?)))
            .collect()
    }

    /// Whole-document host commits usually keep the same source. Reuse the
    /// previous immutable allocation instead of copying it into every undo entry.
    pub(crate) fn share_sources_from(&mut self, previous: &Self) {
        let Some(previous) = &previous.document.compositions else {
            return;
        };
        let Some(current) = &mut self.document.compositions else {
            return;
        };
        for (id, composition) in current {
            if let Some(old) = previous.get(id)
                && composition.source == old.source
            {
                composition.source = old.source.clone();
            }
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
