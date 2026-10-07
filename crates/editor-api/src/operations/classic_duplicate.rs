//! Classic duplication: fresh identities, shared source media and independent animation.
use super::classic_track_layout::{apply_layout, ClassicTrackType, LayoutChange};
use super::*;
use serde_json::json;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ElementRef {
    track_id: String,
    element_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    elements: Vec<ElementRef>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    elements: Vec<ElementRef>,
}

pub(super) fn register_classic_duplicate(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.duplicate",
        "Duplicate Classic clips onto new tracks",
        "Duplicate 1..1000 explicit trackId/elementId references in a Classic scene. Validates all targets before editing and deduplicates repeated references. Groups copies by their original track, in overlay/main/audio storage order, creating one new populated track per source at the top of the display order. Fresh clip/track/keyframe identities are allocated by the runtime; copies retain source timing, trim, media bindings, effects, masks, transitions, word runs and other clip fields. Does not copy track-level transcript ownership, mute or visibility: new tracks use product defaults; manual text ownership is reconciled against retained caption sources. Animation channels are normalized with the shared keyframe policy, composite keys retain shared identities within each property, obsolete bindings/channels are dropped. Returns created trackId/elementId pairs for selection/readback. No source files are copied or removed. Read source IDs via app.state.read. Supports revision checks, dry run, exact retry keys, cancellation, atomic transactions and undo/redo.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "duplicate",
            "copy",
            "clip",
            "track",
            "animation",
            "שכפול",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut elements = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Duplicate timeline clips",
                    Some(input.expected_revision),
                    |document| {
                        elements = duplicate(document, &input, &context)?;
                        Ok(std::iter::once(input.project_id.clone())
                            .chain(std::iter::once(input.scene_id.clone()))
                            .chain(
                                elements
                                    .iter()
                                    .flat_map(|r| [r.track_id.clone(), r.element_id.clone()]),
                            )
                            .collect())
                    },
                )?;
                Ok(OperationSuccess::new(Output { mutation, elements })
                    .summary("Duplicated Classic clips")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn scene<'a>(document: &'a EditorDocument, input: &Input) -> Result<&'a Value, CapabilityError> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| invalid("No active project"))?;
    if project.id != input.project_id {
        return Err(invalid("Target project is not active"));
    }
    project
        .classic
        .as_ref()
        .ok_or_else(|| invalid("Requires a Classic project"))?
        .document["scenes"]
        .as_array()
        .and_then(|scenes| scenes.iter().find(|s| s["id"] == input.scene_id))
        .ok_or_else(|| invalid("Scene not found"))
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
pub(super) fn fresh(
    document: &mut EditorDocument,
    occupied: &mut HashSet<String>,
    prefix: &str,
) -> String {
    loop {
        let id = document.allocate_id(prefix);
        if occupied.insert(id.clone()) {
            return id;
        }
    }
}
fn duplicate(
    document: &mut EditorDocument,
    input: &Input,
    context: &InvocationContext,
) -> Result<Vec<ElementRef>, CapabilityError> {
    let before = scene(document, input)?["tracks"].clone();
    let mut requested = HashSet::new();
    for target in &input.elements {
        let exists = all(&before)
            .find(|t| t["id"] == target.track_id)
            .and_then(|t| t["elements"].as_array())
            .is_some_and(|items| items.iter().any(|e| e["id"] == target.element_id));
        if !exists {
            return Err(invalid("Element not found in target track"));
        }
        requested.insert((target.track_id.as_str(), target.element_id.as_str()));
    }
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).map_err(|e| invalid(&e.to_string()))?,
        &mut occupied,
    );
    let mut tracks = Vec::new();
    let mut output = Vec::new();
    for original in all(&before) {
        let id = original["id"]
            .as_str()
            .ok_or_else(|| invalid("Invalid track"))?;
        let originals: Vec<_> = original["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| requested.contains(&(id, e["id"].as_str().unwrap_or(""))))
            .collect();
        if originals.is_empty() {
            continue;
        }
        let kind: ClassicTrackType = serde_json::from_value(original["type"].clone())
            .map_err(|_| invalid("Unsupported source track"))?;
        let track_id = fresh(document, &mut occupied, "classic-track");
        let mut copies = Vec::new();
        for original in originals {
            if context.cancellation.is_cancelled() {
                return Err(CapabilityError::Failed("operation was cancelled".into()));
            }
            let mut copy = original.clone();
            let id = fresh(document, &mut occupied, "classic-clip");
            copy["id"] = json!(id);
            copy["name"] = json!(format!(
                "{} (copy)",
                original["name"].as_str().unwrap_or("")
            ));
            clone_animation(document, &mut occupied, &mut copy)?;
            output.push(ElementRef {
                track_id: track_id.clone(),
                element_id: id,
            });
            copies.push(copy);
        }
        tracks.push((track_id, kind, copies));
    }
    let target = project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == input.scene_id)
        .unwrap();
    for (id, kind, copies) in tracks {
        apply_layout(
            target,
            LayoutChange::Add {
                track_id: id.clone(),
                track_type: kind,
                name: None,
                index: Some(0),
            },
        )?;
        let bucket = if matches!(kind, ClassicTrackType::Audio) {
            "audio"
        } else {
            "overlay"
        };
        let track = target["tracks"][bucket]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| t["id"] == id)
            .unwrap();
        track.as_object_mut().unwrap().remove("keepEmpty");
        track["elements"] = Value::Array(copies);
    }
    super::classic_captions::reconcile_words(&mut target["tracks"], &[])?;
    Ok(output)
}

pub(super) fn clone_animation(
    document: &mut EditorDocument,
    occupied: &mut HashSet<String>,
    copy: &mut Value,
) -> Result<(), CapabilityError> {
    let Some(animations) = copy.get_mut("animations").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    animations.retain(|path, _| !matches!(path.as_str(), "bindings" | "channels"));
    for data in animations.values_mut() {
        let mut ids = HashMap::new();
        if data["keys"].is_array() {
            clone_channel(document, occupied, data, &mut ids)?;
        } else if let Some(components) = data.as_object_mut() {
            for channel in components.values_mut().filter(|c| c["keys"].is_array()) {
                clone_channel(document, occupied, channel, &mut ids)?;
            }
        }
    }
    animations.retain(|_, data| {
        data["keys"].as_array().is_some_and(|keys| !keys.is_empty())
            || data.as_object().is_some_and(|components| {
                components
                    .values()
                    .any(|c| c["keys"].as_array().is_some_and(|keys| !keys.is_empty()))
            })
    });
    if animations.is_empty() {
        copy.as_object_mut().unwrap().remove("animations");
    }
    Ok(())
}
fn clone_channel(
    document: &mut EditorDocument,
    occupied: &mut HashSet<String>,
    channel: &mut Value,
    ids: &mut HashMap<String, String>,
) -> Result<(), CapabilityError> {
    super::classic_keyframes::validate_channel(channel)?;
    for key in channel["keys"].as_array_mut().unwrap() {
        let original = key["id"].as_str().unwrap().to_owned();
        let id = ids
            .entry(original)
            .or_insert_with(|| fresh(document, occupied, "classic-keyframe"));
        key["id"] = json!(id);
    }
    super::classic_keyframes::normalize_channel(channel)
}
