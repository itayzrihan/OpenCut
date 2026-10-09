//! Lossless Classic track insertion and display ordering.
use super::*;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum ClassicTrackType {
    Video,
    Text,
    Audio,
    Graphic,
    Effect,
    Parallax,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum LayoutChange {
    Add {
        track_id: String,
        track_type: ClassicTrackType,
        #[serde(default)]
        name: Option<String>,
        /// Zero-based top-to-bottom display index, clamped to existing bounds.
        #[serde(default)]
        index: Option<i64>,
    },
    Reorder {
        track_id: String,
        to_index: i64,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayoutInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    change: LayoutChange,
}

pub(super) fn register_classic_track_layout(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<LayoutInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.tracks.layout",
        "Add or reorder Classic tracks",
        "Adds an explicitly retained empty track or changes top-to-bottom display order in an explicit Classic scene. Added tracks set keepEmpty so later edits cannot prune them before content is inserted. For add, supply a fresh trackId unique across project tracks/elements. Video, text, graphic and effect tracks are visual overlays; audio tracks retain their audio collection. Parallax markers require a canvas scene. Without index, effect/parallax goes first, audio goes last, and other tracks go before the first audio track. Integer indices are clamped. Reorder may move the main track but never changes its identity or any clip. Preserves source bindings, captions, unknown fields and unrelated scenes. Read IDs/order via app.state.read. Supports revision checks, dry run, registry retry keys, atomic transactions and undo/redo; no filesystem effects.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic", "track", "add", "create", "reorder", "layer", "audio", "parallax",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit track layout",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "track layout target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::Unavailable(
                                "track layout requires a Classic project".into(),
                            )
                        })?;
                        let scene = classic
                            .document
                            .get_mut("scenes")
                            .and_then(Value::as_array_mut)
                            .and_then(|scenes| {
                                scenes
                                    .iter_mut()
                                    .find(|scene| scene["id"] == input.scene_id)
                            })
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("Classic scene not found".into())
                            })?;
                        let id = apply_layout(scene, input.change)?;
                        Ok(vec![input.project_id, input.scene_id, id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Classic track layout")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

pub(super) fn apply_layout(scene: &mut Value, change: LayoutChange) -> Result<String, CapabilityError> {
    let canvas = scene.get("parallax").is_some_and(Value::is_object);
    let tracks = scene
        .get_mut("tracks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CapabilityError::InvalidInput("invalid Classic tracks".into()))?;
    let all: Vec<&Value> = tracks
        .get("overlay")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(tracks.get("main"))
        .chain(
            tracks
                .get("audio")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        )
        .collect();
    let default: Vec<String> = all
        .iter()
        .filter_map(|track| track["id"].as_str().map(str::to_owned))
        .collect();
    let mut order = Vec::new();
    for id in tracks
        .get("order")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(default.iter().map(String::as_str))
    {
        if default.iter().any(|known| known == id) && !order.iter().any(|known| known == id) {
            order.push(id.to_owned());
        }
    }
    let id = match change {
        LayoutChange::Reorder { track_id, to_index } => {
            let from = order.iter().position(|id| id == &track_id).ok_or_else(|| {
                CapabilityError::InvalidInput("track not found in target scene".into())
            })?;
            order.remove(from);
            order.insert(clamp_index(to_index, order.len()), track_id.clone());
            track_id
        }
        LayoutChange::Add {
            track_id,
            track_type,
            name,
            index,
        } => {
            if track_id.trim().is_empty() || track_id.len() > 160 {
                return Err(CapabilityError::InvalidInput(
                    "trackId must contain 1 to 160 UTF-8 bytes".into(),
                ));
            }
            if default.contains(&track_id) {
                return Err(CapabilityError::Conflict("track ID already exists".into()));
            }
            if matches!(track_type, ClassicTrackType::Parallax) && !canvas {
                return Err(CapabilityError::InvalidInput(
                    "Parallax tracks can only be added inside a canvas scene".into(),
                ));
            }
            let default_index = match track_type {
                ClassicTrackType::Effect | ClassicTrackType::Parallax => 0,
                ClassicTrackType::Audio => order.len(),
                _ => order
                    .iter()
                    .position(|id| {
                        all.iter()
                            .any(|track| track["id"] == *id && track["type"] == "audio")
                    })
                    .unwrap_or(order.len()),
            };
            let index = index
                .map(|value| clamp_index(value, order.len()))
                .unwrap_or(default_index);
            let default_name = match track_type {
                ClassicTrackType::Video => "Video track",
                ClassicTrackType::Text => "Text track",
                ClassicTrackType::Audio => "Audio track",
                ClassicTrackType::Graphic => "Graphic track",
                ClassicTrackType::Effect => "Effect track",
                ClassicTrackType::Parallax => "Parallax group",
            };
            let name = name.unwrap_or_else(|| default_name.into());
            if name.trim().is_empty() || name.len() > 1024 {
                return Err(CapabilityError::InvalidInput("invalid track name".into()));
            }
            let mut track = serde_json::json!({"id": track_id, "type": track_type, "name": name, "elements": [], "keepEmpty": true});
            if matches!(
                track_type,
                ClassicTrackType::Video | ClassicTrackType::Audio
            ) {
                track["muted"] = Value::Bool(false);
            }
            if !matches!(
                track_type,
                ClassicTrackType::Audio | ClassicTrackType::Parallax
            ) {
                track["hidden"] = Value::Bool(false);
            }
            if matches!(track_type, ClassicTrackType::Parallax) {
                track["direction"] = Value::String("against-camera".into());
                track["speedPercent"] = Value::from(35);
            }
            let bucket = if matches!(track_type, ClassicTrackType::Audio) {
                "audio"
            } else {
                "overlay"
            };
            let group = tracks
                .get_mut(bucket)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| CapabilityError::InvalidInput("invalid track collection".into()))?;
            let group_index = order[..index]
                .iter()
                .filter(|id| group.iter().any(|track| track["id"] == **id))
                .count();
            group.insert(group_index.min(group.len()), track);
            order.insert(index, track_id.clone());
            track_id
        }
    };
    tracks.insert("order".into(), serde_json::json!(order));
    Ok(id)
}

fn clamp_index(index: i64, length: usize) -> usize {
    index.max(0).min(length as i64) as usize
}
