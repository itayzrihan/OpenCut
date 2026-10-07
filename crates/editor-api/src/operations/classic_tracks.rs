//! Track controls shared by the Classic UI, editing agent and generated MCP.
use super::*;

#[derive(Debug, Deserialize, JsonSchema)]
enum ParallaxDirection {
    #[serde(rename = "with-camera")]
    WithCamera,
    #[serde(rename = "against-camera")]
    AgainstCamera,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TrackChange {
    /// Prefer explicit values for planned edits; toggles serve direct UI gestures.
    Set {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        muted: Option<bool>,
        #[serde(default)]
        hidden: Option<bool>,
    },
    ToggleMute,
    ToggleVisibility,
    Parallax {
        #[serde(default)]
        direction: Option<ParallaxDirection>,
        /// UI and agent share clamping to the established 0..400 percent range.
        #[serde(default)]
        speed_percent: Option<f64>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrackUpdateInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    expected_revision: u64,
    change: TrackChange,
}

pub(super) fn register_classic_track_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<TrackUpdateInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.track.update",
        "Update Classic track controls",
        "Rename, mute/unmute, hide/show, or configure a parallax marker track in an explicit Classic scene. Read track IDs from app.state.read at /project/classic/document/scenes. Set explicit values for planned edits; toggle variants serve UI gestures. Only video/audio tracks have mute, and video/text/graphic/effect tracks have visibility. The parallax change requires a canvas scene and a parallax track; direction is with-camera or against-camera, finite speedPercent is clamped to 0..400. Supply at least one parallax property. Preserves elements, caption sources, track order, unrelated scenes and unknown feature fields. Requires the active project and expected revision; supports dry run, registry idempotency keys, atomic transactions and undo/redo. Does not change clip source audio or element visibility.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "track",
            "mute",
            "audio",
            "visibility",
            "hide",
            "rename",
            "parallax",
            "camera",
            "speed",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update track controls",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "track edit target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::Unavailable(
                                "track controls require a Classic project".into(),
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
                        let canvas = scene.get("parallax").is_some_and(Value::is_object);
                        let tracks = scene
                            .get_mut("tracks")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("invalid Classic tracks".into())
                            })?;
                        let track = tracks
                            .iter_mut()
                            .find_map(|(key, value)| {
                                if key == "main" && value["id"] == input.track_id {
                                    return value.as_object_mut();
                                }
                                if key == "overlay" || key == "audio" {
                                    return value
                                        .as_array_mut()?
                                        .iter_mut()
                                        .find(|track| track["id"] == input.track_id)?
                                        .as_object_mut();
                                }
                                None
                            })
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(
                                    "Classic track not found in target scene".into(),
                                )
                            })?;
                        apply_change(track, input.change, canvas)?;
                        Ok(vec![input.project_id, input.scene_id, input.track_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Classic track controls")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn apply_change(
    track: &mut Map<String, Value>,
    change: TrackChange,
    canvas: bool,
) -> Result<(), CapabilityError> {
    let (name, muted, hidden) = match change {
        TrackChange::Set {
            name,
            muted,
            hidden,
        } => {
            if name.is_none() && muted.is_none() && hidden.is_none() {
                return Err(CapabilityError::InvalidInput(
                    "set at least one track property".into(),
                ));
            }
            (name, muted, hidden)
        }
        TrackChange::ToggleMute => (
            None,
            Some(!track.get("muted").and_then(Value::as_bool).unwrap_or(false)),
            None,
        ),
        TrackChange::ToggleVisibility => (
            None,
            None,
            Some(
                !track
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        ),
        TrackChange::Parallax {
            direction,
            speed_percent,
        } => {
            if !canvas || track.get("type").and_then(Value::as_str) != Some("parallax") {
                return Err(CapabilityError::InvalidInput(
                    "parallax controls require a parallax marker in a canvas scene".into(),
                ));
            }
            if direction.is_none() && speed_percent.is_none() {
                return Err(CapabilityError::InvalidInput(
                    "set at least one parallax property".into(),
                ));
            }
            if speed_percent.is_some_and(|value| !value.is_finite()) {
                return Err(CapabilityError::InvalidInput(
                    "parallax speed must be finite".into(),
                ));
            }
            if let Some(direction) = direction {
                track.insert(
                    "direction".into(),
                    Value::String(
                        match direction {
                            ParallaxDirection::WithCamera => "with-camera",
                            ParallaxDirection::AgainstCamera => "against-camera",
                        }
                        .into(),
                    ),
                );
            }
            if let Some(speed) = speed_percent {
                track.insert(
                    "speedPercent".into(),
                    serde_json::json!(speed.clamp(0.0, 400.0)),
                );
            }
            return Ok(());
        }
    };
    let kind = track.get("type").and_then(Value::as_str).unwrap_or("");
    if muted.is_some() && !matches!(kind, "video" | "audio") {
        return Err(CapabilityError::InvalidInput(
            "this track type cannot be muted".into(),
        ));
    }
    if hidden.is_some() && !matches!(kind, "video" | "text" | "graphic" | "effect") {
        return Err(CapabilityError::InvalidInput(
            "this track type cannot be hidden".into(),
        ));
    }
    if let Some(name) = name {
        if name.trim().is_empty() || name.len() > 1024 {
            return Err(CapabilityError::InvalidInput(
                "track name must contain 1 to 1024 UTF-8 bytes".into(),
            ));
        }
        track.insert("name".into(), Value::String(name));
    }
    if let Some(value) = muted {
        track.insert("muted".into(), Value::Bool(value));
    }
    if let Some(value) = hidden {
        track.insert("hidden".into(), Value::Bool(value));
    }
    Ok(())
}
