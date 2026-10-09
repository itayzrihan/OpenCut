//! Undoable Classic deletion including generated and manually owned caption words.
use super::*;

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ElementRef {
    pub track_id: String,
    pub element_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Removal {
    Elements {
        #[schemars(length(min = 1, max = 1000))]
        elements: Vec<ElementRef>,
        #[serde(default)]
        ripple: bool,
    },
    Track {
        track_id: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    removal: Removal,
}

pub(super) fn register_classic_remove(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<RemoveInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.remove",
        "Remove Classic elements or an auxiliary track",
        "Undoably remove explicit elements (1..1000 trackId/elementId references) or one overlay/audio track in a Classic scene. Read IDs from app.state.read at /project/classic/document/scenes. Removes linked transcript words and reconciles remaining manual text-layer ownership. Track deletion updates display order and cannot remove the main track; deleting its elements is allowed. Element deletion retains empty tracks and order. Preserves unrelated clips, source/media assets, other scenes and unknown fields. By default, no ripple shift or automatic companion-media deletion. For elements, ripple=true removes the union of their timeline intervals across all layers using the trim splice policy, shifts later clips and bookmarks, maps captions/animation times, removes fully consumed companions and rejects changes to locked tracks. Requires project, scene and expectedRevision; validates all targets before editing, deduplicates element references, supports dry run, exact retry keys, atomic transactions and Undo/Redo. This removes timeline content only; it never deletes media files.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "delete",
            "remove",
            "clip",
            "track",
            "captions",
            "מחיקה",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Remove timeline content",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(invalid("Target project is not active"));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::Unavailable("Requires a Classic project".into())
                        })?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .and_then(|scenes| {
                                scenes
                                    .iter_mut()
                                    .find(|scene| scene["id"] == input.scene_id)
                            })
                            .ok_or_else(|| invalid("Scene not found"))?;
                        let ranges = match &input.removal {
                            Removal::Elements {
                                elements,
                                ripple: true,
                            } => Some(super::classic_ripple_delete::ranges(
                                &scene["tracks"],
                                elements,
                            )?),
                            _ => None,
                        };
                        let tracks = scene
                            .get_mut("tracks")
                            .ok_or_else(|| invalid("Tracks missing"))?;
                        let before_tracks = tracks.clone();
                        apply(tracks, input.removal)?;
                        if let Some(ranges) = ranges {
                            super::classic_ripple_delete::apply(scene, &before_tracks, &ranges)?;
                        }
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Removed Classic timeline content")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
}

fn apply(tracks: &mut Value, removal: Removal) -> Result<(), CapabilityError> {
    let before = tracks.clone();
    let (elements, removed_track) = match removal {
        Removal::Elements { elements, .. } => {
            for target in &elements {
                let track = all(&before)
                    .find(|track| track["id"] == target.track_id)
                    .ok_or_else(|| invalid("Track not found in target scene"))?;
                if !track["elements"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["id"] == target.element_id))
                {
                    return Err(invalid("Element not found in target track"));
                }
            }
            (elements, None)
        }
        Removal::Track { track_id } => {
            if before["main"]["id"] == track_id {
                return Err(invalid("The main track cannot be removed"));
            }
            let track = all(&before)
                .find(|track| track["id"] == track_id)
                .ok_or_else(|| invalid("Track not found in target scene"))?;
            let elements = track["elements"]
                .as_array()
                .ok_or_else(|| invalid("Invalid elements"))?
                .iter()
                .map(|item| {
                    Ok(ElementRef {
                        track_id: track_id.clone(),
                        element_id: item["id"]
                            .as_str()
                            .ok_or_else(|| invalid("Element ID missing"))?
                            .into(),
                    })
                })
                .collect::<Result<Vec<_>, CapabilityError>>()?;
            (elements, Some(track_id))
        }
    };
    let targets: HashSet<_> = elements
        .iter()
        .map(|item| (item.track_id.as_str(), item.element_id.as_str()))
        .collect();
    for bucket in ["overlay", "audio"] {
        let group = tracks[bucket]
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid track collection"))?;
        group.retain(|track| removed_track.as_ref().is_none_or(|id| track["id"] != *id));
        for track in group {
            remove_elements(track, &targets)?;
        }
    }
    remove_elements(&mut tracks["main"], &targets)?;
    if let Some(id) = removed_track {
        let known: Vec<String> = all(tracks)
            .filter_map(|track| track["id"].as_str().map(str::to_owned))
            .collect();
        let mut order = Vec::new();
        for next in before["order"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain(known.iter().map(String::as_str))
        {
            if next != id
                && known.iter().any(|known| known == next)
                && !order.iter().any(|known| known == next)
            {
                order.push(next.to_owned());
            }
        }
        tracks["order"] = serde_json::json!(order);
    }
    super::classic_captions::remove_words(tracks, &before, &elements)
}

pub(super) fn remove_explicit_elements(
    tracks: &mut Value,
    elements: Vec<ElementRef>,
) -> Result<(), CapabilityError> {
    apply(
        tracks,
        Removal::Elements {
            elements,
            ripple: false,
        },
    )
}

fn remove_elements(
    track: &mut Value,
    targets: &HashSet<(&str, &str)>,
) -> Result<(), CapabilityError> {
    let id = track["id"]
        .as_str()
        .ok_or_else(|| invalid("Invalid track ID"))?
        .to_owned();
    track["elements"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid track elements"))?
        .retain(|item| !targets.contains(&(id.as_str(), item["id"].as_str().unwrap_or(""))));
    Ok(())
}
