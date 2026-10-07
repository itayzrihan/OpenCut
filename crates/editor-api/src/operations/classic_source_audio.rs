//! Source-audio extraction/recovery for the real Classic timeline.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum SourceAudioAction {
    /// Copy the video's audio into a free audio lane and disable its embedded audio.
    Extract,
    /// Re-enable embedded audio. Existing extracted clips are intentionally retained.
    Recover,
    /// UI gesture: recover if disabled; otherwise extract.
    Toggle,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceAudioInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    expected_revision: u64,
    action: SourceAudioAction,
}

#[derive(Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourceAudioOutcome {
    source_audio_enabled: bool,
    audio_element_id: Option<String>,
    audio_track_id: Option<String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourceAudioOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    #[serde(flatten)]
    outcome: SourceAudioOutcome,
}

pub(super) fn register_classic_source_audio(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<SourceAudioInput, SourceAudioOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.audio.source.edit",
        "Extract or recover Classic source audio",
        "Extract a video's embedded audio into the first non-overlapping audio track in display order, or create an Audio track at the top. Copies media binding, timeline ticks, trims, source duration, speed/pitch, volume/mute and volume keyframes with independent IDs; disables embedded audio on the video. Recover only re-enables embedded audio and retains extracted clips, so both can play; it is not a merge or deletion. Prefer explicit extract/recover for plans; toggle is for UI gestures. Extract requires a media binding whose hasAudio is not false, positive duration and enabled source audio. Read explicit scene/track/element IDs via app.state.read. Returns created IDs, supports dry run, registry retries, revision checks, transactions and undo/redo. Does not decode or write media files.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic", "audio", "extract", "separate", "recover", "video", "detach",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut outcome = SourceAudioOutcome::default();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit source audio",
                    Some(input.expected_revision),
                    |document| {
                        outcome = apply_source_audio(document, &input)?;
                        let mut ids = vec![
                            input.project_id.clone(),
                            input.scene_id.clone(),
                            input.track_id.clone(),
                            input.element_id.clone(),
                        ];
                        ids.extend(outcome.audio_element_id.iter().cloned());
                        ids.extend(outcome.audio_track_id.iter().cloned());
                        Ok(ids)
                    },
                )?;
                Ok(
                    OperationSuccess::new(SourceAudioOutput { mutation, outcome })
                        .summary("Updated Classic source audio")
                        .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]),
                )
            }
        },
    )
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

fn tracks_mut<'a>(
    document: &'a mut EditorDocument,
    input: &SourceAudioInput,
) -> Result<&'a mut Value, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(CapabilityError::Conflict(
            "source audio target project is not active".into(),
        ));
    }
    project
        .classic
        .as_mut()
        .ok_or_else(|| {
            CapabilityError::Unavailable("source audio requires a Classic project".into())
        })?
        .document
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .and_then(|scenes| {
            scenes
                .iter_mut()
                .find(|scene| scene["id"] == input.scene_id)
        })
        .and_then(|scene| scene.get_mut("tracks"))
        .ok_or_else(|| invalid("source audio scene not found"))
}

fn track_mut<'a>(tracks: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    tracks.as_object_mut()?.iter_mut().find_map(|(key, value)| {
        if key == "main" && value["id"] == id {
            return Some(value);
        }
        if key == "overlay" || key == "audio" {
            return value
                .as_array_mut()?
                .iter_mut()
                .find(|track| track["id"] == id);
        }
        None
    })
}

fn source_mut<'a>(
    tracks: &'a mut Value,
    input: &SourceAudioInput,
) -> Result<&'a mut Value, CapabilityError> {
    track_mut(tracks, &input.track_id)
        .and_then(|track| track.get_mut("elements"))
        .and_then(Value::as_array_mut)
        .and_then(|elements| {
            elements
                .iter_mut()
                .find(|element| element["id"] == input.element_id)
        })
        .ok_or_else(|| invalid("source video not found in target track"))
}


fn apply_source_audio(
    document: &mut EditorDocument,
    input: &SourceAudioInput,
) -> Result<SourceAudioOutcome, CapabilityError> {
    let source = source_mut(tracks_mut(document, input)?, input)?.clone();
    if source["type"] != "video" {
        return Err(invalid("source audio requires a video element"));
    }
    let enabled = source["isSourceAudioEnabled"] != false;
    if matches!(input.action, SourceAudioAction::Recover)
        || (!enabled && matches!(input.action, SourceAudioAction::Toggle))
    {
        source_mut(tracks_mut(document, input)?, input)?["isSourceAudioEnabled"] = json!(true);
        return Ok(SourceAudioOutcome {
            source_audio_enabled: true,
            ..Default::default()
        });
    }
    if !enabled {
        return Err(invalid(
            "source audio is already disabled; recover it before extracting again",
        ));
    }
    let classic = document.project.as_ref().unwrap().classic.as_ref().unwrap();
    if !classic.media_assets.iter().any(|asset| {
        asset.get("id") == source.get("mediaId") && asset.get("hasAudio") != Some(&json!(false))
    }) {
        return Err(invalid("source media is missing or has no audio"));
    }
    let start = source["startTime"]
        .as_i64()
        .ok_or_else(|| invalid("invalid source start time"))?;
    let duration = source["duration"]
        .as_i64()
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("source audio duration must be positive"))?;
    let mut occupied = HashSet::new();
    for scene in classic.scenes().map_err(|e| invalid(&e.to_string()))? {
        collect_ids(scene, &mut occupied);
    }
    let mut allocate = |prefix| loop {
        let id = document.allocate_id(prefix);
        if occupied.insert(id.clone()) {
            break id;
        }
    };
    let audio_id = allocate("classic-audio");
    let mut audio = json!({
        "id":audio_id, "type":"audio", "sourceType":"upload", "mediaId":source["mediaId"],
        "name":source["name"], "duration":duration, "startTime":start,
        "trimStart":source["trimStart"], "trimEnd":source["trimEnd"],
        "params":{"volume":source["params"].get("volume").filter(|v| v.is_number()).cloned().unwrap_or(json!(0)), "muted":source["params"]["muted"] == true}
    });
    if let Some(value) = source.get("sourceDuration") {
        audio["sourceDuration"] = value.clone();
    }
    if let Some(retime) = source.get("retime").filter(|v| !v.is_null()) {
        let mut selected = Map::new();
        for key in ["rate", "maintainPitch"] {
            if let Some(value) = retime.get(key) {
                selected.insert(key.into(), value.clone());
            }
        }
        audio["retime"] = Value::Object(selected);
    }
    if let Some(volume) = source
        .get("animations")
        .and_then(|v| v.get("volume"))
        .filter(|value| !value.is_null())
        && let Some(volume) = clone_volume(volume, &mut || allocate("classic-volume-key"))?
    {
        audio["animations"] = json!({"volume":volume});
    }
    // Reserve before borrowing the timeline; unused IDs are harmless and make
    // allocation deterministic across dry run, actual invoke and exact retries.
    let new_track_id = allocate("classic-audio-track");
    let tracks = tracks_mut(document, input)?;
    let all: Vec<&Value> = tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
        .collect();
    let mut order: Vec<String> = Vec::new();
    for id in tracks["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(all.iter().filter_map(|track| track["id"].as_str()))
    {
        if all.iter().any(|track| track["id"] == id) && !order.iter().any(|known| known == id) {
            order.push(id.into());
        }
    }
    let target = order
        .iter()
        .find(|id| {
            all.iter().any(|track| {
                track["id"] == **id
                    && track["type"] == "audio"
                    && track["elements"].as_array().is_some_and(|elements| {
                        elements.iter().all(|element| {
                            let other_start = element["startTime"].as_i64().unwrap();
                            let other_end = other_start + element["duration"].as_i64().unwrap();
                            !(start < other_end && start + duration > other_start)
                        })
                    })
            })
        })
        .cloned();
    let track_id = target.unwrap_or_else(|| new_track_id.clone());
    if track_id == new_track_id {
        tracks["audio"].as_array_mut().ok_or_else(|| invalid("invalid audio tracks"))?.insert(0, json!({"id":track_id,"name":"Audio track","type":"audio","muted":false,"elements":[]}));
        order.insert(0, track_id.clone());
        tracks["order"] = json!(order);
    }
    track_mut(tracks, &track_id).unwrap()["elements"]
        .as_array_mut()
        .unwrap()
        .push(audio);
    source_mut(tracks, input)?["isSourceAudioEnabled"] = json!(false);
    Ok(SourceAudioOutcome {
        source_audio_enabled: false,
        audio_element_id: Some(audio_id),
        audio_track_id: Some(track_id),
    })
}

/// Volume copies retain curve metadata, sort keys stably, clamp scalar handles
/// to adjacent keys and regenerate shared key identities across channel components.
fn clone_volume(
    volume: &Value,
    allocate: &mut impl FnMut() -> String,
) -> Result<Option<Value>, CapabilityError> {
    let mut volume = volume.clone();
    let mut ids = BTreeMap::new();
    let mut has_keys = false;
    let mut channel = |channel: &mut Value| -> Result<(), CapabilityError> {
        let scalar = channel.get("extrapolation").is_some()
            || channel["keys"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|key| key.get("segmentToNext").is_some()));
        let keys = channel
            .get_mut("keys")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| invalid("volume animation channel must contain keys"))?;
        has_keys |= !keys.is_empty();
        for key in keys.iter_mut() {
            let id = key["id"]
                .as_str()
                .ok_or_else(|| invalid("volume keyframe ID is required"))?
                .to_owned();
            let time = key["time"]
                .as_i64()
                .ok_or_else(|| invalid("volume keyframe time must be integer ticks"))?;
            if !(0..=crate::classic::MAX_SAFE_INTEGER).contains(&time) {
                return Err(invalid("invalid volume keyframe time"));
            }
            key["id"] = json!(ids.entry(id).or_insert_with(&mut *allocate));
            if scalar {
                let key = key.as_object_mut().unwrap();
                for (property, default) in [("tangentMode", "flat"), ("segmentToNext", "linear")] {
                    if key.get(property).is_none_or(Value::is_null) {
                        key.insert(property.into(), json!(default));
                    }
                }
            }
        }
        keys.sort_by_key(|key| key["time"].as_i64().unwrap());
        if scalar {
            let times: Vec<i64> = keys
                .iter()
                .map(|key| key["time"].as_i64().unwrap())
                .collect();
            for (index, key) in keys.iter_mut().enumerate() {
                for (property, neighbor, sign) in [
                    ("leftHandle", index.checked_sub(1), -1_i64),
                    (
                        "rightHandle",
                        (index + 1 < times.len()).then_some(index + 1),
                        1_i64,
                    ),
                ] {
                    if neighbor.is_none() || key.get(property).is_some_and(Value::is_null) {
                        key.as_object_mut().unwrap().remove(property);
                        continue;
                    }
                    if let Some(handle) = key.get_mut(property) {
                        let span = (times[index] - times[neighbor.unwrap()]).abs().max(1);
                        let dt = handle["dt"]
                            .as_i64()
                            .ok_or_else(|| invalid("volume handle time must be integer ticks"))?;
                        let dv = handle["dv"]
                            .as_f64()
                            .ok_or_else(|| invalid("volume handle delta must be numeric"))?;
                        *handle = json!({"dt":dt.clamp(if sign < 0 {-span} else {0}, if sign < 0 {0} else {span}), "dv":dv});
                    }
                }
            }
        }
        Ok(())
    };
    if volume.get("keys").is_some_and(Value::is_array) {
        channel(&mut volume)?;
    } else if let Some(components) = volume.as_object_mut() {
        components.retain(|_, value| !value.is_null());
        for value in components.values_mut().filter(|value| !value.is_null()) {
            channel(value)?;
        }
    } else {
        return Err(invalid("invalid volume animation"));
    }
    Ok(has_keys.then_some(volume))
}
