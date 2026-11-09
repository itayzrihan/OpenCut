//! Swap a video's source in place without changing the edit's timeline clock.
use super::{classic_source_audio, *};
use crate::CLASSIC_TICKS_PER_SECOND;
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    scene_id: String,
    track_id: String,
    element_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    project_id: String,
    expected_revision: u64,
    target: Target,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    project_id: String,
    expected_revision: u64,
    target: Target,
    anchor: String,
    media_id: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Plan {
    anchor: String,
    duration_ticks: i64,
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

fn scene<'a>(
    classic: &'a crate::ClassicProject,
    target: &Target,
) -> Result<&'a Value, CapabilityError> {
    classic.document["scenes"]
        .as_array()
        .and_then(|scenes| scenes.iter().find(|s| s["id"] == target.scene_id))
        .ok_or_else(|| invalid("The original scene is unavailable"))
}

fn project<'a>(
    document: &'a EditorDocument,
    project_id: &str,
) -> Result<&'a crate::ClassicProject, CapabilityError> {
    document
        .project
        .as_ref()
        .filter(|p| p.id == project_id)
        .and_then(|p| p.classic.as_ref())
        .ok_or_else(|| invalid("Open the original Classic project to replace the clip"))
}

fn clip<'a>(scene: &'a Value, target: &Target) -> Result<(&'a Value, &'a Value), CapabilityError> {
    let (track, clip) = classic_source_audio::find_clip(&scene["tracks"], &target.element_id)
        .filter(|(track, clip)| track["id"] == target.track_id && clip["type"] == "video")
        .ok_or_else(|| invalid("The selected video is no longer on its original track"))?;
    if track["locked"] == true {
        return Err(invalid("Unlock the video track before replacing this clip"));
    }
    if !clip["takeGroup"].is_null() || !clip["unifiedAngleId"].is_null() {
        return Err(invalid(
            "Replace requires a regular video clip; resolve the take or angle first",
        ));
    }
    Ok((track, clip))
}

fn source_media<'a>(
    classic: &'a crate::ClassicProject,
    clip: &Value,
) -> Result<&'a Map<String, Value>, CapabilityError> {
    let source = classic
        .media_assets
        .iter()
        .find(|asset| asset["id"] == clip["mediaId"])
        .ok_or_else(|| invalid("The selected clip's source is unavailable"))?;
    if source
        .get("unifiedAngles")
        .is_some_and(|angles| !angles.is_null())
    {
        return Err(invalid(
            "Replace requires a regular video clip; resolve the take or angle first",
        ));
    }
    Ok(source)
}

fn plan(track: &Value, clip: &Value, source: &Map<String, Value>) -> Result<Plan, CapabilityError> {
    let duration_ticks = clip["duration"]
        .as_i64()
        .filter(|d| *d > 0)
        .ok_or_else(|| invalid("The selected clip has no playable duration"))?;
    let bytes = serde_json::to_vec(&(clip, &track["muted"], source.get("bindingRevision")))
        .map_err(|_| invalid("Could not read the selected clip"))?;
    Ok(Plan {
        anchor: format!("{:x}", Sha256::digest(bytes)),
        duration_ticks,
    })
}

fn apply(document: &mut EditorDocument, input: &Replace) -> Result<Vec<String>, CapabilityError> {
    let target = &input.target;
    let classic = project(document, &input.project_id)?;
    let (track, clip) = clip(scene(classic, target)?, target)?;
    let original = source_media(classic, clip)?;
    let current = plan(track, clip, original)?;
    if current.anchor != input.anchor {
        return Err(CapabilityError::Conflict(
            "The original clip changed after Replace was prepared".into(),
        ));
    }
    let media = classic
        .media_assets
        .iter()
        .find(|a| a["id"] == input.media_id && a["type"] == "video" && a["id"] != clip["mediaId"])
        .ok_or_else(|| invalid("Import a different generated video before replacing the clip"))?;
    let source = media["duration"]
        .as_f64()
        .map(|d| (d * CLASSIC_TICKS_PER_SECOND as f64).round())
        .filter(|d| (1.0..=9_007_199_254_740_991.0).contains(d))
        .ok_or_else(|| invalid("The replacement video has no usable duration"))?
        as i64;
    let name = media
        .get("name")
        .cloned()
        .unwrap_or(json!("AI replacement"));
    let used = source.min(current.duration_ticks.saturating_mul(5));
    let rate = used as f64 / current.duration_ticks as f64;
    if rate < 0.01 {
        return Err(invalid("The generated video is too short for this clip"));
    }
    let preserve_audio =
        clip["isSourceAudioEnabled"] != false && original.get("hasAudio") != Some(&json!(false));
    let mut changed = vec![target.element_id.clone()];
    if preserve_audio {
        let linked = !clip[classic_source_audio::LINK].is_null();
        let muted = track["muted"] == true;
        changed.extend(classic_source_audio::preserve_for_video_replacement(
            document,
            &input.project_id,
            &target.scene_id,
            &target.track_id,
            &target.element_id,
            linked,
            muted,
        )?);
    }
    let classic = project_mut(document)?.classic.as_mut().unwrap();
    let scene = classic.document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == target.scene_id)
        .unwrap();
    let tracks = &mut scene["tracks"];
    let track = classic_source_audio::track_mut(tracks, &target.track_id).unwrap();
    let clip = track["elements"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == target.element_id)
        .unwrap();
    clip["mediaId"] = json!(input.media_id);
    clip["name"] = name;
    clip["sourceDuration"] = json!(source);
    clip["trimStart"] = json!(0);
    clip["trimEnd"] = json!(source - used);
    clip["isSourceAudioEnabled"] = json!(false);
    let fields = clip.as_object_mut().unwrap();
    fields.remove("loop");
    if used == current.duration_ticks {
        fields.remove("retime");
    } else {
        fields.insert("retime".into(), json!({"rate": rate}));
    }
    Ok(changed)
}

pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let reader = state.clone();
    super::register::<Read, Plan, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.replace.plan",
        "Read the selected video replacement span",
        "Read the exact selected Classic video duration (120000 ticks/second) and a clip anchor. No network calls.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["video", "replace"],
        move |_, input| {
            let reader = reader.clone();
            async move {
                let store = reader.read().map_err(|_| invalid("State lock poisoned"))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict("The timeline changed".into()));
                }
                let target = &input.target;
                let classic = project(&store.document, &input.project_id)?;
                let (track, clip) = clip(scene(classic, target)?, target)?;
                Ok(OperationSuccess::new(plan(
                    track,
                    clip,
                    source_media(classic, clip)?,
                )?))
            }
        },
    )?;
    super::register::<Replace, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.replace.apply",
        "Replace a Classic video's source in place",
        "Use timeline.classic.replace.plan for the anchor. Swap an imported video into the same exact clip span, fit its playback speed, and preserve original audio and adjacent edits. Atomic, revision checked, dry run, idempotent and undoable. No network calls.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["video", "replace"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Replace video",
                    Some(input.expected_revision),
                    |document| apply(document, &input),
                )?;
                Ok(OperationSuccess::new(mutation).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}
