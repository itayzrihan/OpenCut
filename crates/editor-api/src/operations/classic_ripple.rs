//! Exact-tick Classic ripple policy shared by the UI reactor and registry.
use super::*;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
const MAX_TICKS: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Span {
    id: String,
    start_time: i64,
    duration: i64,
}
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeforeTrack {
    id: String,
    #[schemars(length(max = 10000))]
    elements: Vec<Span>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 100))]
    before_tracks: Vec<BeforeTrack>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Adjustment {
    track_id: String,
    after_time: i64,
    shift_amount: i64,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Plan {
    adjustments: Vec<Adjustment>,
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn tracks(v: &Value) -> impl Iterator<Item = &Value> {
    v["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&v["main"]))
        .chain(v["audio"].as_array().into_iter().flatten())
}
fn scene_mut<'a>(
    document: &'a mut EditorDocument,
    input: &Input,
) -> Result<&'a mut Value, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(invalid("Target project is not active"));
    }
    project
        .classic
        .as_mut()
        .ok_or_else(|| invalid("Requires a Classic project"))?
        .document["scenes"]
        .as_array_mut()
        .and_then(|scenes| {
            scenes
                .iter_mut()
                .find(|scene| scene["id"] == input.scene_id)
        })
        .and_then(|scene| scene.get_mut("tracks"))
        .ok_or_else(|| invalid("Scene not found"))
}
fn span(s: &Span) -> Result<(i64, i64), CapabilityError> {
    if s.id.is_empty()
        || s.start_time < 0
        || s.duration <= 0
        || s.start_time > MAX_TICKS
        || s.duration > MAX_TICKS - s.start_time
    {
        return Err(invalid(
            "Ripple spans require nonempty IDs and safe positive exact ticks",
        ));
    }
    Ok((s.start_time, s.start_time + s.duration))
}
fn normalize(mut ranges: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    ranges.retain(|(s, e)| e > s);
    ranges.sort_by_key(|(s, _)| *s);
    let mut result: Vec<(i64, i64)> = vec![];
    for (s, e) in ranges {
        if let Some(last) = result.last_mut().filter(|last| s <= last.1) {
            last.1 = last.1.max(e);
        } else {
            result.push((s, e));
        }
    }
    result
}
fn plan(current: &Value, input: &Input) -> Result<Vec<Adjustment>, CapabilityError> {
    if input.before_tracks.is_empty()
        || input.before_tracks.len() > 100
        || input
            .before_tracks
            .iter()
            .map(|t| t.elements.len())
            .sum::<usize>()
            > 10000
    {
        return Err(invalid(
            "Ripple requires 1..100 before tracks and at most 10000 clip spans",
        ));
    }
    let after: HashMap<_, _> = tracks(current)
        .filter_map(|t| t["id"].as_str().map(|id| (id, t)))
        .collect();
    let all_ids: HashSet<_> = tracks(current)
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter_map(|e| e["id"].as_str())
        .collect();
    let mut seen_tracks = HashSet::new();
    let mut seen_elements = HashSet::new();
    let mut result = vec![];
    for before in &input.before_tracks {
        if before.id.is_empty() || !seen_tracks.insert(&before.id) {
            return Err(invalid("Duplicate or empty before-track ID"));
        }
        let mut old = HashMap::new();
        for s in &before.elements {
            if !seen_elements.insert(&s.id) {
                return Err(invalid("Duplicate before-element ID"));
            }
            old.insert(s.id.as_str(), span(s)?);
        }
        let mut next = HashMap::new();
        if let Some(t) = after.get(before.id.as_str()) {
            for e in t["elements"]
                .as_array()
                .ok_or_else(|| invalid("Invalid track elements"))?
            {
                let s: Span = Span {
                    id: e["id"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid clip ID"))?
                        .into(),
                    start_time: e["startTime"]
                        .as_i64()
                        .ok_or_else(|| invalid("Invalid start ticks"))?,
                    duration: e["duration"]
                        .as_i64()
                        .ok_or_else(|| invalid("Invalid duration ticks"))?,
                };
                next.insert(s.id.clone(), span(&s)?);
            }
        }
        let mut vacated = vec![];
        for (id, (s, e)) in &old {
            if let Some((_, new_end)) = next.get(*id) {
                if e > new_end {
                    vacated.push((*new_end, *e));
                }
            } else if !all_ids.contains(id) {
                vacated.push((*s, *e));
            }
        }
        let joined = normalize(
            next.iter()
                .filter(|(id, _)| !old.contains_key(id.as_str()))
                .map(|(_, range)| *range)
                .collect(),
        );
        for range in normalize(vacated) {
            let mut remaining = vec![range];
            for (s, e) in &joined {
                remaining = remaining
                    .into_iter()
                    .flat_map(|(rs, re)| {
                        if *e <= rs || *s >= re {
                            vec![(rs, re)]
                        } else {
                            [(rs, (*s).min(re)), ((*e).max(rs), re)]
                                .into_iter()
                                .filter(|(s, e)| e > s)
                                .collect()
                        }
                    })
                    .collect();
            }
            result.extend(remaining.into_iter().map(|(s, e)| Adjustment {
                track_id: before.id.clone(),
                after_time: e,
                shift_amount: e - s,
            }));
        }
    }
    Ok(result)
}
fn apply(current: &mut Value, adjustments: &[Adjustment]) -> Result<(), CapabilityError> {
    let before = current.clone();
    let mut updates = vec![];
    let mut ordered = adjustments.to_vec();
    ordered.sort_by_key(|a| std::cmp::Reverse(a.after_time));
    for a in ordered {
        for bucket in ["overlay", "audio"] {
            if let Some(group) = current[bucket].as_array_mut() {
                for track in group.iter_mut().filter(|t| t["id"] == a.track_id) {
                    shift(track, &a, &mut updates)?;
                }
            }
        }
        if current["main"]["id"] == a.track_id {
            shift(&mut current["main"], &a, &mut updates)?;
        }
    }
    // Multiple intervals can move the same clip. Reconcile only its final time.
    let mut final_updates = BTreeMap::new();
    for update in updates {
        final_updates.insert(
            (
                update["trackId"].as_str().unwrap().to_owned(),
                update["elementId"].as_str().unwrap().to_owned(),
            ),
            update,
        );
    }
    classic_captions::sync_after_edit(
        current,
        &before,
        &json!(final_updates.into_values().collect::<Vec<_>>()),
    )
}
fn shift(
    track: &mut Value,
    a: &Adjustment,
    updates: &mut Vec<Value>,
) -> Result<(), CapabilityError> {
    let id = track["id"].clone();
    for e in track["elements"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid track elements"))?
    {
        let start = e["startTime"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid start ticks"))?;
        if start >= a.after_time {
            let next = start
                .checked_sub(a.shift_amount)
                .filter(|n| *n >= 0)
                .ok_or_else(|| invalid("Ripple would move a clip before zero"))?;
            e["startTime"] = json!(next);
            updates.push(json!({"trackId":id,"elementId":e["id"],"updates":{"startTime":next}}));
        }
    }
    Ok(())
}
pub(super) fn register_classic_ripple(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    register::<Input, Plan, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.ripple.plan",
        "Plan Classic ripple gap closure",
        "Compare explicit pre-edit clip spans (track id, clip id, startTime and duration in exact ticks) with the current scene. Read the before snapshot before deleting or shortening clips. Coalesces removed/truncated intervals, subtracts newly inserted spans, and excludes clips moved to another track. At most 100 tracks and 10000 clips. Returns shift thresholds to close only newly vacated space; apply evaluates them in descending order. Does not change state. Requires the active project, scene and current expectedRevision. An empty plan requires no apply.",
        "timeline",
        AccessLevel::Read,
        false,
        false,
        &["classic", "ripple", "gap", "plan"],
        move |context, input| {
            let state = read_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let guard = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if guard.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Ripple plan revision is stale".into(),
                    ));
                }
                let mut document = guard.document.clone();
                let adjustments = plan(scene_mut(&mut document, &input)?, &input)?;
                Ok(OperationSuccess::new(Plan { adjustments })
                    .summary("Planned Classic ripple shifts"))
            }
        },
    )?;
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.ripple.apply",
        "Apply Classic ripple gap closure",
        "Recompute the ripple plan from explicit bounded pre-edit spans and the current scene, then shift later clips in descending threshold order. Use timeline.classic.ripple.plan first and skip empty plans. Preserves relative keyframes, source trim/retime, track order and unrelated fields; reconciles manual/generated transcript timing without font-measured caption reflow. Does not infer linked-audio groups. Requires active project/scene/current expectedRevision. Atomic, dry-run, idempotency and Undo/Redo supported. A caller may group its preceding edit and ripple apply in the same canonical transaction.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "ripple", "gap", "עריכת ריפל"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Ripple timeline gaps",
                    Some(input.expected_revision),
                    |document| {
                        let tracks = scene_mut(document, &input)?;
                        let adjustments = plan(tracks, &input)?;
                        apply(tracks, &adjustments)?;
                        Ok(vec![input.project_id.clone(), input.scene_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Applied Classic ripple shifts")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
