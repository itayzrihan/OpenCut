//! Shared podcast finishing policy; Classic UI and agents use the same transaction.
use super::classic_scenes::classic_target;
use super::*;
use serde_json::json;

fn invalid(s: &str) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 32))]
    microphone_track_ids: Vec<String>,
    #[schemars(length(min = 1, max = 32))]
    camera_track_ids: Vec<String>,
}

pub(super) fn finish(
    scene: &mut Value,
    microphones: &[String],
    cameras: &[String],
    effect_id: String,
    track_id: String,
) -> Result<(), CapabilityError> {
    let tracks = &mut scene["tracks"];
    let ids: HashSet<_> = microphones.iter().chain(cameras).collect();
    if ids.len() != microphones.len() + cameras.len() {
        return Err(invalid("Duplicate podcast track IDs"));
    }
    for id in &ids {
        let track = all(tracks)
            .find(|t| t["id"] == **id)
            .ok_or_else(|| invalid("Podcast track not found"))?;
        let expected = if microphones.contains(id) {
            "audio"
        } else {
            "video"
        };
        if track["type"] != expected || track["locked"] == true {
            return Err(invalid(
                "Podcast tracks must have the correct type and be unlocked",
            ));
        }
    }
    let duration = all(tracks)
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter_map(|e| Some(e["startTime"].as_i64()? + e["duration"].as_i64()?))
        .max()
        .unwrap_or(0);
    if duration <= 0 {
        return Err(invalid("Podcast scene is empty"));
    }
    // Apply once to each clip. Splits retain the marker, so later reapplication
    // cannot stack gain or reset an editor's subsequent manual adjustments.
    for bucket in ["overlay", "audio"] {
        for track in tracks[bucket].as_array_mut().unwrap() {
            if microphones.iter().any(|id| track["id"] == *id) {
                for e in track["elements"].as_array_mut().unwrap() {
                    if e["podcastFinishingVersion"] == 1 {
                        continue;
                    }
                    let gain = e["params"]["gainDb"].as_f64().unwrap_or(0.0) - 1.0;
                    let p = e["params"]
                        .as_object_mut()
                        .ok_or_else(|| invalid("Audio parameters missing"))?;
                    for (key, value) in [
                        ("volume", json!(15)),
                        ("gainDb", json!(gain.max(-60.0))),
                        ("noiseReduction", json!(100)),
                        ("hardLimiterEnabled", json!(true)),
                        ("hardLimiterCeilingDb", json!(-1)),
                        ("hardLimiterLookAheadMs", json!(7)),
                        ("hardLimiterReleaseMs", json!(100)),
                    ] {
                        p.insert(key.into(), value);
                    }
                    e["podcastFinishingVersion"] = json!(1);
                }
            }
            if cameras.iter().any(|id| track["id"] == *id) {
                mute_camera(track);
            }
        }
    }
    if cameras.iter().any(|id| tracks["main"]["id"] == *id) {
        mute_camera(&mut tracks["main"]);
    }
    let has_sharpen = all(tracks)
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .any(|e| {
            e["effectType"] == "sharpen"
                && e["startTime"] == 0
                && e["duration"].as_i64().is_some_and(|d| d >= duration)
                && e["enabled"] != false
        });
    if !has_sharpen {
        tracks["overlay"].as_array_mut().unwrap().insert(0,json!({"id":track_id,"type":"effect","name":"Podcast Sharpen","hidden":false,"elements":[{"id":effect_id,"type":"effect","name":"Sharpen","effectType":"sharpen","startTime":0,"duration":duration,"trimStart":0,"trimEnd":0,"params":{"intensity":15},"podcastFinishingVersion":1}]}));
        if let Some(order) = tracks["order"].as_array_mut() {
            order.insert(0, json!(track_id));
        }
    }
    Ok(())
}
fn mute_camera(track: &mut Value) {
    track["muted"] = json!(true);
    for e in track["elements"].as_array_mut().unwrap() {
        if e["type"] == "video" {
            e["isSourceAudioEnabled"] = json!(false);
        }
    }
}
pub(super) fn register_podcast_finish(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.finish",
        "Apply podcast finishing preset",
        "Finish explicit podcast microphone and camera tracks without recutting or resynchronizing an existing edit. Sets microphone Volume to +15 dB, adjusts Gain by -1 dB once, enables a -1 dB sample-peak hard limiter (7 ms lookahead/100 ms release), sets noise reduction to 100%, mutes camera source audio and adds one full-scene Sharpen 15% layer if absent. Preserves camera enabled/disabled routing, source offsets, cuts, intro music, captions and all unrelated tracks. Clip markers prevent repeated gain adjustments. IDs must be explicit audio/video tracks. Locked targets reject atomically. Supports revision, dry run, idempotency, cancellation and Undo/Redo. Bridged Classic policy; host processes audio locally.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic", "podcast", "finish", "audio", "limiter", "gain", "sharpen",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Finish podcast",
                    Some(input.expected_revision),
                    |document| {
                        let mut occupied = HashSet::new();
                        collect_ids(&serde_json::to_value(&*document).unwrap(), &mut occupied);
                        let effect = super::classic_duplicate::fresh(
                            document,
                            &mut occupied,
                            "podcast-sharpen",
                        );
                        let track = super::classic_duplicate::fresh(
                            document,
                            &mut occupied,
                            "podcast-effects",
                        );
                        let classic = classic_target(document, &input.project_id)?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .and_then(|s| s.iter_mut().find(|s| s["id"] == input.scene_id))
                            .ok_or_else(|| invalid("Scene not found"))?;
                        finish(
                            scene,
                            &input.microphone_track_ids,
                            &input.camera_track_ids,
                            effect,
                            track,
                        )?;
                        Ok(vec![input.project_id.clone(), input.scene_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Applied podcast finishing preset")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
