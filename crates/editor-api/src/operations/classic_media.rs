//! Canonical project-media removal. Durable bytes belong to host storage and
//! are retained for undo/reopening; this operation never deletes a file.
use super::classic_remove::ElementRef;
use super::*;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveInput {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    media_ids: Vec<String>,
    #[serde(default)]
    cascade: bool,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn tracks(value: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&value["main"])
        .chain(value["overlay"].as_array().into_iter().flatten())
        .chain(value["audio"].as_array().into_iter().flatten())
}
fn references_media(value: &Value, ids: &HashSet<&str>) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (matches!(key.as_str(), "mediaId" | "sourceMediaId")
                && value.as_str().is_some_and(|id| ids.contains(id)))
                || references_media(value, ids)
        }),
        Value::Array(items) => items.iter().any(|item| references_media(item, ids)),
        _ => false,
    }
}

pub(super) fn register_classic_media(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<RemoveInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.remove",
        "Remove media from the Classic project",
        "Undoably unregister 1..1000 explicit media IDs from this Classic project. Requires projectId and expectedRevision. With cascade=false, rejects any used media; cascade=true removes its direct video/image/audio clips from every scene, reconciles caption words, and preserves empty tracks, order and unrelated content. Rejects media needed by retained HyperFrames compositions, compound media or nested clip dependencies: remove those dependencies explicitly first. No filesystem deletion or network IO; durable source bytes are retained for Undo/Redo and reopening. Supports dry run, atomic batches and exact idempotency keys. This is not permanent deletion or garbage collection.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["classic", "media", "remove", "asset", "cascade", "מדיה"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if input.media_ids.is_empty()
                    || input.media_ids.len() > 1000
                    || input
                        .media_ids
                        .iter()
                        .any(|id| id.is_empty() || id.len() > 160)
                {
                    return Err(invalid(
                        "Expected 1..1000 nonempty media IDs of at most 160 bytes",
                    ));
                }
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Remove project media",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(invalid("Target project is not active"));
                        }
                        let classic = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires Classic media"))?;
                        let ids: HashSet<&str> =
                            input.media_ids.iter().map(String::as_str).collect();
                        for id in &ids {
                            if !classic
                                .media_assets
                                .iter()
                                .any(|asset| asset.get("id").and_then(Value::as_str) == Some(*id))
                            {
                                return Err(invalid(
                                    "Media ID is not registered in the target project",
                                ));
                            }
                        }
                        for composition in classic
                            .compositions()
                            .map_err(|e| invalid(&e.to_string()))?
                            .values()
                        {
                            if composition
                                .source
                                .resource_asset_ids
                                .values()
                                .any(|id| ids.contains(id.as_str()))
                            {
                                return Err(invalid(
                                    "Media is a retained HyperFrames resource; remove its dependency first",
                                ));
                            }
                        }
                        for asset in &classic.media_assets {
                            if !asset
                                .get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|id| ids.contains(id))
                                && references_media(&Value::Object(asset.clone()), &ids)
                            {
                                return Err(invalid(
                                    "Media is required by retained compound media",
                                ));
                            }
                        }
                        let scenes = classic
                            .document
                            .get_mut("scenes")
                            .and_then(Value::as_array_mut)
                            .ok_or_else(|| invalid("Classic scenes are missing"))?;
                        let mut plans = Vec::new();
                        let mut count = 0usize;
                        for scene in scenes.iter() {
                            let mut elements = Vec::new();
                            for track in tracks(&scene["tracks"]) {
                                for element in track["elements"].as_array().into_iter().flatten() {
                                    let direct = element["mediaId"]
                                        .as_str()
                                        .is_some_and(|id| ids.contains(id));
                                    if references_media(element, &ids) && !direct {
                                        return Err(invalid(
                                            "Media is required by a nested clip dependency",
                                        ));
                                    }
                                    if direct {
                                        if !input.cascade {
                                            return Err(invalid(
                                                "Media is used on the timeline; explicitly enable cascade",
                                            ));
                                        }
                                        elements.push(ElementRef {
                                            track_id: track["id"]
                                                .as_str()
                                                .ok_or_else(|| invalid("Track ID missing"))?
                                                .into(),
                                            element_id: element["id"]
                                                .as_str()
                                                .ok_or_else(|| invalid("Clip ID missing"))?
                                                .into(),
                                        });
                                    }
                                }
                            }
                            count += elements.len();
                            if count > 10000 {
                                return Err(invalid("Media removal exceeds the 10000-clip bound"));
                            }
                            plans.push(elements);
                        }
                        let mut changed_ids: Vec<String> =
                            ids.iter().map(|id| (*id).to_owned()).collect();
                        changed_ids.sort();
                        for (scene, elements) in scenes.iter_mut().zip(plans) {
                            if elements.is_empty() {
                                continue;
                            }
                            changed_ids
                                .extend(elements.iter().map(|element| element.element_id.clone()));
                            super::classic_remove::remove_explicit_elements(
                                &mut scene["tracks"],
                                elements,
                            )?;
                        }
                        classic.media_assets.retain(|asset| {
                            !asset
                                .get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|id| ids.contains(id))
                        });
                        Ok(changed_ids)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Removed project media; source bytes retained")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
