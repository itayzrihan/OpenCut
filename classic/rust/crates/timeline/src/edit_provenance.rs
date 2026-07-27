use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::hash::Hash;

use bridge::export;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::MediaTime;

pub const AI_EDIT_PROVENANCE_SCHEMA_VERSION: u32 = 1;
pub const MAX_AI_EDIT_OPERATIONS: usize = 512;
pub const MAX_AI_EDIT_REFS_PER_LAYER: usize = 128;
pub const MAX_AI_EDIT_ID_CHARS: usize = 160;
pub const MAX_AI_EDIT_OPERATION_TYPE_CHARS: usize = 80;
pub const MAX_AI_EDIT_TITLE_CHARS: usize = 160;
pub const MAX_AI_EDIT_SUMMARY_CHARS: usize = 1_000;
pub const MAX_AI_EDIT_LABEL_CHARS: usize = 200;
pub const MAX_AI_EDIT_REASON_CHARS: usize = 600;
pub const MAX_AI_EDIT_REF_CHARS: usize = 256;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditTargetRefs {
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub element_id: Option<String>,
    #[serde(default)]
    pub effect_id: Option<String>,
    #[serde(default)]
    pub transition_id: Option<String>,
    #[serde(default)]
    pub keyframe_id: Option<String>,
    #[serde(default)]
    pub property_path: Option<String>,
}

impl AiEditTargetRefs {
    fn is_empty(&self) -> bool {
        self.scene_id.is_none()
            && self.track_id.is_none()
            && self.element_id.is_none()
            && self.effect_id.is_none()
            && self.transition_id.is_none()
            && self.keyframe_id.is_none()
            && self.property_path.is_none()
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditOperationTiming {
    /// Timeline-relative start for a ranged edit.
    #[serde(default)]
    pub start_time: Option<MediaTime>,
    /// A non-positive duration is normalized to a point at `start_time`.
    #[serde(default)]
    pub duration: Option<MediaTime>,
    /// Timeline-relative point for cuts, keyframes, and other instantaneous edits.
    #[serde(default)]
    pub point_time: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiEditAnchor {
    Range {
        start_time: MediaTime,
        duration: MediaTime,
    },
    Point {
        time: MediaTime,
    },
    Project,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditOperationDescriptor {
    #[serde(default)]
    pub operation_id: Option<String>,
    pub operation_type: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub timing: Option<AiEditOperationTiming>,
    #[serde(default)]
    pub refs: AiEditTargetRefs,
    /// Overrides the operation-name inference when a caller has stronger
    /// before/after knowledge (for example, a retained split is not a tombstone).
    #[serde(default)]
    pub tombstone: Option<bool>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAiEditPlanRecordOptions {
    /// Supplying a host-generated id distinguishes two applications of an
    /// otherwise identical plan. When omitted, a deterministic content id is used.
    #[serde(default)]
    pub plan_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub applied_at: Option<String>,
    #[serde(default)]
    pub scene_id: Option<String>,
    /// Used for timeline operations whose descriptor has no more precise timing.
    #[serde(default)]
    pub default_range: Option<AiEditOperationTiming>,
    pub operations: Vec<AiEditOperationDescriptor>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditLayerRecord {
    pub id: String,
    pub operation_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub anchor: AiEditAnchor,
    pub refs: Vec<AiEditTargetRefs>,
    pub operation_ids: Vec<String>,
    pub operation_count: u32,
    pub tombstone: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditPlanRecord {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub layers: Vec<AiEditLayerRecord>,
    /// Count supplied by the caller, including descriptors beyond the safety cap.
    pub operation_count: u32,
    /// Descriptors represented by the explicit overflow activity layer.
    pub truncated_operation_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum LayerGroupKey {
    Keyframes {
        track_id: Option<String>,
        element_id: String,
        property_path: String,
        tombstone: bool,
    },
    Splits {
        track_id: Option<String>,
        element_id: String,
    },
    Individual(String),
}

#[derive(Clone, Debug)]
enum LayerFamily {
    Keyframes { property_path: String },
    Splits,
    Individual,
    Overflow,
}

#[derive(Clone, Debug)]
struct NormalizedOperation {
    operation_id: String,
    operation_type: String,
    label: String,
    has_explicit_label: bool,
    reason: Option<String>,
    anchor: AiEditAnchor,
    refs: AiEditTargetRefs,
    tombstone: bool,
}

#[derive(Clone, Debug)]
struct LayerAccumulator {
    operation_type: String,
    label: String,
    has_explicit_label: bool,
    reason: Option<String>,
    anchor: AiEditAnchor,
    refs: Vec<AiEditTargetRefs>,
    operation_ids: Vec<String>,
    tombstone: bool,
    family: LayerFamily,
    operation_count: u32,
}

/// Build compact, deterministic provenance for one reviewed AI edit plan.
///
/// This reducer is deliberately independent from render tracks. UI shells can
/// display the returned layers in a virtual lane without adding scene effects,
/// changing duration, or coupling provenance to a particular UI framework.
#[export]
pub fn build_ai_edit_plan_record(options: BuildAiEditPlanRecordOptions) -> AiEditPlanRecord {
    let original_operation_count = options.operations.len();
    let generated_plan_id = stable_id("ai-plan", &options);
    let plan_id = clean_optional_string(options.plan_id.as_deref(), MAX_AI_EDIT_ID_CHARS)
        .unwrap_or(generated_plan_id);
    let title = clean_required_string(&options.title, MAX_AI_EDIT_TITLE_CHARS, "AI edit plan");
    let summary = clean_string(
        options.summary.as_deref().unwrap_or_default(),
        MAX_AI_EDIT_SUMMARY_CHARS,
    );
    let applied_at = clean_optional_string(options.applied_at.as_deref(), MAX_AI_EDIT_ID_CHARS);
    let scene_id = clean_optional_string(options.scene_id.as_deref(), MAX_AI_EDIT_REF_CHARS);
    let default_anchor = options.default_range.and_then(anchor_from_timing);

    let mut seen_operation_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(original_operation_count.min(MAX_AI_EDIT_OPERATIONS));
    let mut overflow_fingerprint = Sha256::new();

    for (index, descriptor) in options.operations.into_iter().enumerate() {
        if index >= MAX_AI_EDIT_OPERATIONS {
            hash_serializable(&mut overflow_fingerprint, &descriptor);
            continue;
        }
        normalized.push(normalize_operation(
            descriptor,
            index,
            &plan_id,
            default_anchor,
            &mut seen_operation_ids,
        ));
    }

    let mut accumulators = Vec::<LayerAccumulator>::new();
    let mut group_indexes = HashMap::<LayerGroupKey, usize>::new();
    for operation in normalized {
        let (key, family) = group_key_and_family(&operation);
        if let Some(existing_index) = group_indexes.get(&key).copied() {
            merge_operation(&mut accumulators[existing_index], operation);
            continue;
        }

        let accumulator = LayerAccumulator {
            operation_type: operation.operation_type,
            label: operation.label,
            has_explicit_label: operation.has_explicit_label,
            reason: operation.reason,
            anchor: operation.anchor,
            refs: (!operation.refs.is_empty())
                .then_some(operation.refs)
                .into_iter()
                .collect(),
            operation_ids: vec![operation.operation_id],
            tombstone: operation.tombstone,
            family,
            operation_count: 1,
        };
        group_indexes.insert(key, accumulators.len());
        accumulators.push(accumulator);
    }

    let truncated_operation_count = original_operation_count.saturating_sub(MAX_AI_EDIT_OPERATIONS);
    if truncated_operation_count > 0 {
        let overflow_digest = overflow_fingerprint.finalize();
        let overflow_token = digest_hex_prefix(&overflow_digest, 16);
        accumulators.push(LayerAccumulator {
            operation_type: "provenance_overflow".to_owned(),
            label: format!("{truncated_operation_count} additional AI operations"),
            has_explicit_label: true,
            reason: Some(
                "Additional operation descriptors exceeded the provenance safety bound".to_owned(),
            ),
            anchor: AiEditAnchor::Project,
            refs: Vec::new(),
            operation_ids: Vec::new(),
            tombstone: false,
            family: LayerFamily::Overflow,
            operation_count: saturating_u32(truncated_operation_count),
        });
        // The digest participates in the overflow layer id without exposing or
        // retaining unbounded operation payloads.
        if let Some(last) = accumulators.last_mut() {
            last.operation_ids
                .push(format!("overflow:{overflow_token}"));
        }
    }

    let layers = accumulators
        .into_iter()
        .map(|accumulator| finalize_layer(&plan_id, accumulator))
        .collect();

    AiEditPlanRecord {
        schema_version: AI_EDIT_PROVENANCE_SCHEMA_VERSION,
        id: plan_id,
        title,
        summary,
        applied_at,
        scene_id,
        layers,
        operation_count: saturating_u32(original_operation_count),
        truncated_operation_count: saturating_u32(truncated_operation_count),
    }
}

fn normalize_operation(
    descriptor: AiEditOperationDescriptor,
    index: usize,
    plan_id: &str,
    default_anchor: Option<AiEditAnchor>,
    seen_operation_ids: &mut HashSet<String>,
) -> NormalizedOperation {
    let operation_type = clean_required_string(
        &descriptor.operation_type,
        MAX_AI_EDIT_OPERATION_TYPE_CHARS,
        "unknown",
    );
    let refs = normalize_refs(descriptor.refs);
    let tombstone = descriptor
        .tombstone
        .unwrap_or_else(|| is_tombstone_operation(&operation_type));
    let anchor = if is_project_operation(&operation_type) {
        AiEditAnchor::Project
    } else {
        descriptor
            .timing
            .and_then(anchor_from_timing)
            .or(default_anchor)
            .unwrap_or(AiEditAnchor::Project)
    };
    let has_explicit_label = descriptor
        .label
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let label = descriptor
        .label
        .as_deref()
        .map(|value| clean_string(value, MAX_AI_EDIT_LABEL_CHARS))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_operation_label(&operation_type, &refs));
    let reason = clean_optional_string(descriptor.reason.as_deref(), MAX_AI_EDIT_REASON_CHARS);

    let operation_id_seed = (
        plan_id,
        index,
        &operation_type,
        &label,
        &reason,
        &anchor,
        &refs,
        tombstone,
    );
    let requested_operation_id =
        clean_optional_string(descriptor.operation_id.as_deref(), MAX_AI_EDIT_ID_CHARS)
            .unwrap_or_else(|| stable_id("ai-op", &operation_id_seed));
    let operation_id = make_unique_operation_id(
        requested_operation_id,
        &operation_id_seed,
        seen_operation_ids,
    );

    NormalizedOperation {
        operation_id,
        operation_type,
        label,
        has_explicit_label,
        reason,
        anchor,
        refs,
        tombstone,
    }
}

fn group_key_and_family(operation: &NormalizedOperation) -> (LayerGroupKey, LayerFamily) {
    if is_keyframe_operation(&operation.operation_type)
        && let (Some(element_id), Some(property_path)) = (
            operation.refs.element_id.clone(),
            operation.refs.property_path.clone(),
        )
    {
        return (
            LayerGroupKey::Keyframes {
                track_id: operation.refs.track_id.clone(),
                element_id,
                property_path: property_path.clone(),
                tombstone: operation.tombstone,
            },
            LayerFamily::Keyframes { property_path },
        );
    }

    if operation.operation_type == "split_element"
        && let Some(element_id) = operation.refs.element_id.clone()
    {
        return (
            LayerGroupKey::Splits {
                track_id: operation.refs.track_id.clone(),
                element_id,
            },
            LayerFamily::Splits,
        );
    }

    (
        LayerGroupKey::Individual(operation.operation_id.clone()),
        LayerFamily::Individual,
    )
}

fn merge_operation(accumulator: &mut LayerAccumulator, operation: NormalizedOperation) {
    accumulator.anchor = merge_anchors(accumulator.anchor, operation.anchor);
    accumulator.tombstone |= operation.tombstone;
    accumulator.operation_ids.push(operation.operation_id);
    accumulator.operation_count = accumulator.operation_count.saturating_add(1);
    accumulator.reason = merge_reasons(accumulator.reason.take(), operation.reason);
    if !accumulator.has_explicit_label && operation.has_explicit_label {
        accumulator.label = operation.label;
        accumulator.has_explicit_label = true;
    }

    if !operation.refs.is_empty()
        && accumulator.refs.len() < MAX_AI_EDIT_REFS_PER_LAYER
        && !accumulator.refs.contains(&operation.refs)
    {
        accumulator.refs.push(operation.refs);
    }
}

fn finalize_layer(plan_id: &str, mut accumulator: LayerAccumulator) -> AiEditLayerRecord {
    let count = accumulator.operation_count;
    accumulator.label = match &accumulator.family {
        LayerFamily::Keyframes { property_path } if count > 1 => {
            if accumulator.has_explicit_label {
                format!("{} · {count} keyframes", accumulator.label)
            } else if accumulator.tombstone {
                format!("Remove {property_path} keyframes · {count}")
            } else {
                format!("Animate {property_path} · {count} keyframes")
            }
        }
        LayerFamily::Splits if count > 1 => {
            if accumulator.has_explicit_label {
                format!("{} · {count} cuts", accumulator.label)
            } else {
                format!("Rhythmic cuts · {count}")
            }
        }
        LayerFamily::Overflow => accumulator.label,
        LayerFamily::Keyframes { .. } | LayerFamily::Splits | LayerFamily::Individual => {
            accumulator.label
        }
    };
    accumulator.label = clean_string(&accumulator.label, MAX_AI_EDIT_LABEL_CHARS);

    let layer_id_seed = (
        plan_id,
        &accumulator.operation_type,
        &accumulator.operation_ids,
        &accumulator.anchor,
        &accumulator.refs,
        accumulator.tombstone,
    );

    AiEditLayerRecord {
        id: stable_id("ai-layer", &layer_id_seed),
        operation_type: accumulator.operation_type,
        label: accumulator.label,
        reason: accumulator.reason,
        anchor: accumulator.anchor,
        refs: accumulator.refs,
        operation_ids: accumulator.operation_ids,
        operation_count: accumulator.operation_count,
        tombstone: accumulator.tombstone,
    }
}

fn anchor_from_timing(timing: AiEditOperationTiming) -> Option<AiEditAnchor> {
    if let Some(point_time) = timing.point_time {
        return Some(AiEditAnchor::Point {
            time: non_negative_time(point_time),
        });
    }

    let start_time = non_negative_time(timing.start_time?);
    let duration = non_negative_time(timing.duration.unwrap_or(MediaTime::ZERO));
    if duration <= MediaTime::ZERO {
        return Some(AiEditAnchor::Point { time: start_time });
    }
    Some(AiEditAnchor::Range {
        start_time,
        duration,
    })
}

fn merge_anchors(left: AiEditAnchor, right: AiEditAnchor) -> AiEditAnchor {
    match (anchor_bounds(left), anchor_bounds(right)) {
        (None, None) => AiEditAnchor::Project,
        (Some((start, end)), None) | (None, Some((start, end))) => anchor_from_bounds(start, end),
        (Some((left_start, left_end)), Some((right_start, right_end))) => {
            anchor_from_bounds(left_start.min(right_start), left_end.max(right_end))
        }
    }
}

fn anchor_bounds(anchor: AiEditAnchor) -> Option<(MediaTime, MediaTime)> {
    match anchor {
        AiEditAnchor::Range {
            start_time,
            duration,
        } => Some((
            start_time,
            MediaTime::from_ticks(start_time.as_ticks().saturating_add(duration.as_ticks())),
        )),
        AiEditAnchor::Point { time } => Some((time, time)),
        AiEditAnchor::Project => None,
    }
}

fn anchor_from_bounds(start: MediaTime, end: MediaTime) -> AiEditAnchor {
    if end <= start {
        AiEditAnchor::Point { time: start }
    } else {
        AiEditAnchor::Range {
            start_time: start,
            duration: MediaTime::from_ticks(end.as_ticks().saturating_sub(start.as_ticks())),
        }
    }
}

fn normalize_refs(refs: AiEditTargetRefs) -> AiEditTargetRefs {
    AiEditTargetRefs {
        scene_id: clean_optional_string(refs.scene_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        track_id: clean_optional_string(refs.track_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        element_id: clean_optional_string(refs.element_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        effect_id: clean_optional_string(refs.effect_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        transition_id: clean_optional_string(refs.transition_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        keyframe_id: clean_optional_string(refs.keyframe_id.as_deref(), MAX_AI_EDIT_REF_CHARS),
        property_path: clean_optional_string(refs.property_path.as_deref(), MAX_AI_EDIT_REF_CHARS),
    }
}

fn make_unique_operation_id<T: Serialize>(
    requested: String,
    seed: &T,
    seen: &mut HashSet<String>,
) -> String {
    if seen.insert(requested.clone()) {
        return requested;
    }

    let mut attempt = 1_u32;
    loop {
        let candidate = stable_id("ai-op", &(requested.as_str(), seed, attempt));
        if seen.insert(candidate.clone()) {
            return candidate;
        }
        attempt = attempt.saturating_add(1);
    }
}

fn merge_reasons(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (None, None) => None,
        (Some(reason), None) | (None, Some(reason)) => Some(reason),
        (Some(left), Some(right)) if left == right => Some(left),
        (Some(left), Some(right)) => Some(clean_string(
            &format!("{left}; {right}"),
            MAX_AI_EDIT_REASON_CHARS,
        )),
    }
}

fn is_keyframe_operation(operation_type: &str) -> bool {
    matches!(operation_type, "upsert_keyframe" | "remove_keyframe")
}

fn is_project_operation(operation_type: &str) -> bool {
    matches!(
        operation_type,
        "create_scene"
            | "rename_scene"
            | "delete_scene"
            | "set_project_settings"
            | "start_export_task"
            | "start_transcription_task"
    )
}

fn is_tombstone_operation(operation_type: &str) -> bool {
    matches!(
        operation_type,
        "delete_element"
            | "remove_clip_effect"
            | "remove_keyframe"
            | "remove_track"
            | "remove_bookmark"
            | "delete_scene"
    )
}

fn default_operation_label(operation_type: &str, refs: &AiEditTargetRefs) -> String {
    if is_keyframe_operation(operation_type)
        && let Some(property_path) = refs.property_path.as_deref()
    {
        return if operation_type == "remove_keyframe" {
            format!("Remove {property_path} keyframe")
        } else {
            format!("Animate {property_path}")
        };
    }
    if operation_type == "split_element" {
        return "Cut element".to_owned();
    }

    let words = operation_type.replace(['_', '-'], " ");
    let mut characters = words.chars();
    match characters.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
        None => "Unknown AI activity".to_owned(),
    }
}

fn clean_required_string(value: &str, max_chars: usize, fallback: &str) -> String {
    let cleaned = clean_string(value, max_chars);
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn clean_optional_string(value: Option<&str>, max_chars: usize) -> Option<String> {
    value
        .map(|value| clean_string(value, max_chars))
        .filter(|value| !value.is_empty())
}

fn clean_string(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn non_negative_time(value: MediaTime) -> MediaTime {
    value.max(MediaTime::ZERO)
}

fn stable_id<T: Serialize>(prefix: &str, value: &T) -> String {
    let mut hasher = Sha256::new();
    hash_serializable(&mut hasher, value);
    let digest = hasher.finalize();
    format!("{prefix}-{}", digest_hex_prefix(&digest, 16))
}

fn hash_serializable<T: Serialize>(hasher: &mut Sha256, value: &T) {
    match serde_json::to_vec(value) {
        Ok(bytes) => hasher.update(bytes),
        Err(_) => hasher.update(b"serialization-error"),
    }
}

fn digest_hex_prefix(digest: &[u8], byte_count: usize) -> String {
    let mut output = String::with_capacity(byte_count.saturating_mul(2));
    for byte in digest.iter().take(byte_count) {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(ticks: i64) -> MediaTime {
        MediaTime::from_ticks(ticks)
    }

    fn operation(id: &str, operation_type: &str) -> AiEditOperationDescriptor {
        AiEditOperationDescriptor {
            operation_id: Some(id.to_owned()),
            operation_type: operation_type.to_owned(),
            label: None,
            reason: None,
            timing: None,
            refs: AiEditTargetRefs::default(),
            tombstone: None,
        }
    }

    fn build(operations: Vec<AiEditOperationDescriptor>) -> AiEditPlanRecord {
        build_ai_edit_plan_record(BuildAiEditPlanRecordOptions {
            plan_id: Some("plan-1".to_owned()),
            title: "Epic edit".to_owned(),
            summary: Some("A compact provenance test".to_owned()),
            applied_at: Some("2026-07-13T10:00:00.000Z".to_owned()),
            scene_id: Some("scene-1".to_owned()),
            default_range: None,
            operations,
        })
    }

    #[test]
    fn coalesces_keyframes_by_target_and_property_while_preserving_operation_ids() {
        let mut first = operation("kf-1", "upsert_keyframe");
        first.timing = Some(AiEditOperationTiming {
            point_time: Some(time(100)),
            ..AiEditOperationTiming::default()
        });
        first.refs = AiEditTargetRefs {
            track_id: Some("video-track".to_owned()),
            element_id: Some("clip-1".to_owned()),
            keyframe_id: Some("key-1".to_owned()),
            property_path: Some("transform.scaleX".to_owned()),
            ..AiEditTargetRefs::default()
        };
        let mut second = first.clone();
        second.operation_id = Some("kf-2".to_owned());
        second.timing = Some(AiEditOperationTiming {
            point_time: Some(time(300)),
            ..AiEditOperationTiming::default()
        });
        second.refs.keyframe_id = Some("key-2".to_owned());
        let mut other_property = first.clone();
        other_property.operation_id = Some("kf-3".to_owned());
        other_property.refs.property_path = Some("opacity".to_owned());

        let record = build(vec![first, second, other_property]);

        assert_eq!(record.layers.len(), 2);
        let scale_layer = &record.layers[0];
        assert_eq!(scale_layer.operation_ids, vec!["kf-1", "kf-2"]);
        assert_eq!(scale_layer.operation_count, 2);
        assert_eq!(scale_layer.refs.len(), 2);
        assert_eq!(
            scale_layer.anchor,
            AiEditAnchor::Range {
                start_time: time(100),
                duration: time(200),
            }
        );
        assert_eq!(scale_layer.label, "Animate transform.scaleX · 2 keyframes");
        assert_eq!(record.layers[1].operation_ids, vec!["kf-3"]);
    }

    #[test]
    fn coalesces_repeated_splits_by_target_but_not_across_targets() {
        let mut first = operation("split-1", "split_element");
        first.timing = Some(AiEditOperationTiming {
            point_time: Some(time(200)),
            ..AiEditOperationTiming::default()
        });
        first.refs = AiEditTargetRefs {
            track_id: Some("main".to_owned()),
            element_id: Some("clip-1".to_owned()),
            ..AiEditTargetRefs::default()
        };
        let mut second = first.clone();
        second.operation_id = Some("split-2".to_owned());
        second.timing = Some(AiEditOperationTiming {
            point_time: Some(time(500)),
            ..AiEditOperationTiming::default()
        });
        let mut other_target = first.clone();
        other_target.operation_id = Some("split-3".to_owned());
        other_target.refs.element_id = Some("clip-2".to_owned());

        let record = build(vec![first, second, other_target]);

        assert_eq!(record.layers.len(), 2);
        assert_eq!(record.layers[0].operation_ids, vec!["split-1", "split-2"]);
        assert_eq!(record.layers[0].label, "Rhythmic cuts · 2");
        assert_eq!(
            record.layers[0].anchor,
            AiEditAnchor::Range {
                start_time: time(200),
                duration: time(300),
            }
        );
        assert_eq!(record.layers[1].operation_ids, vec!["split-3"]);
    }

    #[test]
    fn retains_deleted_target_ranges_as_tombstone_layers() {
        let mut deleted = operation("delete-1", "delete_element");
        deleted.timing = Some(AiEditOperationTiming {
            start_time: Some(time(1_000)),
            duration: Some(time(2_000)),
            point_time: None,
        });
        deleted.refs.element_id = Some("removed-clip".to_owned());

        let record = build(vec![deleted]);

        assert_eq!(record.layers.len(), 1);
        assert!(record.layers[0].tombstone);
        assert_eq!(
            record.layers[0].anchor,
            AiEditAnchor::Range {
                start_time: time(1_000),
                duration: time(2_000),
            }
        );
        assert_eq!(
            record.layers[0].refs[0].element_id.as_deref(),
            Some("removed-clip")
        );
    }

    #[test]
    fn maps_project_and_unknown_operations_to_explicit_activity_layers() {
        let project = operation("project-1", "set_project_settings");
        let mut unknown_range = operation("future-1", "future_visual_magic");
        unknown_range.timing = Some(AiEditOperationTiming {
            start_time: Some(time(50)),
            duration: Some(time(100)),
            point_time: None,
        });
        let unknown_project = operation("future-2", "future_project_magic");

        let record = build(vec![project, unknown_range, unknown_project]);

        assert_eq!(record.layers.len(), 3);
        assert_eq!(record.operation_count, 3);
        assert!(matches!(record.layers[0].anchor, AiEditAnchor::Project));
        assert!(matches!(
            record.layers[1].anchor,
            AiEditAnchor::Range { .. }
        ));
        assert!(matches!(record.layers[2].anchor, AiEditAnchor::Project));
        assert_eq!(
            record
                .layers
                .iter()
                .flat_map(|layer| layer.operation_ids.iter().map(String::as_str))
                .collect::<Vec<_>>(),
            vec!["project-1", "future-1", "future-2"]
        );
    }

    #[test]
    fn unknown_operations_use_the_default_range_without_reclassifying_project_ops() {
        let record = build_ai_edit_plan_record(BuildAiEditPlanRecordOptions {
            plan_id: Some("plan-range".to_owned()),
            title: "Range".to_owned(),
            summary: None,
            applied_at: None,
            scene_id: None,
            default_range: Some(AiEditOperationTiming {
                start_time: Some(time(100)),
                duration: Some(time(500)),
                point_time: None,
            }),
            operations: vec![
                operation("future", "future_edit"),
                operation("settings", "set_project_settings"),
            ],
        });

        assert!(matches!(
            record.layers[0].anchor,
            AiEditAnchor::Range { .. }
        ));
        assert!(matches!(record.layers[1].anchor, AiEditAnchor::Project));
    }

    #[test]
    fn ids_are_stable_and_all_persisted_fields_are_bounded() {
        let mut oversized = operation(&"i".repeat(1_000), &"o".repeat(500));
        oversized.label = Some("l".repeat(500));
        oversized.reason = Some("r".repeat(2_000));
        oversized.refs.element_id = Some("e".repeat(1_000));
        oversized.timing = Some(AiEditOperationTiming {
            point_time: Some(time(-100)),
            ..AiEditOperationTiming::default()
        });
        let options = BuildAiEditPlanRecordOptions {
            plan_id: None,
            title: "t".repeat(1_000),
            summary: Some("s".repeat(2_000)),
            applied_at: None,
            scene_id: Some("x".repeat(1_000)),
            default_range: None,
            operations: vec![oversized],
        };

        let first = build_ai_edit_plan_record(options.clone());
        let second = build_ai_edit_plan_record(options);

        assert_eq!(first, second);
        assert!(first.id.starts_with("ai-plan-"));
        assert_eq!(first.title.chars().count(), MAX_AI_EDIT_TITLE_CHARS);
        assert_eq!(first.summary.chars().count(), MAX_AI_EDIT_SUMMARY_CHARS);
        assert_eq!(
            first.scene_id.as_deref().unwrap().chars().count(),
            MAX_AI_EDIT_REF_CHARS
        );
        assert_eq!(
            first.layers[0].operation_type.chars().count(),
            MAX_AI_EDIT_OPERATION_TYPE_CHARS
        );
        assert_eq!(
            first.layers[0].label.chars().count(),
            MAX_AI_EDIT_LABEL_CHARS
        );
        assert_eq!(
            first.layers[0].reason.as_deref().unwrap().chars().count(),
            MAX_AI_EDIT_REASON_CHARS
        );
        assert_eq!(
            first.layers[0].refs[0]
                .element_id
                .as_deref()
                .unwrap()
                .chars()
                .count(),
            MAX_AI_EDIT_REF_CHARS
        );
        assert_eq!(
            first.layers[0].anchor,
            AiEditAnchor::Point {
                time: MediaTime::ZERO
            }
        );
    }

    #[test]
    fn excessive_descriptors_are_represented_by_one_bounded_overflow_activity() {
        let operations = (0..MAX_AI_EDIT_OPERATIONS + 7)
            .map(|index| operation(&format!("op-{index}"), "future_activity"))
            .collect();

        let record = build(operations);

        assert_eq!(record.operation_count, (MAX_AI_EDIT_OPERATIONS + 7) as u32);
        assert_eq!(record.truncated_operation_count, 7);
        assert_eq!(record.layers.len(), MAX_AI_EDIT_OPERATIONS + 1);
        let overflow = record.layers.last().unwrap();
        assert_eq!(overflow.operation_type, "provenance_overflow");
        assert_eq!(overflow.operation_count, 7);
        assert!(matches!(overflow.anchor, AiEditAnchor::Project));
        assert_eq!(overflow.operation_ids.len(), 1);
        assert!(overflow.operation_ids[0].starts_with("overflow:"));
    }

    #[test]
    fn anchors_serialize_with_wasm_facing_camel_case_fields() {
        let value = serde_json::to_value(AiEditAnchor::Range {
            start_time: time(10),
            duration: time(20),
        })
        .unwrap();

        assert_eq!(value["kind"], "range");
        assert_eq!(value["startTime"], 10);
        assert_eq!(value["duration"], 20);
        assert!(value.get("start_time").is_none());
    }

    #[test]
    fn coalesced_ranges_saturate_instead_of_overflowing() {
        let mut first = operation("kf-max", "upsert_keyframe");
        first.refs.element_id = Some("clip".to_owned());
        first.refs.property_path = Some("opacity".to_owned());
        first.timing = Some(AiEditOperationTiming {
            start_time: Some(time(i64::MAX - 5)),
            duration: Some(time(100)),
            point_time: None,
        });
        let mut second = first.clone();
        second.operation_id = Some("kf-zero".to_owned());
        second.timing = Some(AiEditOperationTiming {
            point_time: Some(MediaTime::ZERO),
            ..AiEditOperationTiming::default()
        });

        let record = build(vec![first, second]);

        assert_eq!(
            record.layers[0].anchor,
            AiEditAnchor::Range {
                start_time: MediaTime::ZERO,
                duration: time(i64::MAX),
            }
        );
    }
}
