//! Insert a rendered connection without stretching existing sound or pictures.
use super::{classic_split, *};
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_TICK: i64 = 9_007_199_254_740_991;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pair {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    track_id: String,
    left_id: String,
    right_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Insert {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    track_id: String,
    left_id: String,
    right_id: String,
    anchor: String,
    media_id: String,
    #[schemars(range(min = 1, max = 3600000))]
    duration: i64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    cuts: Vec<Cut>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cut {
    track_id: String,
    left_id: String,
    right_id: String,
    anchor: String,
    media_id: String,
    duration: i64,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BatchOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    element_ids: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Plan {
    anchor: String,
    cut_time: i64,
    right_start: i64,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    element_id: String,
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

fn tick(value: &Value) -> Result<i64, CapabilityError> {
    value
        .as_i64()
        .filter(|t| (0..=MAX_TICK).contains(t))
        .ok_or_else(|| invalid("Invalid timeline time"))
}

fn end(start: i64, duration: i64) -> Result<i64, CapabilityError> {
    start
        .checked_add(duration)
        .filter(|t| (0..=MAX_TICK).contains(t))
        .ok_or_else(|| invalid("Timeline time exceeds supported range"))
}

fn tracks(value: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&value["main"])
        .chain(value["overlay"].as_array().into_iter().flatten())
        .chain(value["audio"].as_array().into_iter().flatten())
}

fn tracks_mut(value: &mut Value) -> impl Iterator<Item = &mut Value> {
    value
        .as_object_mut()
        .into_iter()
        .flatten()
        .flat_map(|(key, group)| match key.as_str() {
            "main" => std::slice::from_mut(group).iter_mut(),
            "overlay" | "audio" => group
                .as_array_mut()
                .map(Vec::as_mut_slice)
                .unwrap_or_default()
                .iter_mut(),
            _ => [].iter_mut(),
        })
}

fn scene<'a>(document: &'a EditorDocument, pair: &Pair) -> Result<&'a Value, CapabilityError> {
    let project = document
        .project
        .as_ref()
        .filter(|p| p.id == pair.project_id)
        .ok_or_else(|| invalid("Seamless Connect project is not active"))?;
    project
        .classic
        .as_ref()
        .and_then(|classic| classic.document["scenes"].as_array())
        .and_then(|scenes| scenes.iter().find(|s| s["id"] == pair.scene_id))
        .ok_or_else(|| invalid("Seamless Connect scene is unavailable"))
}

fn plan(scene: &Value, pair: &Pair) -> Result<Plan, CapabilityError> {
    let timeline = &scene["tracks"];
    let track = tracks(timeline)
        .find(|t| t["id"] == pair.track_id && t["type"] == "video")
        .ok_or_else(|| invalid("Select two videos on the same track"))?;
    let elements = track["elements"]
        .as_array()
        .ok_or_else(|| invalid("Invalid video track"))?;
    let video = |id: &str| {
        elements
            .iter()
            .find(|e| e["id"] == id && e["type"] == "video")
            .ok_or_else(|| invalid("Selected video is no longer on the track"))
    };
    let left = video(&pair.left_id)?;
    let right = video(&pair.right_id)?;
    if track["hidden"] == true || left["hidden"] == true || right["hidden"] == true {
        return Err(invalid("Show both selected videos before connecting clips"));
    }
    let cut_time = end(tick(&left["startTime"])?, tick(&left["duration"])?)?;
    let right_start = tick(&right["startTime"])?;
    if right_start < cut_time || tick(&left["duration"])? == 0 || tick(&right["duration"])? == 0 {
        return Err(invalid("Select two consecutive videos without overlap"));
    }
    for candidate in tracks(timeline) {
        if candidate["locked"] == true && candidate["id"] == pair.track_id {
            return Err(invalid(
                "Unlock the selected video track before connecting clips",
            ));
        }
        for clip in candidate["elements"].as_array().into_iter().flatten() {
            let start = tick(&clip["startTime"])?;
            let stop = end(start, tick(&clip["duration"])?)?;
            if stop > cut_time && candidate["locked"] == true {
                return Err(invalid(
                    "Unlock the tracks that need to move before connecting clips",
                ));
            }
            if cut_time < right_start && start < right_start && stop > cut_time {
                return Err(invalid(
                    "Close the gap or clear its overlapping layers before connecting clips",
                ));
            }
            if candidate["id"] == pair.track_id && start < cut_time && stop > cut_time {
                return Err(invalid("A third video overlaps the selected cut"));
            }
        }
    }
    let anchor = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&[left, right]).map_err(|e| invalid(&e.to_string()))?)
    );
    Ok(Plan {
        anchor,
        cut_time,
        right_start,
    })
}

fn shift_metadata(scene: &mut Value, plan: &Plan, delta: i64) -> Result<(), CapabilityError> {
    let cut = plan.cut_time as f64 / 120000.0;
    let boundary = plan.right_start as f64 / 120000.0;
    let shift = delta as f64 / 120000.0;
    for track in tracks_mut(&mut scene["tracks"]) {
        if let Some(words) = track
            .get_mut("captionSource")
            .and_then(|source| source.get_mut("words"))
            .and_then(Value::as_array_mut)
        {
            for word in words
                .iter_mut()
                .filter(|w| w["source"]["type"] != "text-layer")
            {
                if let (Some(start), Some(stop)) = (word["start"].as_f64(), word["end"].as_f64()) {
                    if start >= boundary
                        || (start < cut && stop > boundary && (start + stop) / 2.0 >= boundary)
                    {
                        word["start"] = json!(start.max(boundary) + shift);
                        word["end"] = json!(stop + shift);
                    } else if stop > cut {
                        word["end"] = json!(stop.min(cut));
                    }
                }
            }
            words.retain(|w| w["end"].as_f64() > w["start"].as_f64());
        }
    }
    if let Some(bookmarks) = scene["bookmarks"].as_array_mut() {
        for bookmark in bookmarks {
            let start = tick(&bookmark["time"])?;
            let map = |time| {
                if time >= plan.right_start {
                    end(time, delta)
                } else {
                    Ok(time.min(end(plan.right_start, delta)?))
                }
            };
            let shifted_start = map(start)?;
            bookmark["time"] = json!(shifted_start);
            if let Some(duration) = bookmark["duration"].as_i64() {
                let stop = end(start, duration)?;
                let shifted_stop = if start < plan.cut_time && stop == plan.cut_time {
                    stop
                } else {
                    map(stop)?
                };
                bookmark["duration"] = json!(shifted_stop - shifted_start);
            }
        }
    }
    classic_captions::reconcile_words(&mut scene["tracks"], &[])
}

fn apply(
    document: &mut EditorDocument,
    input: &Insert,
    context: &InvocationContext,
) -> Result<String, CapabilityError> {
    let pair = &Pair {
        project_id: input.project_id.clone(),
        scene_id: input.scene_id.clone(),
        expected_revision: input.expected_revision,
        track_id: input.track_id.clone(),
        left_id: input.left_id.clone(),
        right_id: input.right_id.clone(),
    };
    let current = scene(document, pair)?;
    let plan = plan(current, pair)?;
    if plan.anchor != input.anchor {
        return Err(CapabilityError::Conflict(
            "The source clips changed after Seamless Connect was prepared".into(),
        ));
    }
    let asset = document
        .project
        .as_ref()
        .unwrap()
        .classic
        .as_ref()
        .unwrap()
        .media_assets
        .iter()
        .find(|a| a["id"] == input.media_id && a["type"] == "video")
        .ok_or_else(|| invalid("Import the rendered connection before inserting it"))?;
    let source = asset["duration"]
        .as_f64()
        .filter(|d| d.is_finite())
        .map(|d| (d * 120000.0).round() as i64)
        .filter(|d| (input.duration..=MAX_TICK).contains(d))
        .ok_or_else(|| invalid("Rendered video is shorter than the connection"))?;
    let delta = end(plan.cut_time, input.duration)? - plan.right_start;
    let locked: Vec<_> = tracks(&current["tracks"])
        .filter(|track| track["locked"] == true)
        .cloned()
        .collect();
    let mut crossing = Vec::new();
    for track in tracks(&current["tracks"]) {
        for clip in track["elements"].as_array().into_iter().flatten() {
            let start = tick(&clip["startTime"])?;
            if start < plan.cut_time && end(start, tick(&clip["duration"])?)? > plan.cut_time {
                crossing.push(classic_split::Ref {
                    track_id: track["id"].as_str().unwrap().into(),
                    element_id: clip["id"].as_str().unwrap().into(),
                });
            }
        }
    }
    if !crossing.is_empty() {
        classic_split::split_document(
            document,
            &classic_split::Input {
                project_id: pair.project_id.clone(),
                scene_id: pair.scene_id.clone(),
                expected_revision: pair.expected_revision,
                elements: crossing,
                split_time: plan.cut_time,
                retain_side: classic_split::Side::Both,
            },
            context,
            &mut vec![],
            &mut vec![],
            true,
        )?;
    }
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).map_err(|e| invalid(&e.to_string()))?,
        &mut occupied,
    );
    let id = classic_duplicate::fresh(document, &mut occupied, "classic-clip");
    let target = project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == pair.scene_id)
        .unwrap();
    for track in tracks_mut(&mut target["tracks"]) {
        let clips = track["elements"]
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid timeline track"))?;
        for clip in clips.iter_mut() {
            if context.cancellation.is_cancelled() {
                return Err(CapabilityError::Failed("Seamless Connect cancelled".into()));
            }
            let start = tick(&clip["startTime"])?;
            if start >= plan.right_start {
                let next = end(start, delta)?;
                end(next, tick(&clip["duration"])?)?;
                clip["startTime"] = json!(next);
            }
        }
        if track["id"] == pair.track_id {
            track["elements"].as_array_mut().unwrap().push(json!({
                "id": id, "type": "video", "name": "Seamless Connect", "mediaId": input.media_id,
                "startTime": plan.cut_time, "duration": input.duration, "sourceDuration": source,
                "trimStart": 0, "trimEnd": source - input.duration, "isSourceAudioEnabled": false,
                "params": {}
            }));
        }
    }
    shift_metadata(target, &plan, delta)?;
    for track in locked {
        if tracks(&target["tracks"]).find(|current| current["id"] == track["id"]) != Some(&track) {
            return Err(invalid("Seamless Connect would change a locked track"));
        }
    }
    Ok(id)
}

pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let reader = state.clone();
    super::register::<Pair, Plan, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.bridge.plan",
        "Plan a connection between two videos",
        "Validate a pair of consecutive videos on one track and return an anchor and seam times in 120000 ticks/second. No provider or network calls.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["video", "transition", "ripple"],
        move |_, pair| {
            let reader = reader.clone();
            async move {
                let store = reader.read().map_err(|_| invalid("State lock poisoned"))?;
                if store.document.revision != pair.expected_revision {
                    return Err(CapabilityError::Conflict("The timeline changed".into()));
                }
                Ok(OperationSuccess::new(plan(
                    scene(&store.document, &pair)?,
                    &pair,
                )?))
            }
        },
    )?;
    let batch_state = state.clone();
    let batch_events = events.clone();
    super::register::<Batch, BatchOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.bridge.batch.insert",
        "Insert up to ten generated connections",
        "Validate every frozen source pair first, then insert all bridges from right to left in one transaction. Preserves original source anchors and shifts later layers together. Invalid/stale pairs, missing outputs or locked tracks roll back the entire batch. Revision, dry run, cancellation, idempotency and Undo/Redo supported. No network calls.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["video", "transition", "seamless", "batch"],
        move |context, input| {
            let state = batch_state.clone();
            let events = batch_events.clone();
            async move {
                let mut element_ids = vec![];
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Insert Seamless batch",
                    Some(input.expected_revision),
                    |document| {
                        if input.cuts.is_empty() || input.cuts.len() > 10 {
                            return Err(invalid("Connect between one and ten cuts"));
                        }
                        let mut ordered = vec![];
                        let mut seen = HashSet::new();
                        for cut in &input.cuts {
                            if !(1..=3600000).contains(&cut.duration)
                                || !seen.insert((&cut.track_id, &cut.left_id, &cut.right_id))
                            {
                                return Err(invalid("Invalid or repeated Seamless cut"));
                            }
                            let pair = Pair {
                                project_id: input.project_id.clone(),
                                scene_id: input.scene_id.clone(),
                                expected_revision: input.expected_revision,
                                track_id: cut.track_id.clone(),
                                left_id: cut.left_id.clone(),
                                right_id: cut.right_id.clone(),
                            };
                            let p = plan(scene(document, &pair)?, &pair)?;
                            if p.anchor != cut.anchor {
                                return Err(CapabilityError::Conflict(
                                    "The batch source clips changed; prepare again".into(),
                                ));
                            }
                            ordered.push((p.cut_time, cut));
                        }
                        ordered.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
                        for (_, cut) in ordered {
                            let insert = Insert {
                                project_id: input.project_id.clone(),
                                scene_id: input.scene_id.clone(),
                                expected_revision: input.expected_revision,
                                track_id: cut.track_id.clone(),
                                left_id: cut.left_id.clone(),
                                right_id: cut.right_id.clone(),
                                anchor: cut.anchor.clone(),
                                media_id: cut.media_id.clone(),
                                duration: cut.duration,
                            };
                            element_ids.push(apply(document, &insert, &context)?);
                        }
                        Ok(element_ids.clone())
                    },
                )?;
                Ok(OperationSuccess::new(BatchOutput {
                    mutation,
                    element_ids,
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;
    super::register::<Insert, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.bridge.insert",
        "Insert a generated video connection",
        "Use timeline.classic.bridge.plan first. Insert an imported video between the validated pair. Split crossing clips on every layer and shift everything after the seam together. Replace an empty gap when present. Atomic, revision checked, undoable and supports dry run and idempotency. Performs no network calls.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["video", "transition", "ripple"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut element_id = String::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Seamless Connect",
                    Some(input.expected_revision),
                    |document| {
                        element_id = apply(document, &input, &context)?;
                        Ok(vec![element_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    element_id,
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
