//! Existing Classic animation editing; paths come from the document, not an agent allowlist.
use super::*;
use serde_json::json;

mod clipboard;
mod remove;
mod sample;
mod split;
pub(super) use split::animations as split_animations;
mod upsert;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Handle {
    dt: i64,
    dv: f64,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Segment {
    Step,
    Linear,
    Bezier,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Tangent {
    Auto,
    Aligned,
    Broken,
    Flat,
}

fn present_handle<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<Handle>>, D::Error> {
    Option::<Handle>::deserialize(d).map(Some)
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurvePatch {
    /// Omit to retain; null clears the handle.
    #[serde(
        default,
        deserialize_with = "present_handle",
        skip_serializing_if = "Option::is_none"
    )]
    left_handle: Option<Option<Handle>>,
    #[serde(
        default,
        deserialize_with = "present_handle",
        skip_serializing_if = "Option::is_none"
    )]
    right_handle: Option<Option<Handle>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segment_to_next: Option<Segment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_mode: Option<Tangent>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    /// Local integer ticks, clamped to the target clip duration.
    Retime { time: i64 },
    Curve {
        #[serde(rename = "componentKey")]
        component_key: String,
        patch: CurvePatch,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    track_id: String,
    element_id: String,
    property_path: String,
    keyframe_id: String,
    change: Change,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    edits: Vec<Edit>,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

pub(super) fn register_classic_keyframes(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    upsert::register_upsert(registry, state.clone(), events.clone(), catalog.clone())?;
    remove::register_remove(registry, state.clone(), events.clone(), catalog.clone())?;
    clipboard::register_clipboard(registry, state.clone(), events.clone(), catalog)?;
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.keyframes.edit",
        "Edit Classic keyframe timing and curves",
        "Retime existing keys or edit scalar Bezier handles, outgoing segment and tangent mode in the real Classic document. Read exact track/element/propertyPath/keyframe IDs from app.state.read at /project/classic/document/scenes. Paths are literal animation-map keys (including effect/graphic/custom paths), not JSON pointers. A leaf channel has keys; composites map component names to channels. Retime updates matching key IDs across all components, clamps local integer ticks to [0, clip duration], keeps equal-time keys and normalizes adjacent handles. Curve targets one scalar component (value for a leaf); omitted handles stay, null clears, dt is integer ticks relative to the key and dv is value delta. Discrete string/boolean channels can be retimed but not given curves. Up to 1000 edits apply sequentially and atomically as one undo step, with explicit project/scene/revision, dry run, cancellation and exact retries. Missing keys, invalid channels or any failed edit reject the entire batch. Preserves unrelated paths and unknown fields. This capability does not create/delete keys or change key values.",
        "animation",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "keyframe",
            "animation",
            "retime",
            "curve",
            "bezier",
            "tangent",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if input.edits.is_empty() || input.edits.len() > 1000 {
                    return Err(invalid("provide between 1 and 1000 keyframe edits"));
                }
                let result = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit keyframe timing and curves",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "keyframe target project is not active".into(),
                            ));
                        }
                        let classic = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Classic project required"))?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .and_then(|scenes| {
                                scenes.iter_mut().find(|s| s["id"] == input.scene_id)
                            })
                            .ok_or_else(|| invalid("keyframe target scene not found"))?;
                        let mut changed = vec![input.project_id.clone(), input.scene_id.clone()];
                        for edit in &input.edits {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed("operation cancelled".into()));
                            }
                            let track = scene["tracks"]
                                .as_object_mut()
                                .and_then(|tracks| {
                                    tracks.iter_mut().find_map(|(kind, v)| {
                                        if kind == "main" && v["id"] == edit.track_id {
                                            Some(v)
                                        } else if kind == "overlay" || kind == "audio" {
                                            v.as_array_mut()?
                                                .iter_mut()
                                                .find(|t| t["id"] == edit.track_id)
                                        } else {
                                            None
                                        }
                                    })
                                })
                                .ok_or_else(|| invalid("keyframe target track not found"))?;
                            let element = track["elements"]
                                .as_array_mut()
                                .and_then(|elements| {
                                    elements.iter_mut().find(|e| e["id"] == edit.element_id)
                                })
                                .ok_or_else(|| invalid("keyframe target clip not found"))?;
                            apply(element, edit)?;
                            changed.extend([edit.track_id.clone(), edit.element_id.clone()]);
                        }
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(result)
                    .summary("Edited Classic keyframes")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn apply(element: &mut Value, edit: &Edit) -> Result<(), CapabilityError> {
    if edit.property_path.is_empty()
        || edit.property_path.len() > 1024
        || matches!(edit.property_path.as_str(), "bindings" | "channels")
        || edit.keyframe_id.is_empty()
    {
        return Err(invalid("invalid animation path or key ID"));
    }
    let duration = element["duration"]
        .as_i64()
        .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid("invalid clip duration"))?;
    let data = element
        .get_mut("animations")
        .and_then(|a| a.get_mut(&edit.property_path))
        .ok_or_else(|| invalid("animation path not found on target clip"))?;
    match &edit.change {
        Change::Retime { time } => {
            if !(-crate::classic::MAX_SAFE_INTEGER..=crate::classic::MAX_SAFE_INTEGER)
                .contains(time)
            {
                return Err(invalid("keyframe time exceeds exact browser tick range"));
            }
            let time = (*time).clamp(0, duration);
            let mut found = false;
            let mut retime = |channel: &mut Value| -> Result<(), CapabilityError> {
                validate_channel(channel)?;
                if let Some(key) = channel["keys"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|k| k["id"] == edit.keyframe_id)
                {
                    key["time"] = json!(time);
                    found = true;
                    normalize_channel(channel)?;
                }
                Ok(())
            };
            if data["keys"].is_array() {
                retime(data)?;
            } else {
                let components = data
                    .as_object_mut()
                    .filter(|o| o.len() <= 128)
                    .ok_or_else(|| invalid("invalid composite animation"))?;
                for channel in components.values_mut().filter(|v| !v.is_null()) {
                    retime(channel)?;
                }
            }
            if !found {
                return Err(invalid("keyframe ID not found on target path"));
            }
        }
        Change::Curve {
            component_key,
            patch,
        } => {
            let channel = if data["keys"].is_array() {
                if component_key != "value" {
                    return Err(invalid("leaf channel component must be value"));
                }
                data
            } else {
                data.get_mut(component_key)
                    .ok_or_else(|| invalid("animation component not found"))?
            };
            validate_channel(channel)?;
            if !is_scalar(channel) {
                return Err(invalid("curve editing requires a scalar channel"));
            }
            let key = channel["keys"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|k| k["id"] == edit.keyframe_id)
                .ok_or_else(|| invalid("keyframe ID not found in component"))?;
            for (name, handle) in [
                ("leftHandle", &patch.left_handle),
                ("rightHandle", &patch.right_handle),
            ] {
                match handle {
                    None => {}
                    Some(None) => {
                        key.as_object_mut().unwrap().remove(name);
                    }
                    Some(Some(handle)) => {
                        if !handle.dv.is_finite()
                            || !(-crate::classic::MAX_SAFE_INTEGER
                                ..=crate::classic::MAX_SAFE_INTEGER)
                                .contains(&handle.dt)
                        {
                            return Err(invalid("invalid curve handle"));
                        }
                        key[name] = json!(handle);
                    }
                }
            }
            if let Some(segment) = &patch.segment_to_next {
                key["segmentToNext"] = json!(segment);
            }
            if let Some(tangent) = &patch.tangent_mode {
                key["tangentMode"] = json!(tangent);
            }
            normalize_channel(channel)?;
        }
    }
    Ok(())
}

fn is_scalar(channel: &Value) -> bool {
    channel.get("extrapolation").is_some()
        || channel["keys"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|key| key.get("segmentToNext").is_some()))
}
pub(super) fn validate_channel(channel: &Value) -> Result<(), CapabilityError> {
    let keys = channel["keys"]
        .as_array()
        .filter(|keys| keys.len() <= 10000)
        .ok_or_else(|| invalid("animation channel needs at most 10000 keys"))?;
    let scalar = is_scalar(channel);
    let mut ids = HashSet::new();
    for key in keys {
        let id = key["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("keyframe ID missing"))?;
        if !ids.insert(id) {
            return Err(invalid("duplicate keyframe ID within a channel"));
        }
        let time = key["time"]
            .as_i64()
            .filter(|t| (0..=crate::classic::MAX_SAFE_INTEGER).contains(t));
        if time.is_none() {
            return Err(invalid(
                "keyframe time must be nonnegative exact integer ticks",
            ));
        }
        if scalar {
            if !key["value"].as_f64().is_some_and(f64::is_finite) {
                return Err(invalid("scalar key value must be finite"));
            }
            for (name, allowed) in [
                ("segmentToNext", &["step", "linear", "bezier"][..]),
                ("tangentMode", &["auto", "aligned", "broken", "flat"][..]),
            ] {
                if let Some(value) = key.get(name).filter(|v| !v.is_null()) {
                    if value.as_str().is_none_or(|v| !allowed.contains(&v)) {
                        return Err(invalid("invalid curve mode"));
                    }
                }
            }
            for name in ["leftHandle", "rightHandle"] {
                if let Some(handle) = key.get(name).filter(|v| !v.is_null()) {
                    if handle["dt"].as_i64().is_none_or(|v| {
                        !(-crate::classic::MAX_SAFE_INTEGER..=crate::classic::MAX_SAFE_INTEGER)
                            .contains(&v)
                    }) || !handle["dv"].as_f64().is_some_and(f64::is_finite)
                    {
                        return Err(invalid("invalid curve handle"));
                    }
                }
            }
        } else if !(key["value"].is_string()
            || key["value"].is_boolean()
            || key["value"].as_f64().is_some_and(f64::is_finite))
        {
            return Err(invalid("discrete key value must be string or boolean"));
        }
    }
    Ok(())
}

/// Stable ordering and handle normalization shared by canonical animation edits.
pub(super) fn normalize_channel(channel: &mut Value) -> Result<(), CapabilityError> {
    let scalar = is_scalar(channel);
    let keys = channel["keys"].as_array_mut().unwrap();
    keys.sort_by_key(|key| key["time"].as_i64().unwrap());
    if !scalar {
        return Ok(());
    }
    let times: Vec<i64> = keys
        .iter()
        .map(|key| key["time"].as_i64().unwrap())
        .collect();
    for (i, key) in keys.iter_mut().enumerate() {
        for (property, default) in [("tangentMode", "flat"), ("segmentToNext", "linear")] {
            if key.get(property).is_none_or(Value::is_null) {
                key[property] = json!(default);
            }
        }
        for (name, neighbor, left) in [
            ("leftHandle", i.checked_sub(1), true),
            ("rightHandle", (i + 1 < times.len()).then_some(i + 1), false),
        ] {
            if neighbor.is_none() || key.get(name).is_some_and(Value::is_null) {
                key.as_object_mut().unwrap().remove(name);
            } else if let Some(handle) = key.get_mut(name) {
                let span = (times[i] - times[neighbor.unwrap()]).abs().max(1);
                let dt = handle["dt"]
                    .as_i64()
                    .ok_or_else(|| invalid("invalid curve handle time"))?;
                handle["dt"] =
                    json!(dt.clamp(if left { -span } else { 0 }, if left { 0 } else { span }));
            }
        }
    }
    Ok(())
}
