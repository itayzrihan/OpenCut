//! Scene-wide Start/End crop. Classic-only; all hosts share this transaction.
use super::*;
use serde_json::json;
#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Edge {
    Start,
    End,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    edge: Edge,
    #[schemars(range(min = 0, max = 9007199254740991_i64))]
    time: i64,
}
fn invalid(s: &str) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
fn tick(v: &Value) -> Result<i64, CapabilityError> {
    v.as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| invalid("Invalid safe integer time"))
}
fn all(t: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&t["main"])
        .chain(t["overlay"].as_array().into_iter().flatten())
        .chain(t["audio"].as_array().into_iter().flatten())
}
fn crop(track: &mut Value, low: i64, high: i64, shift: i64) -> Result<(), CapabilityError> {
    let before = track.clone();
    let elements = track["elements"]
        .as_array_mut()
        .ok_or_else(|| invalid("Missing track elements"))?;
    let mut kept = Vec::new();
    for e in elements.iter() {
        let start = tick(&e["startTime"])?;
        let duration = tick(&e["duration"])?;
        let end = start
            .checked_add(duration)
            .ok_or_else(|| invalid("Clip time overflow"))?;
        let a = start.max(low);
        let b = end.min(high);
        if b <= a {
            continue;
        }
        let mut next = e.clone();
        if a != start || b != end {
            let left = a - start;
            let right = end - b;
            let rate = if matches!(e["type"].as_str(), Some("video" | "audio")) {
                classic_update::rate(e)
            } else {
                1.0
            };
            let source_left = (left as f64 * rate).round() as i64;
            let source_right = (duration as f64 * rate).round() as i64
                - ((duration - right) as f64 * rate).round() as i64;
            let patch = json!({"startTime":a,"duration":b-a,"trimStart":tick(&e["trimStart"])?+source_left,"trimEnd":tick(&e["trimEnd"])?+source_right});
            // Split curves at the retained in-point before the existing trim policy
            // clips their out-point and timed words. IDs and unknown fields survive.
            if left > 0 {
                let animation = classic_keyframes::split_animations(
                    &e["animations"],
                    left,
                    &format!("start-end-{}", e["id"].as_str().unwrap_or("clip")),
                )?
                .1;
                if animation.is_null() {
                    next.as_object_mut().unwrap().remove("animations");
                } else {
                    next["animations"] = animation;
                }
            }
            next =
                classic_update::apply(&next, patch.as_object().unwrap(), false, None, "start-end")?;
        }
        next["startTime"] = json!(a - shift);
        kept.push(next);
    }
    *elements = kept;
    if let Some(words) = track
        .get_mut("captionSource")
        .and_then(|s| s.get_mut("words"))
        .and_then(Value::as_array_mut)
    {
        words.retain_mut(|word| {
            let (Some(a), Some(b)) = (word["start"].as_f64(), word["end"].as_f64()) else {
                return false;
            };
            let a = a.max(low as f64 / 120000.0);
            let b = b.min(high as f64 / 120000.0);
            if b <= a {
                return false;
            }
            word["start"] = json!(a - shift as f64 / 120000.0);
            word["end"] = json!(b - shift as f64 / 120000.0);
            true
        });
    }
    if before["locked"] == true && before != *track {
        return Err(invalid("Start End would change a locked track"));
    }
    Ok(())
}
fn apply(scene: &mut Value, edge: Edge, time: i64) -> Result<(), CapabilityError> {
    let mut end = 0;
    for t in all(&scene["tracks"]) {
        for e in t["elements"]
            .as_array()
            .ok_or_else(|| invalid("Missing elements"))?
        {
            end = end.max(
                tick(&e["startTime"])?
                    .checked_add(tick(&e["duration"])?)
                    .ok_or_else(|| invalid("Time overflow"))?,
            );
        }
    }
    let time = time.min(end);
    if matches!(edge, Edge::Start) && time == 0 || matches!(edge, Edge::End) && time == end {
        return Ok(());
    }
    let (low, high, shift) = match edge {
        Edge::Start => (time, end, time),
        Edge::End => (0, time, 0),
    };
    crop(&mut scene["tracks"]["main"], low, high, shift)?;
    for bucket in ["overlay", "audio"] {
        for t in scene["tracks"][bucket]
            .as_array_mut()
            .ok_or_else(|| invalid("Missing tracks"))?
        {
            crop(t, low, high, shift)?;
        }
    }
    if let Some(bookmarks) = scene["bookmarks"].as_array_mut() {
        bookmarks.retain_mut(|b| {
            let Some(t) = b["time"].as_i64() else {
                return false;
            };
            let duration = b["duration"].as_i64().unwrap_or(0);
            if duration == 0 {
                if t < low || t > high || high == low {
                    return false;
                }
                b["time"] = json!(t - shift);
            } else {
                let a = t.max(low);
                let z = t.saturating_add(duration).min(high);
                if z <= a {
                    return false;
                }
                b["time"] = json!(a - shift);
                b["duration"] = json!(z - a);
            }
            true
        });
    }
    Ok(())
}
pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.crop",
        "Start End: crop the entire scene at a time",
        "Classic-only scene-wide Start/End crop in exact ticks (120000/second). Start keeps content at/after time and rebases all tracks to zero; End keeps content before time. Cross-boundary source clips, retiming, timed words, animation curves, transitions, caption sources and bookmarks are cropped together. Hidden/muted tracks participate. Changed locked tracks reject atomically. Preserves source/media bindings, unknown fields and other scenes. Requires project, scene and expectedRevision; supports dry run, idempotent retries, cancellation, atomic transactions and Undo/Redo. Never deletes media files.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "start", "end", "trim", "crop", "timeline"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                tick(&json!(input.time))?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Start End",
                    Some(input.expected_revision),
                    |document| {
                        if context.cancellation.is_cancelled() {
                            return Err(CapabilityError::Failed("Start End cancelled".into()));
                        }
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(invalid("Target project is not active"));
                        }
                        let classic = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires Classic project"))?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .and_then(|s| s.iter_mut().find(|s| s["id"] == input.scene_id))
                            .ok_or_else(|| invalid("Scene not found"))?;
                        apply(scene, input.edge, input.time)?;
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Applied Start End")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
