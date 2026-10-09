//! Portable animation clipboard data; no access to the operating system clipboard.
use super::*;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Curve {
    component_key: String,
    patch: CurvePatch,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    property_path: String,
    time_offset: i64,
    value: upsert::ParamValue,
    interpolation: upsert::Interpolation,
    curve_patches: Vec<Curve>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    property_path: String,
    keyframe_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    expected_revision: u64,
    keyframes: Vec<Selection>,
}
#[derive(Serialize, JsonSchema)]
struct Skipped {
    index: usize,
    reason: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CaptureOutput {
    revision: u64,
    items: Vec<Item>,
    skipped: Vec<Skipped>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PasteInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    expected_revision: u64,
    catalog_revision: String,
    /// Local destination ticks; each item adds its relative time offset.
    time: i64,
    items: Vec<Item>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PasteOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    keyframes: Vec<upsert::KeyOutput>,
    skipped: Vec<Skipped>,
    skipped_curves: Vec<Skipped>,
}
pub(super) fn register_clipboard(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    register::<CaptureInput, CaptureOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "animation.classic.keyframes.copy",
        "Copy Classic animation keys",
        "Read up to 1000 selected propertyPath/keyframeId pairs from one explicit Classic clip at expectedRevision. Returns portable clipboard items with timeOffset relative to the earliest copied key, composed value, interpolation and per-component curve patches. No OS clipboard access and no project/history mutation. Missing keys and uncomposable partial composites are reported in skipped. RGBA uses r as primary, then g/b/a, independently of JSON map ordering. Other channel names use ordinal order. Items use timeOffset then ordinal propertyPath order (locale-independent). Pass items to timeline.classic.keyframes.paste; the target's live product catalog determines which paths it supports.",
        "animation",
        AccessLevel::Read,
        false,
        false,
        &["classic", "animation", "keyframe", "copy", "clipboard"],
        move |context, input| {
            let state = read_state.clone();
            async move {
                if input.keyframes.is_empty() || input.keyframes.len() > 1000 {
                    return Err(invalid("select 1 to 1000 keys"));
                }
                let state = state.read().map_err(|_| invalid("state lock poisoned"))?;
                if state.active_project_id() != Some(input.project_id.as_str())
                    || state.document.revision != input.expected_revision
                {
                    return Err(CapabilityError::Conflict(
                        "clipboard source project or revision changed".into(),
                    ));
                }
                let classic = state
                    .document
                    .project
                    .as_ref()
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| invalid("Classic project required"))?;
                let scene = classic.document["scenes"]
                    .as_array()
                    .and_then(|s| s.iter().find(|s| s["id"] == input.scene_id))
                    .ok_or_else(|| invalid("source scene not found"))?;
                let tracks = &scene["tracks"];
                let track = std::iter::once(&tracks["main"])
                    .chain(tracks["overlay"].as_array().into_iter().flatten())
                    .chain(tracks["audio"].as_array().into_iter().flatten())
                    .find(|t| t["id"] == input.track_id)
                    .ok_or_else(|| invalid("source track not found"))?;
                let element = track["elements"]
                    .as_array()
                    .and_then(|e| e.iter().find(|e| e["id"] == input.element_id))
                    .ok_or_else(|| invalid("source clip not found"))?;
                let (mut items, mut skipped) = (Vec::new(), Vec::new());
                for (index, key) in input.keyframes.iter().enumerate() {
                    if context.cancellation.is_cancelled() {
                        return Err(CapabilityError::Failed("operation cancelled".into()));
                    }
                    if key.property_path.is_empty()
                        || key.property_path.len() > 1024
                        || key.keyframe_id.is_empty()
                        || key.keyframe_id.len() > 512
                    {
                        return Err(invalid("invalid clipboard key reference"));
                    }
                    match capture(&element["animations"][&key.property_path], key)? {
                        Some(item) => items.push(item),
                        None => skipped.push(Skipped {
                            index,
                            reason: "Key missing or channels cannot be composed".into(),
                        }),
                    }
                }
                let origin = items.iter().map(|i| i.time_offset).min().unwrap_or(0);
                for item in &mut items {
                    item.time_offset -= origin;
                }
                items.sort_by(|a, b| {
                    a.time_offset
                        .cmp(&b.time_offset)
                        .then_with(|| a.property_path.cmp(&b.property_path))
                });
                Ok(OperationSuccess::new(CaptureOutput {
                    revision: state.document.revision,
                    items,
                    skipped,
                }))
            }
        },
    )?;
    register::<PasteInput, PasteOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.keyframes.paste",
        "Paste Classic animation keys",
        "Paste 1..1000 portable animation clipboard items onto one explicit Classic clip. time is local integer ticks; timeOffset is added then clamped to clip duration. Read animation.classic.targets.read for catalogRevision. Uses canonical value coercion, exact-time key reuse and collision-safe IDs; then applies each item's scalar curve patches before the next item, matching Classic clipboard ordering and edge-handle normalization. Unsupported target paths are reported in skipped; curves without a matching scalar component/key are reported in skippedCurves. Invalid values/handles/times, stale document/catalog revisions or cancellation roll back the entire batch, including ID allocation. One undo step, dry run and exact retry receipts. Does not read or write the OS clipboard, copy media, or remap effect instance IDs; remap propertyPath explicitly when transferring an effect animation to another instance.",
        "animation",
        AccessLevel::Write,
        false,
        false,
        &["classic", "animation", "keyframe", "paste", "clipboard"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                if input.items.is_empty() || input.items.len() > 1000 || !exact(input.time) {
                    return Err(invalid("provide 1 to 1000 items and exact local ticks"));
                }
                let (mut keyframes, mut skipped, mut skipped_curves) =
                    (Vec::new(), Vec::new(), Vec::new());
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Paste keyframes",
                    Some(input.expected_revision),
                    |document| {
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
                                "clipboard destination project changed".into(),
                            ));
                        }
                        let element = upsert::element_mut(
                            document,
                            &input.scene_id,
                            &input.track_id,
                            &input.element_id,
                        )?;
                        let supported: HashSet<_> = catalog
                            .targets(element)
                            .iter()
                            .filter_map(|t| t["propertyPath"].as_str().map(str::to_owned))
                            .collect();
                        let mut used_ids = None;
                        let mut changed = Vec::new();
                        for (index, item) in input.items.iter().enumerate() {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed("operation cancelled".into()));
                            }
                            if item.property_path.is_empty()
                                || item.property_path.len() > 1024
                                || !exact(item.time_offset)
                                || item.curve_patches.len() > 128
                            {
                                return Err(invalid("invalid clipboard item"));
                            }
                            if !supported.contains(&item.property_path) {
                                skipped.push(Skipped {
                                    index,
                                    reason: "Parameter is not animatable on the destination clip"
                                        .into(),
                                });
                                continue;
                            }
                            let time = input.time + item.time_offset;
                            if !exact(time) {
                                return Err(invalid("paste time exceeds exact browser tick range"));
                            }
                            let resolved = upsert::apply_key(
                                document,
                                &input.scene_id,
                                &catalog,
                                &upsert::KeyInput {
                                    track_id: input.track_id.clone(),
                                    element_id: input.element_id.clone(),
                                    property_path: item.property_path.clone(),
                                    time,
                                    value: item.value.clone(),
                                    interpolation: Some(item.interpolation),
                                    keyframe_id: None,
                                },
                                &mut used_ids,
                            )?;
                            let element = upsert::element_mut(
                                document,
                                &input.scene_id,
                                &input.track_id,
                                &input.element_id,
                            )?;
                            for curve in &item.curve_patches {
                                if curve.component_key.is_empty() || curve.component_key.len() > 512
                                {
                                    return Err(invalid("invalid curve component"));
                                }
                                let data = &element["animations"][&item.property_path];
                                let channel =
                                    if data["keys"].is_array() && curve.component_key == "value" {
                                        data
                                    } else {
                                        &data[&curve.component_key]
                                    };
                                if !is_scalar(channel)
                                    || !channel["keys"].as_array().is_some_and(|ks| {
                                        ks.iter().any(|k| k["id"] == resolved.keyframe_id)
                                    })
                                {
                                    skipped_curves.push(Skipped {
                                        index,
                                        reason: format!(
                                            "No matching scalar key in component {}",
                                            curve.component_key
                                        ),
                                    });
                                    continue;
                                }
                                apply(
                                    element,
                                    &Edit {
                                        track_id: input.track_id.clone(),
                                        element_id: input.element_id.clone(),
                                        property_path: item.property_path.clone(),
                                        keyframe_id: resolved.keyframe_id.clone(),
                                        change: Change::Curve {
                                            component_key: curve.component_key.clone(),
                                            patch: curve.patch.clone(),
                                        },
                                    },
                                )?;
                            }
                            keyframes.push(resolved);
                        }
                        if !keyframes.is_empty() {
                            changed.extend([
                                input.project_id.clone(),
                                input.scene_id.clone(),
                                input.track_id.clone(),
                                input.element_id.clone(),
                            ]);
                        }
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(PasteOutput {
                    mutation,
                    keyframes,
                    skipped,
                    skipped_curves,
                })
                .summary("Pasted Classic animation keys")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
fn exact(value: i64) -> bool {
    (-crate::classic::MAX_SAFE_INTEGER..=crate::classic::MAX_SAFE_INTEGER).contains(&value)
}
fn entries(data: &Value) -> Vec<(&str, &Value)> {
    if data["keys"].is_array() {
        return vec![("value", data)];
    }
    let mut entries: Vec<_> = data
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, v)| v["keys"].is_array())
                .map(|(k, v)| (k.as_str(), v))
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|(a, _), (b, _)| {
        let rank = |k: &str| {
            ["r", "g", "b", "a"]
                .iter()
                .position(|v| *v == k)
                .unwrap_or(4)
        };
        rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
    });
    entries
}
fn capture(data: &Value, selection: &Selection) -> Result<Option<Item>, CapabilityError> {
    let entries = entries(data);
    if entries.len() > 128 {
        return Err(invalid("too many animation components"));
    }
    for (_, channel) in &entries {
        validate_channel(channel)?;
    }
    let Some((channel, key)) = entries.iter().find_map(|(_, c)| {
        c["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == selection.keyframe_id)
            .map(|k| (*c, k))
    }) else {
        return Ok(None);
    };
    let time = key["time"].as_i64().unwrap();
    let value = if entries.len() == 1 && entries[0].0 == "value" {
        sample_channel(channel, time)?
    } else {
        let mut rgba = [0.0; 4];
        for (i, name) in ["r", "g", "b", "a"].iter().enumerate() {
            let Some((_, channel)) = entries.iter().find(|(k, _)| k == name) else {
                return Ok(None);
            };
            let Some(value) = sample_channel(channel, time)?.as_f64() else {
                return Ok(None);
            };
            rgba[i] = value;
        }
        sample::format_rgba(rgba)
    };
    let interpolation = if is_scalar(channel) && key.get("segmentToNext").is_some() {
        match key["segmentToNext"].as_str() {
            Some("step") => upsert::Interpolation::Hold,
            Some("bezier") => upsert::Interpolation::Bezier,
            _ => upsert::Interpolation::Linear,
        }
    } else {
        upsert::Interpolation::Hold
    };
    let mut curve_patches = Vec::new();
    for (component_key, channel) in entries {
        if !is_scalar(channel) {
            continue;
        }
        if let Some(key) = channel["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == selection.keyframe_id)
        {
            let patch=serde_json::from_value(json!({"leftHandle":key["leftHandle"],"rightHandle":key["rightHandle"],"segmentToNext":key["segmentToNext"],"tangentMode":key["tangentMode"]})).map_err(|_|invalid("invalid copied curve"))?;
            curve_patches.push(Curve {
                component_key: component_key.into(),
                patch,
            });
        }
    }
    Ok(Some(Item {
        property_path: selection.property_path.clone(),
        time_offset: time,
        value: serde_json::from_value(value).map_err(|_| invalid("invalid copied value"))?,
        interpolation,
        curve_patches,
    }))
}
fn sample_channel(channel: &Value, time: i64) -> Result<Value, CapabilityError> {
    let fallback = channel["keys"]
        .as_array()
        .and_then(|k| k.first())
        .map(|k| k["value"].clone())
        .unwrap_or_else(|| {
            if is_scalar(channel) {
                json!(0)
            } else {
                json!(false)
            }
        });
    sample::channel_value(channel, &fallback, time as f64)
}
