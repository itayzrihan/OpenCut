//! Classic clip effect mutations shared by the editor UI and discovered tools.
use super::*;
use crate::classic_effects::{
    ClassicEffectCatalog, build_effect, invalid, validate_effects, validate_params,
};
use serde_json::json;

fn effect_params_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    serde_json::from_value(json!({"type":"object", "maxProperties":512,
        "propertyNames":{"minLength":1},
        "additionalProperties":{"type":["string","number","boolean"]}
    }))
    .expect("static effect parameter schema")
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogInput {
    project_id: String,
    query: Option<String>,
    effect_type: Option<String>,
    #[serde(default)]
    include_parameters: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CatalogOutput {
    catalog_revision: String,
    definitions: Vec<Value>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum EffectChange {
    Add {
        #[serde(rename = "effectType")]
        effect_type: String,
        #[serde(default)]
        #[schemars(schema_with = "effect_params_schema")]
        params: Map<String, Value>,
        #[serde(default, rename = "allowCustomFallback")]
        allow_custom_fallback: bool,
    },
    Update {
        #[serde(rename = "effectId")]
        effect_id: String,
        #[schemars(schema_with = "effect_params_schema")]
        params: Map<String, Value>,
    },
    SetEnabled {
        #[serde(rename = "effectId")]
        effect_id: String,
        enabled: bool,
    },
    Toggle {
        #[serde(rename = "effectId")]
        effect_id: String,
    },
    Remove {
        #[serde(rename = "effectId")]
        effect_id: String,
    },
    Reorder {
        #[serde(rename = "fromIndex")]
        from_index: usize,
        #[serde(rename = "toIndex")]
        to_index: usize,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    expected_revision: u64,
    catalog_revision: String,
    change: EffectChange,
    history_group: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EffectOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    effect_id: Option<String>,
}

pub(super) fn register_classic_effects(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: ClassicEffectCatalog,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    let read_catalog = catalog.clone();
    register::<CatalogInput, CatalogOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "effects.classic.catalog.read",
        "Read available Classic effects",
        "Read the current host renderer's effect definitions and catalogRevision before editing effects. Filter by query or exact effectType; includeParameters returns defaults, parameter types, UI ranges, choices and animation metadata. New product registry entries appear here automatically. An empty catalog means this host has not declared renderers. custom-ai-effect can store unsupported requests as metadata: adding it does not prove a visible effect; review actual frames.",
        "effects",
        AccessLevel::Read,
        false,
        false,
        &[
            "classic",
            "effects",
            "catalog",
            "parameters",
            "filter",
            "blur",
            "color",
        ],
        move |_context, input| {
            let state = read_state.clone();
            let catalog = read_catalog.clone();
            async move {
                let state = state.read().map_err(|_| invalid("state lock poisoned"))?;
                if state.active_project_id() != Some(input.project_id.as_str()) {
                    return Err(CapabilityError::Conflict(
                        "effect catalog project is not active".into(),
                    ));
                }
                // Edits lock catalog before document. Release this scope check
                // before reading catalog to avoid inverted lock ordering on native hosts.
                drop(state);
                let snapshot = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("effect catalog lock poisoned"))?;
                let query = input.query.unwrap_or_default().to_lowercase();
                let definitions = snapshot
                    .definitions
                    .iter()
                    .filter(|d| input.effect_type.as_ref().is_none_or(|t| d["type"] == *t))
                    .filter(|d| {
                        query.is_empty()
                            || json!([d["type"], d["name"], d["keywords"]])
                                .to_string()
                                .to_lowercase()
                                .contains(&query)
                    })
                    .map(|d| {
                        let mut d = d.clone();
                        if !input.include_parameters {
                            d.as_object_mut().unwrap().remove("params");
                        }
                        d
                    })
                    .collect();
                Ok(OperationSuccess::new(CatalogOutput {
                    catalog_revision: snapshot.revision.clone(),
                    definitions,
                }))
            }
        },
    )?;
    register::<EffectInput, EffectOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.effects.edit",
        "Edit Classic clip effects",
        "Add, update parameters, enable/disable, toggle, remove or reorder effects on a visual Classic clip (video/image/text/sticker/graphic). Read effects.classic.catalog.read and send its catalogRevision. Add uses live product defaults and supports explicit custom fallback; unknown custom metadata is not evidence of a visible edit. Updates merge number/string/boolean parameters and preserve keyframe animation and extension fields. Removing retains animation metadata like the existing UI. Reorder indices must be in range. Requires explicit project/scene/track/element IDs, expectedRevision. Supports dry run, retry identity, atomic edits, cancellation, Undo/Redo; historyGroup coalesces consecutive preview updates only.",
        "effects",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "effects",
            "add",
            "remove",
            "parameters",
            "filter",
            "color",
            "blur",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("effect catalog lock poisoned"))?;
                if catalog.revision != input.catalog_revision {
                    return Err(CapabilityError::Conflict(
                        "effect catalog changed; read it again before editing".into(),
                    ));
                }
                if input
                    .history_group
                    .as_ref()
                    .is_some_and(|g| g.is_empty() || g.len() > 128)
                {
                    return Err(invalid("invalid effect history group"));
                }
                let mut effect_id = None;
                let mutation = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Edit clip effects",
                    Some(input.expected_revision),
                    input.history_group.as_deref(),
                    |document| {
                        let new_effect = if let EffectChange::Add {
                            effect_type,
                            params,
                            allow_custom_fallback,
                        } = &input.change
                        {
                            let mut effect = build_effect(
                                &catalog,
                                effect_type,
                                params,
                                *allow_custom_fallback,
                            )?;
                            let mut occupied = HashSet::new();
                            collect_ids(
                                &serde_json::to_value(&document.project)
                                    .map_err(|e| invalid(&e.to_string()))?,
                                &mut occupied,
                            );
                            let id = loop {
                                let id = document.allocate_id("classic-effect");
                                if !occupied.contains(&id) {
                                    break id;
                                }
                            };
                            effect["id"] = json!(id);
                            Some(effect)
                        } else {
                            None
                        };
                        let element = element_mut(document, &input)?;
                        validate_effects(element)?;
                        if !element.get("effects").is_some_and(Value::is_array) {
                            element["effects"] = json!([]);
                        }
                        let effects = element["effects"].as_array_mut().unwrap();
                        match &input.change {
                            EffectChange::Add { .. } => {
                                let effect = new_effect.unwrap();
                                effect_id = effect["id"].as_str().map(str::to_owned);
                                effects.push(effect);
                            }
                            EffectChange::Reorder {
                                from_index,
                                to_index,
                            } => {
                                if *from_index >= effects.len() || *to_index >= effects.len() {
                                    return Err(invalid("effect reorder index out of range"));
                                }
                                let effect = effects.remove(*from_index);
                                effect_id = effect["id"].as_str().map(str::to_owned);
                                effects.insert(*to_index, effect);
                            }
                            change => {
                                let id = match change {
                                    EffectChange::Update { effect_id, .. }
                                    | EffectChange::SetEnabled { effect_id, .. }
                                    | EffectChange::Toggle { effect_id }
                                    | EffectChange::Remove { effect_id } => effect_id,
                                    _ => unreachable!(),
                                };
                                let index = effects
                                    .iter()
                                    .position(|e| e["id"] == *id)
                                    .ok_or_else(|| invalid("effect not found on target clip"))?;
                                effect_id = Some(id.clone());
                                match change {
                                    EffectChange::Update { params, .. } => {
                                        validate_params(params)?;
                                        effects[index]["params"]
                                            .as_object_mut()
                                            .unwrap()
                                            .extend(params.clone());
                                    }
                                    EffectChange::SetEnabled { enabled, .. } => {
                                        effects[index]["enabled"] = json!(enabled)
                                    }
                                    EffectChange::Toggle { .. } => {
                                        effects[index]["enabled"] =
                                            json!(effects[index]["enabled"] != true)
                                    }
                                    EffectChange::Remove { .. } => {
                                        effects.remove(index);
                                    }
                                    _ => unreachable!(),
                                }
                            }
                        }
                        Ok(vec![
                            input.project_id.clone(),
                            input.scene_id.clone(),
                            input.track_id.clone(),
                            input.element_id.clone(),
                        ])
                    },
                )?;
                Ok(OperationSuccess::new(EffectOutput {
                    mutation,
                    effect_id,
                })
                .summary("Edited Classic clip effects")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn element_mut<'a>(
    document: &'a mut EditorDocument,
    input: &EffectInput,
) -> Result<&'a mut Value, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(CapabilityError::Conflict(
            "effect target project is not active".into(),
        ));
    }
    let classic = project.classic.as_mut().ok_or_else(|| {
        CapabilityError::Unavailable("Classic effect requires a Classic project".into())
    })?;
    let scene = classic.document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == input.scene_id)
        .ok_or_else(|| invalid("effect target scene not found"))?;
    let tracks = scene["tracks"].as_object_mut().unwrap();
    let track = tracks
        .iter_mut()
        .find_map(|(key, v)| {
            if key == "main" && v["id"] == input.track_id {
                Some(v)
            } else if key == "overlay" || key == "audio" {
                v.as_array_mut()?
                    .iter_mut()
                    .find(|t| t["id"] == input.track_id)
            } else {
                None
            }
        })
        .ok_or_else(|| invalid("effect target track not found"))?;
    let element = track["elements"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"] == input.element_id)
        .ok_or_else(|| invalid("effect target clip not found"))?;
    if !matches!(
        element["type"].as_str(),
        Some("video" | "image" | "text" | "sticker" | "graphic")
    ) {
        return Err(invalid("effects require a visual clip"));
    }
    Ok(element)
}
