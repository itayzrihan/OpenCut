//! Non-destructive, Classic compound media: camera clock + one processed recorder.
use super::*;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 2, max = 2))]
    media_ids: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    video_media_id: String,
    audio_media_id: String,
}
fn selected<'a>(
    assets: &'a [Map<String, Value>],
    ids: &[String],
) -> Result<(&'a Map<String, Value>, &'a Map<String, Value>), CapabilityError> {
    if ids.len() != 2 || ids[0] == ids[1] {
        return Err(invalid(
            "Select one video or Unified Angles and one external audio recording",
        ));
    }
    let mut chosen = ids
        .iter()
        .map(|id| {
            assets
                .iter()
                .find(|a| a["id"] == *id)
                .ok_or_else(|| invalid("Selected media is missing"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    chosen.sort_by_key(|a| a["type"] != "video");
    let (v, a) = (chosen[0], chosen[1]);
    if v["type"] != "video" || a["type"] != "audio" {
        return Err(invalid(
            "Select one video or Unified Angles and one external audio recording",
        ));
    }
    let u = metadata(v).map_err(|e| invalid(&e))?;
    let ids = u
        .as_ref()
        .map(|u| u.angle_asset_ids.clone())
        .unwrap_or_else(|| vec![v["id"].as_str().unwrap().into()]);
    for id in ids
        .iter()
        .chain(std::iter::once(&a["id"].as_str().unwrap().to_owned()))
    {
        let source = assets
            .iter()
            .find(|s| s["id"] == *id)
            .ok_or_else(|| invalid("Compound source is missing"))?;
        if source.get("missing").and_then(Value::as_bool) == Some(true)
            || source.get("hasAudio").and_then(Value::as_bool) == Some(false)
            || !source
                .get("duration")
                .and_then(Value::as_f64)
                .is_some_and(|d| d.is_finite() && d > 0.)
        {
            return Err(invalid(
                "Every selected source needs available reference audio and a known duration",
            ));
        }
    }
    Ok((v, a))
}
/// Only insertion initializes processing. Later manual edits, splits and take
/// swaps retain their own parameters; source media are never processed in place.
pub(in crate::operations) fn prepare_element(
    e: &mut Value,
    assets: &[Map<String, Value>],
) -> Result<(), CapabilityError> {
    let Some(asset) = e["mediaId"]
        .as_str()
        .and_then(|id| assets.iter().find(|a| a["id"] == id))
    else {
        return Ok(());
    };
    let Some(u) = metadata(asset).map_err(|s| invalid(&s))? else {
        return Ok(());
    };
    if !u.external_audio() || !matches!(e["type"].as_str(), Some("video" | "audio")) {
        return Ok(());
    }
    if !sync_current(&u, assets) {
        return Err(invalid(
            "Wait for Unified with Audio to finish syncing, or retry its audio sync",
        ));
    }
    let start = u
        .sync
        .as_ref()
        .unwrap()
        .sources
        .iter()
        .find(|s| s.id == u.audio_asset_id)
        .unwrap()
        .start;
    e["params"]["sourceAudioOffsetSeconds"] = json!(-start);
    super::super::classic_podcast_finish::finish_audio_element(e)?;
    if e["type"] == "video" {
        e["isSourceAudioEnabled"] = json!(true);
    }
    Ok(())
}
pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let prep_state = state.clone();
    super::super::register::<Input, Prepared, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.unified.with_audio.prepare",
        "Check video and external audio selection",
        "Validate exactly one registered video or Unified Angles asset and one audio recording. Requires usable camera reference sound, durations and source bindings; no IO/mutation. Explicit project/revision and cancellation.",
        "media",
        AccessLevel::Read,
        true,
        false,
        &["classic", "unified", "audio", "teleprompter"],
        move |ctx, input| {
            let state = prep_state.clone();
            async move {
                if ctx.cancellation.is_cancelled() {
                    return Err(invalid("Selection check cancelled"));
                }
                let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                if store.active_project_id() != Some(input.project_id.as_str())
                    || store.document.revision != input.expected_revision
                {
                    return Err(CapabilityError::Conflict(
                        "Project or media selection changed".into(),
                    ));
                }
                let c = store
                    .document
                    .project
                    .as_ref()
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| invalid("Classic project required"))?;
                let (v, a) = selected(&c.media_assets, &input.media_ids)?;
                Ok(OperationSuccess::new(Prepared {
                    video_media_id: v["id"].as_str().unwrap().into(),
                    audio_media_id: a["id"].as_str().unwrap().into(),
                }))
            }
        },
    )?;
    super::super::register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.unified.with_audio.create",
        "Create Unified with Audio",
        "Create one non-destructive draggable compound media asset from exactly one video or existing Unified Angles and one external audio recording. Flattens retained source camera membership, preserves all source assets and scenes, chooses the longest camera as the full-duration visual clock, routes only the external recording, and records podcast audio finishing version1. No podcast scenes, automatic camera cuts, sharpening or model inference. Host starts cancellable audio-correlation work via unified.sync_task and commits all camera+recorder offsets via unified.sync. Cannot insert unsynced compound media. New clips inherit the shared microphone gain/noise-reduction/limiter preset and physical source offset; angle switching keeps audio. No filesystem/network IO. Explicit project/revision, cancellation, atomic dry run, undo/redo and registry idempotency. Bridged Classic.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["classic", "unified", "audio", "teleprompter"],
        move |ctx, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let out = mutate(
                    &state,
                    &events,
                    &ctx,
                    "Create Unified with Audio",
                    Some(input.expected_revision),
                    |document| {
                        let c = classic_scenes::classic_target(document, &input.project_id)?;
                        let (v, a) = selected(&c.media_assets, &input.media_ids)?;
                        let old = metadata(v).map_err(|e| invalid(&e))?;
                        let ids = old
                            .map(|u| u.angle_asset_ids)
                            .unwrap_or_else(|| vec![v["id"].as_str().unwrap().into()]);
                        let sources = ids
                            .iter()
                            .map(|id| {
                                let s = c.media_assets.iter().find(|a| a["id"] == *id).unwrap();
                                CameraSource {
                                    id: id.clone(),
                                    duration: s["duration"].as_f64().unwrap(),
                                    start: 0.,
                                    binding_revision: s
                                        .get("bindingRevision")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0),
                                }
                            })
                            .collect();
                        let clock = podcast_camera_clock(CameraClockOptions { sources })
                            .ok_or_else(|| invalid("Invalid camera durations"))?;
                        let base = c
                            .media_assets
                            .iter()
                            .find(|a| a["id"] == clock.reference_id)
                            .unwrap();
                        let mut asset = base.clone();
                        let audio_id = a["id"].as_str().unwrap().to_owned();
                        let name = format!(
                            "{} + {} · Unified with Audio",
                            v.get("name").and_then(Value::as_str).unwrap_or("Video"),
                            a.get("name").and_then(Value::as_str).unwrap_or("Audio")
                        );
                        for field in [
                            "id",
                            "url",
                            "file",
                            "buffer",
                            "ephemeral",
                            "missing",
                            "canUndoRelink",
                            "unifiedAngles",
                        ] {
                            asset.remove(field);
                        }
                        let mut occupied = HashSet::new();
                        collect_ids(
                            &serde_json::to_value(&document.project).unwrap(),
                            &mut occupied,
                        );
                        let id = classic_duplicate::fresh(document, &mut occupied, "unified-audio");
                        asset.extend(json!({"id":id,"name":name,"type":"video","size":0,"lastModified":now_ms(),"fileName":"Unified with Audio.unified-angles","mimeType":"application/vnd.opencut.unified-angles","storageKind":"copied","sourcePath":"","hasAudio":true,"duration":clock.duration,"bindingRevision":0,"unifiedAngles":Unified{version:1,angle_asset_ids:ids,default_angle_asset_id:clock.reference_id,audio_asset_id:audio_id,audio_finishing_version:Some(1),sync:None,sync_task:None}}).as_object().unwrap().clone());
                        let c = classic_scenes::classic_target(document, &input.project_id)?;
                        c.media_assets.push(asset);
                        validate_assets(&c.media_assets).map_err(|e| invalid(&e))?;
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(out).changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}
