//! Bridged Classic Unified Angles. Audio decoding stays in the host; offsets,
//! provenance, source bounds, angle switching and history live in the runtime.
use super::*;
use classic_podcast::{
    CameraClockOptions, CameraRangeOptions, CameraSource, podcast_camera_clock,
    unified_camera_range,
};
use serde_json::json;
use std::collections::HashMap;
mod task;

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AudioSync {
    pub method: String,
    pub reference_asset_id: String,
    pub sources: Vec<CameraSource>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Unified {
    pub version: u8,
    pub angle_asset_ids: Vec<String>,
    pub default_angle_asset_id: String,
    pub audio_asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<AudioSync>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_task: Option<task::SyncTask>,
}
fn invalid(s: &str) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
pub(crate) fn metadata(asset: &Map<String, Value>) -> Result<Option<Unified>, String> {
    asset
        .get("unifiedAngles")
        .filter(|v| v.get("version").and_then(Value::as_u64) == Some(1))
        .map(|v| serde_json::from_value(v.clone()).map_err(|e| e.to_string()))
        .transpose()
}
pub(crate) fn sync_current(u: &Unified, assets: &[Map<String, Value>]) -> bool {
    u.sync.as_ref().is_some_and(|sync| {
        classic_podcast::unified_camera_sources_current(
            classic_podcast::CameraSourcesCurrentOptions {
                recorded: sync.sources.clone(),
                current: sync
                    .sources
                    .iter()
                    .filter_map(|s| {
                        assets
                            .iter()
                            .find(|a| {
                                a["id"] == s.id
                                    && a.get("missing").and_then(Value::as_bool) != Some(true)
                            })
                            .map(|a| CameraSource {
                                id: s.id.clone(),
                                duration: a.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
                                start: 0.0,
                                binding_revision: a
                                    .get("bindingRevision")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                            })
                    })
                    .collect(),
            },
        )
    })
}

pub(crate) fn validate_assets(assets: &[Map<String, Value>]) -> Result<(), String> {
    for asset in assets {
        let Some(u) = metadata(asset)? else { continue };
        let unique: HashSet<_> = u.angle_asset_ids.iter().collect();
        if asset["type"] != "video"
            || u.version != 1
            || unique.len() != u.angle_asset_ids.len()
            || !(2..=32).contains(&unique.len())
            || !unique.contains(&u.default_angle_asset_id)
            || !unique.contains(&u.audio_asset_id)
        {
            return Err("Invalid Unified Angles membership".into());
        }
        for id in &u.angle_asset_ids {
            if !assets.iter().any(|a| {
                a["id"] == *id
                    && a["type"] == "video"
                    && a.get("unifiedAngles").is_none_or(Value::is_null)
            }) {
                return Err("Unified Angles requires registered camera source files".into());
            }
        }
        if let Some(sync) = &u.sync {
            let ids: HashSet<_> = sync.sources.iter().map(|s| &s.id).collect();
            let clock = podcast_camera_clock(CameraClockOptions {
                sources: sync.sources.clone(),
            })
            .ok_or("Invalid Unified Angles source clock")?;
            if sync.method != "audio"
                || ids != unique
                || sync.sources.len() != unique.len()
                || sync.reference_asset_id != u.default_angle_asset_id
                || clock.reference_id != sync.reference_asset_id
                || clock.origin.abs() > 1e-6
            {
                return Err("Invalid Unified Angles audio synchronization".into());
            }
        }
        if u.sync_task.as_ref().is_some_and(|t| !t.validate(&u)) {
            return Err("Invalid Unified Angles synchronization task".into());
        }
    }
    Ok(())
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncInput {
    project_id: String,
    expected_revision: u64,
    media_id: String,
    #[schemars(length(min = 2, max = 32))]
    sources: Vec<CameraSource>,
    #[serde(default)]
    task_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SwitchInput {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    media_id: String,
    #[schemars(length(min = 1, max = 10000))]
    element_ids: Vec<String>,
    angle_asset_id: String,
    #[serde(default)]
    cycle: bool,
}
pub(super) fn register_unified(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    task::register(registry, state.clone(), events.clone())?;
    let sync_state = state.clone();
    let sync_events = events.clone();
    register::<SyncInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.unified.sync",
        "Save audio synchronization for Unified Angles",
        "Commit host audio-correlation offsets for every camera in one Unified Angles asset. Starts are seconds on a common audio clock. Verifies source durations and binding revisions, rebases to the longest recording, preserves its entire duration and records audio sync provenance. No IO. Explicit project/revision, cancellation, undo/redo, dry run, atomic and idempotent. Bridged Classic.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["classic", "unify", "multicam", "sync", "audio"],
        move |context, input| {
            let state = sync_state.clone();
            let events = sync_events.clone();
            async move {
                let out = mutate(
                    &state,
                    &events,
                    &context,
                    "Synchronize Unified Angles",
                    Some(input.expected_revision),
                    |document| {
                        let classic =
                            super::classic_scenes::classic_target(document, &input.project_id)?;
                        let index = classic
                            .media_assets
                            .iter()
                            .position(|a| a["id"] == input.media_id)
                            .ok_or_else(|| invalid("Unified media not found"))?;
                        let mut u = metadata(&classic.media_assets[index])
                            .map_err(|s| invalid(&s))?
                            .ok_or_else(|| invalid("Not a Unified Angles asset"))?;
                        if let Some(task_id) = &input.task_id {
                            let task = u
                                .sync_task
                                .as_ref()
                                .filter(|t| {
                                    t.id == *task_id && t.status == task::TaskStatus::Running
                                })
                                .ok_or_else(|| {
                                    CapabilityError::Conflict(
                                        "Audio synchronization task was replaced or stopped".into(),
                                    )
                                })?;
                            if input.sources.iter().any(|s| {
                                !task.sources.iter().any(|old| {
                                    old.id == s.id
                                        && old.duration == s.duration
                                        && old.binding_revision == s.binding_revision
                                })
                            }) {
                                return Err(CapabilityError::Conflict(
                                    "Audio worker source bindings changed".into(),
                                ));
                            }
                        }
                        if input.sources.len() != u.angle_asset_ids.len()
                            || input
                                .sources
                                .iter()
                                .any(|s| !u.angle_asset_ids.contains(&s.id))
                        {
                            return Err(invalid("Sync must include every camera"));
                        }
                        for s in &input.sources {
                            let a = classic
                                .media_assets
                                .iter()
                                .find(|a| a["id"] == s.id)
                                .ok_or_else(|| invalid("Camera missing"))?;
                            if a.get("bindingRevision")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                != s.binding_revision
                                || a.get("duration").and_then(Value::as_f64) != Some(s.duration)
                                || a.get("missing").and_then(Value::as_bool) == Some(true)
                            {
                                return Err(CapabilityError::Conflict(
                                    "Camera changed since audio analysis; synchronize again".into(),
                                ));
                            }
                        }
                        let clock = podcast_camera_clock(CameraClockOptions {
                            sources: input.sources.clone(),
                        })
                        .ok_or_else(|| invalid("Invalid camera clock"))?;
                        let sources = input
                            .sources
                            .iter()
                            .map(|s| CameraSource {
                                start: s.start - clock.origin,
                                ..s.clone()
                            })
                            .collect();
                        u.default_angle_asset_id = clock.reference_id.clone();
                        u.sync_task = None;
                        u.sync = Some(AudioSync {
                            method: "audio".into(),
                            reference_asset_id: clock.reference_id.clone(),
                            sources,
                        });
                        // Prefer a continuous audio source on the same zero as the base.
                        if classic.media_assets.iter().any(|a| {
                            a["id"] == clock.reference_id
                                && a.get("hasAudio").and_then(Value::as_bool) != Some(false)
                        }) {
                            u.audio_asset_id = clock.reference_id;
                        }
                        let a = &mut classic.media_assets[index];
                        a.insert("unifiedAngles".into(), json!(u));
                        a.insert("duration".into(), json!(clock.duration));
                        a.insert(
                            "bindingRevision".into(),
                            json!(
                                a.get("bindingRevision")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0)
                                    + 1
                            ),
                        );
                        validate_assets(&classic.media_assets).map_err(|s| invalid(&s))?;
                        Ok(vec![input.media_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(out).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )?;
    register::<SwitchInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.unified.switch",
        "Switch available Unified Angles",
        "Switch selected clips of one Unified Angles asset, or cycle in timeline order. Requires current audio synchronization for alternate cameras. Validates complete source range including trims; cycle skips unavailable cameras. Rejects stale media and unavailable explicit angles. No IO. Explicit project/revision, undo/redo, dry run, cancellation, atomic, idempotent. Bridged Classic.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "unify", "multicam", "angle"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let out = mutate(
                    &state,
                    &events,
                    &context,
                    "Switch camera angles",
                    Some(input.expected_revision),
                    |document| {
                        let classic =
                            super::classic_scenes::classic_target(document, &input.project_id)?;
                        let asset = classic
                            .media_assets
                            .iter()
                            .find(|a| a["id"] == input.media_id)
                            .ok_or_else(|| invalid("Unified media missing"))?;
                        let u = metadata(asset)
                            .map_err(|s| invalid(&s))?
                            .ok_or_else(|| invalid("Not unified media"))?;
                        let first = u
                            .angle_asset_ids
                            .iter()
                            .position(|id| *id == input.angle_asset_id)
                            .ok_or_else(|| invalid("Unknown camera"))?;
                        let synced = sync_current(&u, &classic.media_assets);
                        let sources = classic.media_assets.clone();
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .ok_or_else(|| invalid("Scene missing"))?;
                        let ids: HashSet<_> =
                            input.element_ids.iter().map(String::as_str).collect();
                        if ids.is_empty() || ids.len() != input.element_ids.len() {
                            return Err(invalid("Select distinct clips"));
                        }
                        let tracks = &scene["tracks"];
                        let mut clips: Vec<_> = std::iter::once(&tracks["main"])
                            .chain(tracks["overlay"].as_array().into_iter().flatten())
                            .flat_map(|t| t["elements"].as_array().into_iter().flatten())
                            .filter(|e| e["id"].as_str().is_some_and(|id| ids.contains(id)))
                            .cloned()
                            .collect();
                        if clips.len() != ids.len()
                            || clips
                                .iter()
                                .any(|e| e["type"] != "video" || e["mediaId"] != input.media_id)
                        {
                            return Err(invalid("Select clips from the same Unified Angles asset"));
                        }
                        clips.sort_by(|a, b| {
                            a["startTime"]
                                .as_i64()
                                .cmp(&b["startTime"].as_i64())
                                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
                        });
                        let mut chosen = HashMap::new();
                        let mut cursor = first;
                        for e in clips {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "operation was cancelled".into(),
                                ));
                            }
                            let trim = e["trimStart"].as_f64().unwrap_or(0.0) / 120000.0;
                            let span = e["sourceDuration"]
                                .as_f64()
                                .map(|d| {
                                    d / 120000.0
                                        - trim
                                        - e["trimEnd"].as_f64().unwrap_or(0.0) / 120000.0
                                })
                                .unwrap_or(e["duration"].as_f64().unwrap_or(0.0) / 120000.0);
                            let available = |id: &String| {
                                if !synced && *id != u.default_angle_asset_id {
                                    return false;
                                }
                                let Some(a) = sources.iter().find(|a| a["id"] == *id) else {
                                    return false;
                                };
                                if a.get("missing").and_then(Value::as_bool) == Some(true) {
                                    return false;
                                }
                                let start = if synced {
                                    u.sync
                                        .as_ref()
                                        .unwrap()
                                        .sources
                                        .iter()
                                        .find(|s| s.id == *id)
                                        .map(|s| s.start)
                                        .unwrap_or(0.0)
                                } else {
                                    0.0
                                };
                                unified_camera_range(CameraRangeOptions {
                                    source: CameraSource {
                                        id: id.clone(),
                                        duration: a["duration"].as_f64().unwrap_or(0.0),
                                        start,
                                        binding_revision: 0,
                                    },
                                    trim_start: trim,
                                    duration: span,
                                })
                                .available
                            };
                            let index=if input.cycle{(0..u.angle_asset_ids.len()).map(|i|(cursor+i)%u.angle_asset_ids.len()).find(|i|available(&u.angle_asset_ids[*i]))}else{available(&input.angle_asset_id).then_some(first)}.ok_or_else(||invalid("Camera unavailable for this entire clip; split at its coverage boundary or synchronize first"))?;
                            chosen.insert(
                                e["id"].as_str().unwrap().to_owned(),
                                u.angle_asset_ids[index].clone(),
                            );
                            cursor = (index + 1) % u.angle_asset_ids.len();
                        }
                        fn apply(v: &mut Value, chosen: &HashMap<String, String>) {
                            match v {
                                Value::Object(o) => {
                                    if let Some(id) = o
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .and_then(|id| chosen.get(id))
                                    {
                                        o.insert("unifiedAngleId".into(), json!(id));
                                    }
                                    for v in o.values_mut() {
                                        apply(v, chosen)
                                    }
                                }
                                Value::Array(a) => {
                                    for v in a {
                                        apply(v, chosen)
                                    }
                                }
                                _ => {}
                            }
                        }
                        apply(&mut scene["tracks"], &chosen);
                        Ok(input.element_ids.clone())
                    },
                )?;
                Ok(OperationSuccess::new(out).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}
