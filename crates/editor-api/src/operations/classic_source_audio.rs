//! Source-audio extraction/recovery for the real Classic timeline.
use super::classic_duplicate::{clone_animation, fresh};
use super::classic_track_layout::{
    ClassicTrackType, LayoutChange, apply_layout, display_track_index,
};
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum SourceAudioAction {
    /// Copy the video's audio into a free audio lane and disable its embedded audio.
    Extract,
    ExtractLinked,
    Link,
    Unlink,
    ReplaceWithStem,
    SplitDialogueStems,
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
    audio_element_id: Option<String>,
    media_id: Option<String>,
    dialogue_media_id: Option<String>,
    source_offset: Option<i64>,
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
        "Split, link or recover Classic source audio",
        "extractLinked splits embedded audio into a separate track, disables the embedded sound and links the aligned clips. extract keeps the historical independent behavior. link takes audioElementId with an aligned video target; unlink can target either clip. Linked pairs move, trim and split together. recover re-enables embedded audio and retains extracted clips. replaceWithStem takes a registered audio mediaId and sourceOffset in source ticks for the target audio clip, keeping its timeline placement and link. splitDialogueStems takes a registered background mediaId and a distinct dialogueMediaId, uses the same sourceOffset for both, and inserts an independent, aligned dialogue clip immediately above the background clip. Extraction copies trims, source duration, retime, offsets, fades and volume keyframes. Requires project, scene, track, clip and revision. Supports dry run, idempotency, transactions and undo/redo. Does not decode or write media files.",
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
                        outcome = apply_source_audio(document, &input, false)?;
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

fn scene_mut<'a>(
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
        .ok_or_else(|| invalid("source audio scene not found"))
}

fn tracks_mut<'a>(
    document: &'a mut EditorDocument,
    input: &SourceAudioInput,
) -> Result<&'a mut Value, CapabilityError> {
    scene_mut(document, input)?
        .get_mut("tracks")
        .ok_or_else(|| invalid("source audio tracks not found"))
}

pub(super) fn track_mut<'a>(tracks: &'a mut Value, id: &str) -> Option<&'a mut Value> {
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

pub(super) const LINK: &str = "linkedAudioVideoId";

pub(super) fn find_clip<'a>(tracks: &'a Value, id: &str) -> Option<(&'a Value, &'a Value)> {
    std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().into_iter().flatten())
        .chain(tracks["audio"].as_array().into_iter().flatten())
        .find_map(|track| {
            track["elements"]
                .as_array()?
                .iter()
                .find(|clip| clip["id"] == id)
                .map(|clip| (track, clip))
        })
}

pub(super) fn peer<'a>(tracks: &'a Value, clip: &Value) -> Option<(&'a Value, &'a Value)> {
    let (track, other) = find_clip(tracks, clip[LINK].as_str()?)?;
    (other[LINK] == clip["id"]
        && matches!(
            (clip["type"].as_str(), other["type"].as_str()),
            (Some("video"), Some("audio")) | (Some("audio"), Some("video"))
        ))
    .then_some((track, other))
}

fn clip_mut<'a>(tracks: &'a mut Value, track: &str, clip: &str) -> Option<&'a mut Value> {
    track_mut(tracks, track)?["elements"]
        .as_array_mut()?
        .iter_mut()
        .find(|element| element["id"] == clip)
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

fn bind_stem(
    document: &EditorDocument,
    clip: &mut Value,
    media_id: &str,
    offset: i64,
) -> Result<String, CapabilityError> {
    let asset = document
        .project
        .as_ref()
        .and_then(|project| project.classic.as_ref())
        .and_then(|classic| {
            classic.media_assets.iter().find(|asset| {
                asset["id"] == media_id
                    && asset["type"] == "audio"
                    && asset.get("missing") != Some(&Value::Bool(true))
            })
        })
        .ok_or_else(|| invalid("The audio stem is not available in this project"))?;
    let duration = (asset["duration"]
        .as_f64()
        .filter(|value| *value > 0.0 && *value <= 60.0)
        .ok_or_else(|| invalid("The stem has no bounded duration"))?
        * 120_000.0)
        .round() as i64;
    let span =
        (clip["duration"].as_i64().unwrap() as f64 * classic_update::rate(clip)).round() as i64;
    let trim_end = duration
        .checked_sub(offset)
        .and_then(|n| n.checked_sub(span))
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("The audio stem is shorter than the selected source range"))?;
    clip["mediaId"] = json!(media_id);
    clip["sourceDuration"] = json!(duration);
    clip["trimStart"] = json!(offset);
    clip["trimEnd"] = json!(trim_end);
    for key in ["audioSyncOffset", "sourceAudioOffsetSeconds"] {
        clip["params"].as_object_mut().unwrap().remove(key);
    }
    Ok(asset
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(media_id)
        .to_owned())
}

fn apply_stems(
    document: &mut EditorDocument,
    input: &SourceAudioInput,
    source: Value,
) -> Result<SourceAudioOutcome, CapabilityError> {
    let media_id = input
        .media_id
        .as_deref()
        .ok_or_else(|| invalid("An audio stem media ID is required"))?;
    let offset = input
        .source_offset
        .filter(|offset| *offset >= 0)
        .ok_or_else(|| invalid("A nonnegative stem source offset is required"))?;
    if source["type"] != "audio" || source["sourceType"] != "upload" {
        return Err(invalid("A bounded uploaded audio clip is required"));
    }
    let mut background = source.clone();
    let background_name = bind_stem(document, &mut background, media_id, offset)?;
    if matches!(input.action, SourceAudioAction::ReplaceWithStem) {
        *source_mut(tracks_mut(document, input)?, input)? = background;
        return Ok(SourceAudioOutcome::default());
    }

    let dialogue_media_id = input
        .dialogue_media_id
        .as_deref()
        .filter(|id| *id != media_id)
        .ok_or_else(|| invalid("A distinct dialogue stem media ID is required"))?;
    let mut dialogue = source;
    let dialogue_name = bind_stem(document, &mut dialogue, dialogue_media_id, offset)?;
    background["name"] = json!(background_name);
    dialogue["name"] = json!(dialogue_name);
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).map_err(|error| invalid(&error.to_string()))?,
        &mut occupied,
    );
    let dialogue_id = fresh(document, &mut occupied, "classic-audio");
    let track_id = fresh(document, &mut occupied, "classic-audio-track");
    dialogue["id"] = json!(dialogue_id);
    let dialogue_fields = dialogue.as_object_mut().unwrap();
    dialogue_fields.remove(LINK);
    dialogue_fields.remove("takeGroup");
    clone_animation(document, &mut occupied, &mut dialogue)?;

    let scene = scene_mut(document, input)?;
    let index = display_track_index(&scene["tracks"], &input.track_id)
        .ok_or_else(|| invalid("Source audio track is not in the scene"))?;
    apply_layout(
        scene,
        LayoutChange::Add {
            track_id: track_id.clone(),
            track_type: ClassicTrackType::Audio,
            name: Some("Speech".into()),
            index: Some(index),
        },
    )?;
    let tracks = &mut scene["tracks"];
    let muted = track_mut(tracks, &input.track_id).unwrap()["muted"] == true;
    let track = track_mut(tracks, &track_id).unwrap();
    track.as_object_mut().unwrap().remove("keepEmpty");
    track["muted"] = json!(muted);
    track["elements"] = json!([dialogue]);
    *source_mut(tracks, input)? = background;
    Ok(SourceAudioOutcome {
        audio_element_id: Some(dialogue_id),
        audio_track_id: Some(track_id),
        ..Default::default()
    })
}

fn apply_source_audio(
    document: &mut EditorDocument,
    input: &SourceAudioInput,
    preserve_audibility: bool,
) -> Result<SourceAudioOutcome, CapabilityError> {
    let source = source_mut(tracks_mut(document, input)?, input)?.clone();
    if matches!(
        input.action,
        SourceAudioAction::ReplaceWithStem | SourceAudioAction::SplitDialogueStems
    ) {
        return apply_stems(document, input, source);
    }
    if matches!(input.action, SourceAudioAction::Unlink) {
        let tracks = tracks_mut(document, input)?;
        if let Some((track, other)) = peer(tracks, &source) {
            let track = track["id"].as_str().unwrap().to_owned();
            let id = other["id"].as_str().unwrap().to_owned();
            clip_mut(tracks, &track, &id)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(LINK);
        }
        source_mut(tracks, input)?
            .as_object_mut()
            .unwrap()
            .remove(LINK);
        return Ok(SourceAudioOutcome {
            source_audio_enabled: source["isSourceAudioEnabled"] != false,
            ..Default::default()
        });
    }
    if source["type"] != "video" {
        return Err(invalid("source audio requires a video element"));
    }
    let enabled = source["isSourceAudioEnabled"] != false;
    if matches!(input.action, SourceAudioAction::Link) {
        let id = input
            .audio_element_id
            .as_deref()
            .ok_or_else(|| invalid("Choose an audio clip to link"))?;
        let tracks = tracks_mut(document, input)?;
        let (audio_track, audio) =
            find_clip(tracks, id).ok_or_else(|| invalid("Audio clip not found"))?;
        if audio["type"] != "audio"
            || audio["startTime"] != source["startTime"]
            || audio["duration"] != source["duration"]
        {
            return Err(invalid(
                "Audio and video must have the same timeline start and duration to link",
            ));
        }
        if peer(tracks, &source).is_some() || peer(tracks, audio).is_some() {
            return Err(invalid(
                "Unlink the existing pair before linking another clip",
            ));
        }
        let track = audio_track["id"].as_str().unwrap().to_owned();
        clip_mut(tracks, &track, id).unwrap()[LINK] = json!(input.element_id);
        source_mut(tracks, input)?[LINK] = json!(id);
        return Ok(SourceAudioOutcome {
            source_audio_enabled: enabled,
            audio_element_id: Some(id.to_owned()),
            audio_track_id: Some(track),
        });
    }
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
    let linked = matches!(input.action, SourceAudioAction::ExtractLinked);
    if linked {
        audio[LINK] = json!(input.element_id);
    }
    if linked || preserve_audibility {
        if let Some(enabled) = source.get("enabled") {
            audio["enabled"] = enabled.clone();
        }
    }
    // These parameters feed the same native timing/gain adapters in playback
    // and export. Dropping an offset changes the source sample after extraction;
    // dropping fades makes an otherwise identical source audible differently.
    for key in [
        "audioSyncOffset",
        "sourceAudioOffsetSeconds",
        "fadeInDuration",
        "fadeOutDuration",
        "noiseReduction",
        "gainDb",
        "hardLimiterEnabled",
        "hardLimiterCeilingDb",
        "hardLimiterLookAheadMs",
        "hardLimiterReleaseMs",
    ] {
        if let Some(value) = source["params"].get(key) {
            audio["params"][key] = value.clone();
        }
    }
    if let Some(value) = source.get("podcastFinishingVersion") {
        audio["podcastFinishingVersion"] = value.clone();
    }
    if let Some(value) = source.get("sourceDuration") {
        audio["sourceDuration"] = value.clone();
    }
    if let Some(retime) = source.get("retime").filter(|v| !v.is_null()) {
        let mut selected = Map::new();
        for key in ["rate", "maintainPitch", "speedKeyframes"] {
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
                    && (!preserve_audibility || (track["locked"] != true && track["muted"] != true))
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
    let video = source_mut(tracks, input)?;
    video["isSourceAudioEnabled"] = json!(false);
    if linked {
        video[LINK] = json!(audio_id);
    }
    Ok(SourceAudioOutcome {
        source_audio_enabled: false,
        audio_element_id: Some(audio_id),
        audio_track_id: Some(track_id),
    })
}

/// Preserve embedded sound before a visual source change. Keep any existing
/// linked peer intact rather than replacing its reciprocal link.
pub(super) fn preserve_for_video_replacement(
    document: &mut EditorDocument,
    project_id: &str,
    scene_id: &str,
    track_id: &str,
    element_id: &str,
    already_linked: bool,
    muted_track: bool,
) -> Result<Vec<String>, CapabilityError> {
    let input = SourceAudioInput {
        project_id: project_id.into(),
        scene_id: scene_id.into(),
        track_id: track_id.into(),
        element_id: element_id.into(),
        expected_revision: document.revision,
        action: if already_linked {
            SourceAudioAction::Extract
        } else {
            SourceAudioAction::ExtractLinked
        },
        audio_element_id: None,
        media_id: None,
        dialogue_media_id: None,
        source_offset: None,
    };
    let outcome = apply_source_audio(document, &input, true)?;
    if muted_track {
        if let (Some(track_id), Some(audio_id)) =
            (&outcome.audio_track_id, &outcome.audio_element_id)
        {
            if let Some(audio) = clip_mut(tracks_mut(document, &input)?, track_id, audio_id) {
                audio["params"]["muted"] = json!(true);
            }
        }
    }
    Ok(outcome
        .audio_element_id
        .into_iter()
        .chain(outcome.audio_track_id)
        .collect())
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
