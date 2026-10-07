//! Classic key creation/value edits use live product parameter contracts.
use super::*;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub(super) enum ParamValue {
    Number(f64),
    Text(String),
    Boolean(bool),
}

#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) enum Interpolation {
    Linear,
    Hold,
    Bezier,
}
impl Interpolation {
    fn segment(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Hold => "step",
            Self::Bezier => "bezier",
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KeyInput {
    pub(super) track_id: String,
    pub(super) element_id: String,
    pub(super) property_path: String,
    pub(super) time: i64,
    pub(super) value: ParamValue,
    pub(super) interpolation: Option<Interpolation>,
    pub(super) keyframe_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    catalog_revision: String,
    keyframes: Vec<KeyInput>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct KeyOutput {
    pub(super) track_id: String,
    pub(super) element_id: String,
    pub(super) property_path: String,
    pub(super) keyframe_id: String,
    pub(super) time: i64,
}
#[derive(Serialize, JsonSchema)]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    keyframes: Vec<KeyOutput>,
}

pub(super) fn register_upsert(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    register::<UpsertInput, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.keyframes.upsert",
        "Create or update Classic keyframes",
        "Create or update keys and values on real Classic clips using the live product parameter catalog. First read animation.classic.targets.read and supply its catalogRevision; paths are literal propertyPath strings. Supports numbers (product step/min/max), booleans, select/text/font strings and CSS colors in declared linear RGBA channels. Time is local integer ticks clamped to clip duration. An existing keyframeId takes priority, otherwise reuse the first key at the exact time; omit keyframeId to allocate a stable ID. Composite channels share the primary key identity, preserving existing per-component IDs on exact-time collisions. Optional interpolation sets scalar outgoing segments; otherwise existing curves are retained or product defaults used. Up to 1000 ordered edits commit atomically with dry run, exact retries, cancellation and one Undo/Redo boundary. Invalid targets/values or stale document/catalog revisions reject the entire batch. Returns resolved key identities, including in dry run. Does not remove keys or change base parameter values. Renderer callbacks are not executed.",
        "animation",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "animation",
            "keyframe",
            "create",
            "value",
            "color",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                if input.keyframes.is_empty() || input.keyframes.len() > 1000 {
                    return Err(invalid("provide between 1 and 1000 keyframes"));
                }
                let mut keys = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Create or update keyframes",
                    Some(input.expected_revision),
                    |document| {
                        // Readers and writers acquire document before catalog;
                        // hold both until the edit validates to fence host changes.
                        let catalog = catalog
                            .0
                            .read()
                            .map_err(|_| invalid("animation catalog lock poisoned"))?;
                        if catalog.revision.is_empty() || catalog.revision != input.catalog_revision
                        {
                            return Err(CapabilityError::Conflict(
                                "animation catalog changed or missing; read targets again".into(),
                            ));
                        }
                        if project_mut(document)?.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "keyframe target project is not active".into(),
                            ));
                        }
                        let mut changed = vec![input.project_id.clone(), input.scene_id.clone()];
                        let mut used_ids: Option<HashSet<String>> = None;
                        for key in &input.keyframes {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed("operation cancelled".into()));
                            }
                            keys.push(apply_key(
                                document,
                                &input.scene_id,
                                &catalog,
                                key,
                                &mut used_ids,
                            )?);
                            changed.extend([key.track_id.clone(), key.element_id.clone()]);
                        }
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    keyframes: keys,
                })
                .summary("Created or updated Classic keyframes")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

pub(super) fn element_mut<'a>(
    document: &'a mut EditorDocument,
    scene_id: &str,
    track_id: &str,
    element_id: &str,
) -> Result<&'a mut Value, CapabilityError> {
    let classic = project_mut(document)?
        .classic
        .as_mut()
        .ok_or_else(|| invalid("Classic project required"))?;
    let scene = classic.document["scenes"]
        .as_array_mut()
        .and_then(|s| s.iter_mut().find(|s| s["id"] == scene_id))
        .ok_or_else(|| invalid("keyframe target scene not found"))?;
    let track = scene["tracks"]
        .as_object_mut()
        .and_then(|tracks| {
            tracks.iter_mut().find_map(|(kind, v)| {
                if kind == "main" && v["id"] == track_id {
                    Some(v)
                } else if kind == "overlay" || kind == "audio" {
                    v.as_array_mut()?.iter_mut().find(|t| t["id"] == track_id)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| invalid("keyframe target track not found"))?;
    track["elements"]
        .as_array_mut()
        .and_then(|e| e.iter_mut().find(|e| e["id"] == element_id))
        .ok_or_else(|| invalid("keyframe target clip not found"))
}

fn channel<'a>(data: &'a Value, component: &str) -> Option<&'a Value> {
    if data["keys"].is_array() {
        (component == "value").then_some(data)
    } else {
        data.get(component).filter(|v| !v.is_null())
    }
}

fn upsert_channel(
    current: Option<Value>,
    id: &str,
    time: i64,
    value: Value,
    scalar: bool,
    interpolation: Option<&str>,
    default_segment: &str,
) -> Result<Value, CapabilityError> {
    if let Some(c) = &current {
        validate_channel(c)?;
    }
    // Classic discards an incompatible legacy channel when the parameter's
    // declared layout changes; unrelated paths and opaque metadata remain.
    let mut c = current
        .filter(|c| is_scalar(c) == scalar)
        .unwrap_or_else(|| json!({"keys":[]}));
    normalize_channel(&mut c)?;
    let keys = c["keys"].as_array_mut().unwrap();
    let index = keys
        .iter()
        .position(|k| k["id"] == id)
        .or_else(|| keys.iter().position(|k| k["time"] == time));
    if index.is_none() && keys.len() >= 10000 {
        return Err(invalid("animation channel exceeds 10000 keys"));
    }
    let mut key = index
        .map(|i| keys[i].clone())
        .unwrap_or_else(|| json!({"id":id}));
    key["time"] = json!(time);
    key["value"] = value;
    if scalar {
        if let Some(segment) = interpolation {
            key["segmentToNext"] = json!(segment);
        } else if key.get("segmentToNext").is_none_or(Value::is_null) {
            key["segmentToNext"] = json!(default_segment);
        }
        if key.get("tangentMode").is_none_or(Value::is_null) {
            key["tangentMode"] = json!("flat");
        }
    }
    if let Some(i) = index {
        keys[i] = key;
    } else {
        keys.push(key);
    }
    normalize_channel(&mut c)?;
    validate_channel(&c)?;
    Ok(c)
}

type ComponentValue = (String, Value, bool, String);
pub(super) fn coerce(param: &Value, value: &ParamValue) -> Result<Value, CapabilityError> {
    let value = match (param["type"].as_str(), value) {
        (Some("number"), ParamValue::Number(v)) if v.is_finite() => {
            let min = param["min"]
                .as_f64()
                .ok_or_else(|| invalid("number parameter needs min"))?;
            let max = param["max"].as_f64().unwrap_or(f64::INFINITY);
            let step = param["step"]
                .as_f64()
                .ok_or_else(|| invalid("number parameter needs step"))?;
            if min > max {
                return Err(invalid("invalid number parameter range"));
            }
            let stepped = if step <= 0.0 {
                *v
            } else {
                let ratio = *v / step;
                let rounded = if ratio.fract().abs() == 0.0 {
                    ratio
                } else {
                    let floor = ratio.floor();
                    if ratio - floor < 0.5 {
                        floor
                    } else {
                        floor + 1.0
                    }
                };
                let decimal = step.to_string();
                // JS Number.toString uses exponent notation below 1e-6;
                // Classic's step helper uses that exponent as its precision.
                let digits = decimal.split_once('.').map_or(0, |(_, part)| {
                    if step < 1e-6 {
                        part.bytes().position(|b| b != b'0').map_or(0, |i| i + 1)
                    } else {
                        part.len()
                    }
                });
                if digits > 100 {
                    return Err(invalid(
                        "step precision exceeds the product's 100-digit limit",
                    ));
                }
                format!("{:.*}", digits, rounded * step)
                    .parse::<f64>()
                    .map_err(|_| invalid("invalid numeric value"))?
            };
            let result = stepped.max(min).min(max);
            if !result.is_finite() {
                return Err(invalid("numeric key value must remain finite"));
            }
            json!(result)
        }
        (Some("boolean"), ParamValue::Boolean(v)) => json!(v),
        (Some("color" | "text" | "font"), ParamValue::Text(v)) if v.len() <= 262144 => json!(v),
        (Some("select"), ParamValue::Text(v))
            if param["options"]
                .as_array()
                .is_some_and(|o| o.iter().any(|o| o["value"] == *v)) =>
        {
            json!(v)
        }
        _ => return Err(invalid("key value does not match the product parameter")),
    };
    Ok(value)
}

pub(super) fn values(
    param: &Value,
    value: &ParamValue,
) -> Result<Vec<ComponentValue>, CapabilityError> {
    let value = coerce(param, value)?;
    let layout = &param["channelLayout"];
    let components: Vec<&Value>;
    let component_values = match layout["codec"].as_str() {
        Some("identity") if layout["kind"] == "leaf" => {
            components = vec![&layout["component"]];
            json!({"value":value})
        }
        Some("linearRgba") if layout["kind"] == "composite" => {
            let text = value
                .as_str()
                .filter(|s| s.len() <= 4096)
                .ok_or_else(|| invalid("color value must be a CSS string (max 4096 bytes)"))?;
            // Preserve the product's CSS parser grammar: color-mix is not yet a
            // Culori 4.0.2 input. This dependency adds it as an extension.
            if text.contains("color-mix(") {
                return Err(invalid("unsupported CSS color"));
            }
            let parsed = culors::parse(text)
                .and_then(|c| c.convert_to("rgb"))
                .ok_or_else(|| invalid("invalid CSS color"))?;
            let culors::Color::Rgb(rgb) = parsed else {
                return Err(invalid("color conversion failed"));
            };
            let linear = |v: f64| {
                let v = if v.is_nan() { 0.0 } else { v };
                if v <= 0.04045 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            let rgba = [
                linear(rgb.r),
                linear(rgb.g),
                linear(rgb.b),
                rgb.alpha.unwrap_or(1.0).clamp(0.0, 1.0),
            ];
            if rgba.iter().any(|v| !v.is_finite()) {
                return Err(invalid("color channels must be finite"));
            }
            components = layout["components"]
                .as_array()
                .ok_or_else(|| invalid("missing color components"))?
                .iter()
                .collect();
            json!({"r":rgba[0],"g":rgba[1],"b":rgba[2],"a":rgba[3]})
        }
        _ => {
            return Err(CapabilityError::Unavailable(
                "Product channel layout needs a canonical identity or linearRgba codec".into(),
            ));
        }
    };
    components
        .into_iter()
        .map(|c| {
            let key = c["key"]
                .as_str()
                .ok_or_else(|| invalid("missing component key"))?;
            let value = component_values
                .get(key)
                .ok_or_else(|| invalid("codec does not provide this component"))?
                .clone();
            let scalar = c["valueKind"] == "scalar";
            if (scalar && !value.is_number())
                || (!scalar && !(value.is_string() || value.is_boolean()))
            {
                return Err(invalid("value does not match channel layout"));
            }
            Ok((
                key.into(),
                value,
                scalar,
                if c["defaultInterpolation"] == "hold" {
                    "step"
                } else {
                    "linear"
                }
                .into(),
            ))
        })
        .collect()
}

/// Shared transaction-local authoring used by direct edits and clipboard paste.
pub(super) fn apply_key(
    document: &mut EditorDocument,
    scene_id: &str,
    catalog: &crate::classic_animation::AnimationCatalogSnapshot,
    key: &KeyInput,
    used_ids: &mut Option<HashSet<String>>,
) -> Result<KeyOutput, CapabilityError> {
    let element = element_mut(document, scene_id, &key.track_id, &key.element_id)?.clone();
    let target = catalog
        .targets(&element)
        .into_iter()
        .find(|t| t["propertyPath"] == key.property_path)
        .ok_or_else(|| {
            invalid("parameter is not animatable on this clip; read animation targets")
        })?;
    if key.property_path.len() > 1024
        || key
            .keyframe_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 512)
        || !(-crate::classic::MAX_SAFE_INTEGER..=crate::classic::MAX_SAFE_INTEGER)
            .contains(&key.time)
    {
        return Err(invalid(
            "invalid key identity, animation path or exact tick time",
        ));
    }
    let duration = element["duration"]
        .as_i64()
        .filter(|t| (0..=crate::classic::MAX_SAFE_INTEGER).contains(t))
        .ok_or_else(|| invalid("invalid clip duration"))?;
    let time = key.time.clamp(0, duration);
    let components = values(&target["parameter"], &key.value)?;
    let data = &element["animations"][&key.property_path];
    let primary = channel(data, &components[0].0);
    if let Some(c) = primary {
        validate_channel(c)?;
    }
    let existing = primary
        .and_then(|c| c["keys"].as_array())
        .and_then(|keys| {
            key.keyframe_id
                .as_ref()
                .and_then(|id| keys.iter().find(|k| k["id"] == *id))
                .or_else(|| keys.iter().find(|k| k["time"] == time))
        })
        .and_then(|k| k["id"].as_str());
    let id = if let Some(id) = existing {
        id.to_owned()
    } else if let Some(id) = &key.keyframe_id {
        id.clone()
    } else {
        if used_ids.is_none() {
            let mut ids = HashSet::new();
            collect_ids(
                &serde_json::to_value(&document.project).map_err(|e| invalid(&e.to_string()))?,
                &mut ids,
            );
            *used_ids = Some(ids);
        }
        let ids = used_ids.as_mut().unwrap();
        loop {
            let id = document.allocate_id("classic-keyframe");
            if ids.insert(id.clone()) {
                break id;
            }
        }
    };
    if let Some(ids) = used_ids.as_mut() {
        ids.insert(id.clone());
    }
    let element = element_mut(document, scene_id, &key.track_id, &key.element_id)?;
    let mut data = data.clone();
    for (component, value, scalar, default_segment) in components {
        let current = channel(&data, &component).cloned();
        let next = upsert_channel(
            current,
            &id,
            time,
            value,
            scalar,
            key.interpolation.map(Interpolation::segment),
            &default_segment,
        )?;
        if component == "value" {
            data = next;
        } else {
            if !data.is_object() || data["keys"].is_array() {
                data = json!({});
            }
            data[&component] = next;
        }
    }
    if element.get("animations").is_none_or(Value::is_null) {
        element["animations"] = json!({});
    }
    if !element["animations"].is_object() {
        return Err(invalid("invalid animation map"));
    }
    element["animations"][&key.property_path] = data;
    Ok(KeyOutput {
        track_id: key.track_id.clone(),
        element_id: key.element_id.clone(),
        property_path: key.property_path.clone(),
        keyframe_id: id,
        time,
    })
}
