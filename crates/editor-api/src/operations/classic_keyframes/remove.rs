//! Atomic deletion samples each original path once, before any batch edits.
use super::*;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    track_id: String,
    element_id: String,
    property_path: String,
    keyframe_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    catalog_revision: String,
    /// Absolute timeline ticks; clamped to each clip's local duration.
    playhead_time: i64,
    /// General key deletion preserves the observed value. The legacy effect-only
    /// remove control instead retains its stored base value.
    preserve_at_playhead: bool,
    keyframes: Vec<Key>,
}
pub(super) fn register_remove(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.keyframes.remove",
        "Remove Classic keyframes",
        "Remove existing key IDs across the components of real Classic animation paths. Discover paths with animation.classic.targets.read, read key IDs with app.state.read and supply catalogRevision and expectedRevision. playheadTime is absolute integer timeline ticks. With preserveAtPlayhead=true, sample each original path before any edits and persist its coerced value to the base parameter only when its final key is removed, matching general UI deletion. With false, retain stored base values (legacy effect-only control). Supports scalar step/linear/Bezier and edge extrapolation, discrete values, and linear RGBA colors. Up to 1000 keys form one atomic undo step with dry run, cancellation and exact retries. Missing keys/targets, invalid animation data or stale catalog/document revisions reject the whole batch. Unrelated fields are preserved; renderer callbacks are not executed.",
        "animation",
        AccessLevel::Write,
        false,
        false,
        &["classic", "animation", "keyframe", "delete", "playhead"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                if input.keyframes.is_empty()
                    || input.keyframes.len() > 1000
                    || !(-crate::classic::MAX_SAFE_INTEGER..=crate::classic::MAX_SAFE_INTEGER)
                        .contains(&input.playhead_time)
                {
                    return Err(invalid(
                        "provide 1 to 1000 keys and exact integer playhead ticks",
                    ));
                }
                let result = mutate(
                    &state,
                    &events,
                    &context,
                    "Remove keyframes",
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
                                "keyframe target project is not active".into(),
                            ));
                        }
                        let mut samples: Vec<((String, String, String), (Value, Option<Value>))> =
                            Vec::new();
                        // Never sample after removing an earlier key from this batch.
                        for key in &input.keyframes {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed("operation cancelled".into()));
                            }
                            if key.property_path.is_empty()
                                || key.property_path.len() > 1024
                                || key.keyframe_id.is_empty()
                                || key.keyframe_id.len() > 512
                            {
                                return Err(invalid("invalid animation path or key ID"));
                            }
                            let element = upsert::element_mut(
                                document,
                                &input.scene_id,
                                &key.track_id,
                                &key.element_id,
                            )?;
                            let data = &element["animations"][&key.property_path];
                            if !channels(data).iter().any(|c| {
                                c["keys"].as_array().is_some_and(|keys| {
                                    keys.iter().any(|k| k["id"] == key.keyframe_id)
                                })
                            }) {
                                return Err(invalid("keyframe not found on target path"));
                            }
                            for channel in channels(data) {
                                validate_channel(channel)?;
                            }
                            let identity = (
                                key.track_id.clone(),
                                key.element_id.clone(),
                                key.property_path.clone(),
                            );
                            if samples.iter().any(|(id, _)| *id == identity) {
                                continue;
                            }
                            let target = catalog.targets(element).into_iter().find(|t| t["propertyPath"] == key.property_path)
                            .ok_or_else(|| invalid("parameter is not animatable on this clip; read animation targets"))?;
                            let value = if input.preserve_at_playhead {
                                let start = element["startTime"]
                                    .as_i64()
                                    .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
                                    .ok_or_else(|| invalid("invalid clip start"))?;
                                let duration = element["duration"]
                                    .as_i64()
                                    .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
                                    .ok_or_else(|| invalid("invalid clip duration"))?;
                                Some(sample::path_value(
                                    data,
                                    &target,
                                    (input.playhead_time - start).clamp(0, duration) as f64,
                                )?)
                            } else {
                                None
                            };
                            samples.push((identity, (target, value)));
                        }
                        let mut changed = vec![input.project_id.clone(), input.scene_id.clone()];
                        for key in &input.keyframes {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed("operation cancelled".into()));
                            }
                            let element = upsert::element_mut(
                                document,
                                &input.scene_id,
                                &key.track_id,
                                &key.element_id,
                            )?;
                            if let Some(data) = element
                                .get_mut("animations")
                                .and_then(|a| a.get_mut(&key.property_path))
                            {
                                remove(data, &key.keyframe_id)?;
                            }
                            changed.extend([key.track_id.clone(), key.element_id.clone()]);
                        }
                        for ((track, element_id, path), (target, sample)) in samples {
                            let element = upsert::element_mut(
                                document,
                                &input.scene_id,
                                &track,
                                &element_id,
                            )?;
                            if channels(&element["animations"][&path])
                                .iter()
                                .any(|c| c["keys"].as_array().is_some_and(|keys| !keys.is_empty()))
                            {
                                continue;
                            }
                            // Retain unknown extensions on the affected composite and
                            // all unrelated paths, unlike the old global pruning helper.
                            if element["animations"][&path]
                                .as_object()
                                .is_some_and(|o| o.is_empty())
                            {
                                element["animations"].as_object_mut().unwrap().remove(&path);
                            }
                            if element["animations"]
                                .as_object()
                                .is_some_and(|o| o.is_empty())
                            {
                                element.as_object_mut().unwrap().remove("animations");
                            }
                            if let Some(sample) = sample {
                                let value = serde_json::from_value(sample)
                                    .map_err(|_| invalid("invalid sampled parameter"))?;
                                let value = upsert::coerce(&target["parameter"], &value)?;
                                let base =
                                    if let Some(id) = target["baseTarget"]["effectId"].as_str() {
                                        element["effects"]
                                            .as_array_mut()
                                            .and_then(|e| e.iter_mut().find(|e| e["id"] == id))
                                            .ok_or_else(|| invalid("effect no longer present"))?
                                    } else {
                                        element
                                    };
                                if base.get("params").is_none_or(Value::is_null) {
                                    base["params"] = json!({});
                                }
                                let params = base["params"]
                                    .as_object_mut()
                                    .ok_or_else(|| invalid("invalid parameter map"))?;
                                params.insert(
                                    target["baseTarget"]["paramKey"].as_str().unwrap().into(),
                                    value,
                                );
                            }
                        }
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(result)
                    .summary("Removed Classic keyframes")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
fn channels(data: &Value) -> Vec<&Value> {
    if data["keys"].is_array() {
        vec![data]
    } else {
        data.as_object()
            .map(|o| o.values().filter(|v| v["keys"].is_array()).collect())
            .unwrap_or_default()
    }
}
fn remove(data: &mut Value, id: &str) -> Result<(), CapabilityError> {
    if let Some(keys) = data.get_mut("keys").and_then(Value::as_array_mut) {
        keys.retain(|k| k["id"] != id);
        if keys.is_empty() {
            *data = json!({});
        } else {
            normalize_channel(data)?;
        }
    } else if let Some(components) = data.as_object_mut() {
        let mut empty = Vec::new();
        for (component, channel) in components.iter_mut().filter(|(_, c)| c["keys"].is_array()) {
            remove(channel, id)?;
            if channel.as_object().is_some_and(|o| o.is_empty()) {
                empty.push(component.clone());
            }
        }
        for component in empty {
            components.remove(&component);
        }
    }
    Ok(())
}
