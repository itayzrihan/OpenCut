//! Classic clip visibility/audio controls; the UI and agent share this policy.
use super::*;
use serde_json::json;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ElementRef {
    #[schemars(length(min = 1, max = 256))]
    track_id: String,
    #[schemars(length(min = 1, max = 256))]
    element_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    SetHidden { value: bool },
    SetMuted { value: bool },
    ToggleVisibility,
    ToggleMute,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    #[schemars(length(min = 1, max = 256))]
    project_id: String,
    #[schemars(length(min = 1, max = 256))]
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    elements: Vec<ElementRef>,
    change: Change,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    value: bool,
    applied: Vec<ElementRef>,
    skipped: Vec<ElementRef>,
}
pub(super) fn register_classic_element_controls(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.controls",
        "Mute or hide Classic clips",
        "Set or toggle visibility/mute for 1..1000 explicit trackId/elementId references in one Classic scene. Validates every target before writing and deduplicates repeated references. Visibility applies to video/image/text/sticker/graphic clips; effect/audio clips are skipped. Mute applies to video/audio clips and writes params.muted; other kinds are skipped. Group toggle hides/mutes all eligible clips if any is currently visible/unmuted, otherwise shows/unmutes them all. Prefer setHidden/setMuted with an explicit value in plans. Returns applied/skipped references and the group value. Preserves clip timing, media/source-audio bindings, gain, animations, effects, captions, unrelated scenes and all unknown fields. Supports revisions, dry run, exact registry retry keys, cancellation, atomic transactions and undo/redo. Does not extract source audio or mute a whole track.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "clip",
            "visibility",
            "hide",
            "show",
            "audio",
            "mute",
            "unmute",
            "השתקה",
            "הסתרה",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut applied = vec![];
                let mut skipped = vec![];
                let mut value = false;
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit clip controls",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "Clip controls target is not active".into(),
                            ));
                        }
                        let scene = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires a Classic project"))?
                            .document["scenes"]
                            .as_array_mut()
                            .and_then(|scenes| {
                                scenes.iter_mut().find(|s| s["id"] == input.scene_id)
                            })
                            .ok_or_else(|| invalid("Scene not found"))?;
                        let before = &scene["tracks"];
                        let hidden = matches!(
                            input.change,
                            Change::SetHidden { .. } | Change::ToggleVisibility
                        );
                        let mut seen = HashSet::new();
                        let mut targets = vec![];
                        for target in &input.elements {
                            if !seen.insert((&target.track_id, &target.element_id)) {
                                continue;
                            }
                            let element = all(before)
                                .find(|t| t["id"] == target.track_id)
                                .and_then(|t| t["elements"].as_array())
                                .and_then(|items| {
                                    items.iter().find(|e| e["id"] == target.element_id)
                                })
                                .ok_or_else(|| invalid("Element not found in target track"))?;
                            let eligible = if hidden {
                                matches!(
                                    element["type"].as_str(),
                                    Some("video" | "image" | "text" | "sticker" | "graphic")
                                )
                            } else {
                                matches!(element["type"].as_str(), Some("video" | "audio"))
                            };
                            if eligible
                                && !hidden
                                && element
                                    .get("params")
                                    .is_some_and(|p| !p.is_object() && !p.is_null())
                            {
                                return Err(invalid("Clip parameters must be an object"));
                            }
                            if eligible {
                                targets.push((
                                    target.clone(),
                                    if hidden {
                                        element["hidden"] == true
                                    } else {
                                        element["params"]["muted"] == true
                                    },
                                ));
                            } else {
                                skipped.push(target.clone());
                            }
                        }
                        value = match input.change {
                            Change::SetHidden { value } | Change::SetMuted { value } => value,
                            _ => targets.iter().any(|(_, flag)| !flag),
                        };
                        for (target, _) in targets {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "Operation was cancelled".into(),
                                ));
                            }
                            let track = all_mut(&mut scene["tracks"])
                                .find(|t| t["id"] == target.track_id)
                                .expect("validated track");
                            let element = track["elements"]
                                .as_array_mut()
                                .unwrap()
                                .iter_mut()
                                .find(|e| e["id"] == target.element_id)
                                .unwrap();
                            if hidden {
                                element["hidden"] = json!(value);
                            } else {
                                element["params"]["muted"] = json!(value);
                            }
                            applied.push(target);
                        }
                        Ok(std::iter::once(input.project_id.clone())
                            .chain(std::iter::once(input.scene_id.clone()))
                            .chain(applied.iter().map(|r| r.element_id.clone()))
                            .collect())
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    value,
                    applied,
                    skipped,
                })
                .summary("Updated Classic clip controls")
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
fn all_mut(tracks: &mut Value) -> impl Iterator<Item = &mut Value> {
    tracks
        .as_object_mut()
        .into_iter()
        .flat_map(|o| o.iter_mut())
        .flat_map(|(key, value)| {
            if key == "main" {
                vec![value]
            } else if key == "overlay" || key == "audio" {
                value
                    .as_array_mut()
                    .map(|a| a.iter_mut().collect())
                    .unwrap_or_default()
            } else {
                vec![]
            }
        })
}
