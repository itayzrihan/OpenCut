//! Exact-tick Classic movement, with atomic track creation and caption ownership.
use super::classic_track_layout::{ClassicTrackType, LayoutChange, apply_layout};
use super::*;
use serde_json::json;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Move {
    source_track_id: String,
    element_id: String,
    target_track_id: String,
    #[schemars(range(min = 0, max = 9007199254740991_i64))]
    new_start_time: i64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrackCreation {
    id: String,
    #[serde(rename = "type")]
    kind: ClassicTrackType,
    index: i64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    moves: Vec<Move>,
    #[serde(default)]
    #[schemars(length(max = 1000))]
    create_tracks: Vec<TrackCreation>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ElementRef {
    track_id: String,
    element_id: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    elements: Vec<ElementRef>,
}

pub(super) fn register_classic_move(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.move",
        "Move Classic clips in exact ticks",
        "Atomically move explicit sourceTrackId/elementId clips to compatible targetTrackId tracks at newStartTime (nonnegative safe integer ticks, 120000/second). Optional createTracks supplies fresh globally unique id, type and display index; creations run in ascending index order. Every target is validated before publishing; duplicate clip moves are rejected. Retains IDs, source media, trim, retime, word runs, animation, linked audio and extension fields. Linked clips move only when explicitly included. Allows overlaps; does not ripple other clips. Updates generated caption transcript timing and reconciles manual text ownership. Does not regenerate caption visual layout; use caption layout workflow when reflow is required. Returns target references for selection/readback. Revision checks, dry run, idempotent retries, cancellation, atomic transactions and undo/redo are supported; no filesystem or network effects.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "move", "position", "clip", "track", "הזזה"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut elements = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Move timeline clips",
                    Some(input.expected_revision),
                    |document| {
                        elements = apply(document, &input, &context)?;
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
                    .summary("Moved Classic clips")
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
fn apply(
    document: &mut EditorDocument,
    input: &Input,
    context: &InvocationContext,
) -> Result<Vec<ElementRef>, CapabilityError> {
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).map_err(|e| invalid(&e.to_string()))?,
        &mut occupied,
    );
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(CapabilityError::Conflict(
            "Move target project is not active".into(),
        ));
    }
    let scene = project
        .classic
        .as_mut()
        .ok_or_else(|| invalid("Requires a Classic project"))?
        .document["scenes"]
        .as_array_mut()
        .and_then(|s| s.iter_mut().find(|s| s["id"] == input.scene_id))
        .ok_or_else(|| invalid("Scene not found"))?;
    let before = scene["tracks"].clone();
    let mut creations: Vec<_> = input.create_tracks.iter().collect();
    creations.sort_by_key(|t| t.index);
    for t in creations {
        if !occupied.insert(t.id.clone()) {
            return Err(invalid("New track identity already exists in the project"));
        }
        apply_layout(
            scene,
            LayoutChange::Add {
                track_id: t.id.clone(),
                track_type: t.kind,
                name: None,
                index: Some(t.index),
            },
        )?;
    }
    let mut moved = Vec::new();
    let mut ids = HashSet::new();
    let mut refs = Vec::new();
    for m in &input.moves {
        if context.cancellation.is_cancelled() {
            return Err(CapabilityError::Failed("operation was cancelled".into()));
        }
        if !ids.insert(m.element_id.clone()) {
            return Err(invalid("A clip can only be moved once per transaction"));
        }
        if !(0..=9_007_199_254_740_991).contains(&m.new_start_time) {
            return Err(invalid("Invalid start ticks"));
        }
        let source = all(&before)
            .find(|t| t["id"] == m.source_track_id)
            .and_then(|t| t["elements"].as_array())
            .and_then(|e| e.iter().find(|e| e["id"] == m.element_id))
            .ok_or_else(|| invalid("Source clip not found"))?;
        let target = all(&scene["tracks"])
            .find(|t| t["id"] == m.target_track_id)
            .ok_or_else(|| invalid("Target track not found"))?;
        let kind = match source["type"].as_str().unwrap_or("") {
            "image" | "video" => "video",
            "sticker" | "graphic" => "graphic",
            "text" => "text",
            "audio" => "audio",
            "effect" => "effect",
            _ => return Err(invalid("Unsupported clip type")),
        };
        if target["type"] != kind {
            return Err(invalid("Incompatible target track"));
        }
        let duration = source["duration"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid clip duration"))?;
        if duration < 0
            || m.new_start_time
                .checked_add(duration)
                .is_none_or(|e| e > 9_007_199_254_740_991)
        {
            return Err(invalid("Clip end exceeds safe ticks"));
        }
        let mut copy = source.clone();
        copy["startTime"] = json!(m.new_start_time);
        moved.push((m.target_track_id.clone(), copy));
        refs.push(ElementRef {
            track_id: m.target_track_id.clone(),
            element_id: m.element_id.clone(),
        });
    }
    let tracks = &mut scene["tracks"];
    for bucket in ["overlay", "audio", "main"] {
        let group: Vec<&mut Value> = if bucket == "main" {
            vec![&mut tracks["main"]]
        } else {
            tracks[bucket]
                .as_array_mut()
                .ok_or_else(|| invalid("Invalid tracks"))?
                .iter_mut()
                .collect()
        };
        for track in group {
            let id = track["id"].clone();
            let elements = track["elements"]
                .as_array_mut()
                .ok_or_else(|| invalid("Invalid elements"))?;
            elements.retain(|e| !ids.contains(e["id"].as_str().unwrap_or("")));
            elements.extend(
                moved
                    .iter()
                    .filter(|(t, _)| id == *t)
                    .map(|(_, e)| e.clone()),
            );
        }
    }
    let updates = serde_json::to_value(&refs).map_err(|e| invalid(&e.to_string()))?;
    super::classic_captions::sync_after_edit(tracks, &before, &updates)?;
    Ok(refs)
}
