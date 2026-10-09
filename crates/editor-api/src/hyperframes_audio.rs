//! Bounded, derived input to the pinned HyperFrames audio renderer.
//! This is not a second project model: original source remains authoritative.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{HyperframesLayerKind, HyperframesRuntimeManifest, HyperframesSource, ModelError};

/// The official layer inventory clips at the root but does not always clip at
/// nested hosts. Reject unsupported overhang before seeking a probe page.
/// Call only after validating the manifest's parent graph and source binding.
pub(crate) fn validate_hyperframes_audio_windows(
    manifest: &HyperframesRuntimeManifest,
) -> Result<(), ModelError> {
    let layers: BTreeMap<_, _> = manifest
        .layers
        .iter()
        .map(|layer| (&layer.key, layer))
        .collect();
    for layer in &manifest.layers {
        let Some(media) = &layer.media else { continue };
        if media.muted
            || media.attributes.contains_key("data-hidden")
            || (layer.kind == HyperframesLayerKind::Video
                && media
                    .attributes
                    .get("data-has-audio")
                    .is_some_and(|value| value == "false"))
        {
            continue;
        }
        let mut key = layer.parent_key.as_ref();
        while let Some(parent_key) = key {
            let Some(parent) = layers.get(parent_key) else {
                break;
            };
            if parent.kind == HyperframesLayerKind::Composition
                && (layer.start_seconds < parent.start_seconds - 1e-6
                    || layer.start_seconds + layer.duration_seconds
                        > parent.start_seconds + parent.duration_seconds + 1e-6)
            {
                return invalid("HyperFrames audio extends outside a nested composition window");
            }
            key = parent.parent_key.as_ref();
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesAudioPlan {
    pub source_fingerprint: String,
    pub runtime_version: String,
    pub duration_seconds: f64,
    pub elements: Vec<HyperframesAudioElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesAudioElement {
    pub id: String,
    /// Registered package resource, never a filesystem path or remote URL.
    pub src: String,
    pub start: f64,
    pub end: f64,
    pub media_start: f64,
    pub playback_rate: HyperframesAudioRate,
    pub layer: i32,
    pub volume: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub looping: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub volume_keyframes: Vec<HyperframesVolumeKeyframe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fx_chain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_fx_chain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_automation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_volume: Option<f64>,
    #[serde(rename = "type")]
    pub kind: HyperframesAudioKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HyperframesAudioKind {
    Audio,
    Video,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum HyperframesAudioRate {
    Constant(f64),
    Lane(HyperframesRateLane),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HyperframesRateLane {
    pub target: String,
    pub points: Vec<HyperframesRatePoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesRatePoint {
    pub t: f64,
    pub v: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via_y: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HyperframesVolumeKeyframe {
    pub time: f64,
    pub volume: f64,
}

impl HyperframesAudioPlan {
    /// Validate before any filesystem or mixer work and replace author-controlled
    /// IDs used by the engine as temporary filenames with safe ordinal IDs.
    pub fn prepare(mut self, source: &HyperframesSource) -> Result<Self, ModelError> {
        source.validate()?;
        if self.source_fingerprint != source.fingerprint() || self.runtime_version != "0.8.115" {
            return invalid("audio plan source fingerprint or runtime version does not match");
        }
        if !positive(self.duration_seconds, 1800.0)
            || self.elements.len() > 32
            || serde_json::to_vec(&self).map_or(true, |bytes| bytes.len() > 4 * 1024 * 1024)
        {
            return invalid("audio plan exceeds 30 minutes, 32 tracks or 4 MiB");
        }
        let mut ids = BTreeSet::new();
        let mut groups = BTreeMap::new();
        let mut total_duration = 0.0;
        let mut keyframes = 0;
        for element in &self.elements {
            if element.id.is_empty() || element.id.len() > 1024 || !ids.insert(&element.id) {
                return invalid("audio occurrence IDs must be bounded and unique");
            }
            if !source.resource_asset_ids.contains_key(&element.src) {
                return invalid("audio source must be a registered package resource");
            }
            if !nonnegative(element.start, self.duration_seconds)
                || !positive(element.end, self.duration_seconds)
                || element.end <= element.start
                || !nonnegative(element.media_start, 86_400.0)
                || !nonnegative(element.volume, 4.0)
                || element
                    .group_volume
                    .is_some_and(|value| !nonnegative(value, 4.0))
                || [element.fade_in, element.fade_out]
                    .into_iter()
                    .flatten()
                    .any(|value| !nonnegative(value, self.duration_seconds))
            {
                return invalid("audio timing, fades or gain are invalid");
            }
            total_duration += element.end - element.start;
            if total_duration > 3600.0 {
                return invalid("audio tracks exceed one hour of combined processing");
            }
            match &element.playback_rate {
                HyperframesAudioRate::Constant(value) if positive(*value, 100.0) => {}
                HyperframesAudioRate::Lane(lane)
                    if lane.target == "rate"
                        && !lane.points.is_empty()
                        && lane.points.len() <= 512 =>
                {
                    let mut previous = -1.0;
                    for point in &lane.points {
                        if !nonnegative(point.t, 86_400.0)
                            || point.t <= previous
                            || !positive(point.v, 100.0)
                            || [point.curve, point.via_x, point.via_y]
                                .into_iter()
                                .flatten()
                                .any(|value| !value.is_finite() || value.abs() > 86_400.0)
                        {
                            return invalid("audio rate lane is invalid");
                        }
                        previous = point.t;
                    }
                }
                _ => return invalid("audio playback rate is invalid"),
            }
            keyframes += element.volume_keyframes.len();
            if keyframes > 100_000 {
                return invalid("audio volume automation exceeds 100000 samples");
            }
            let mut previous = -1.0;
            for frame in &element.volume_keyframes {
                if !nonnegative(frame.time, self.duration_seconds)
                    || frame.time <= previous
                    || !nonnegative(frame.volume, 4.0)
                {
                    return invalid("audio volume envelope is invalid");
                }
                previous = frame.time;
            }
            for json in [
                &element.fx_chain,
                &element.automation,
                &element.group_fx_chain,
                &element.group_automation,
            ]
            .into_iter()
            .flatten()
            {
                if json.len() > 65_536 || serde_json::from_str::<serde_json::Value>(json).is_err() {
                    return invalid("audio effects and automation require bounded JSON");
                }
            }
            if let Some(group) = &element.group_id {
                if group.is_empty() || group.len() > 1024 {
                    return invalid("audio group ID is invalid");
                }
                let settings = (
                    &element.group_fx_chain,
                    &element.group_automation,
                    element.group_volume,
                );
                if groups
                    .insert(group, settings)
                    .is_some_and(|previous| previous != settings)
                {
                    return invalid("audio group settings must agree across all members");
                }
            } else if element.group_fx_chain.is_some()
                || element.group_automation.is_some()
                || element.group_volume.is_some()
            {
                return invalid("audio group settings require a group ID");
            }
        }
        let mut group_ids = BTreeMap::<String, String>::new();
        for (index, element) in self.elements.iter_mut().enumerate() {
            element.id = format!("track-{index}");
            if let Some(group) = &mut element.group_id {
                let next_id = format!("group-{}", group_ids.len());
                *group = group_ids.entry(group.clone()).or_insert(next_id).clone();
            }
        }
        Ok(self)
    }
}

fn nonnegative(value: f64, limit: f64) -> bool {
    value.is_finite() && value >= 0.0 && value <= limit
}

fn positive(value: f64, limit: f64) -> bool {
    nonnegative(value, limit) && value > 0.0
}

fn invalid<T>(message: &str) -> Result<T, ModelError> {
    Err(ModelError::Invalid(message.into()))
}
