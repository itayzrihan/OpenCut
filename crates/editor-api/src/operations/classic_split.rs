//! Exact-tick, undoable Classic splitting with a single source-side round.
use super::*;
use serde_json::json;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ref {
    pub(super) track_id: String,
    pub(super) element_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) enum Side {
    Both,
    Left,
    Right,
}
impl Default for Side {
    fn default() -> Self {
        Self::Both
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    pub(super) project_id: String,
    pub(super) scene_id: String,
    pub(super) expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    pub(super) elements: Vec<Ref>,
    #[schemars(range(min = 0, max = 9007199254740991_i64))]
    pub(super) split_time: i64,
    #[serde(default)]
    pub(super) retain_side: Side,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    right_elements: Vec<Ref>,
    skipped: Vec<Ref>,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().into_iter().flatten())
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
fn tick(v: &Value) -> Result<i64, CapabilityError> {
    v.as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| invalid("Invalid safe integer clip time"))
}
fn rounded(v: f64) -> Result<i64, CapabilityError> {
    if !v.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&v) {
        return Err(invalid("Source split time overflow"));
    }
    Ok((v + 0.5).floor() as i64)
}
fn animation(clip: &mut Value, value: Value) {
    if value.is_null() {
        clip.as_object_mut().unwrap().remove("animations");
    } else {
        clip["animations"] = value;
    }
}
fn text_parts(
    original: &Value,
    relative: i64,
    partition_timed_text: bool,
) -> Result<Option<(Value, Value)>, CapabilityError> {
    let duration = tick(&original["duration"])?;
    let (left, right): (Vec<_>, Vec<_>) = classic_text::timed_words(original)?
        .into_iter()
        .partition(|(_, start, end, _)| (*start as f64 + *end as f64) / 2.0 <= relative as f64);
    let explicitly_timed = partition_timed_text
        && original["wordRuns"].as_array().is_some_and(|runs| {
            runs.iter()
                .any(|run| run["startTime"].is_number() && run["endTime"].is_number())
        });
    if (left.is_empty() || right.is_empty()) && !explicitly_timed {
        return Ok(None);
    }
    Ok(Some((
        classic_text::build_part(original, left, 0, relative, false, false),
        classic_text::build_part(original, right, relative, duration - relative, false, false),
    )))
}
pub(super) fn register_classic_split(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.split",
        "Split Classic clips or retain one side",
        "Split 1..1000 explicit trackId/elementId clips at an absolute safe integer splitTime in ticks (120000/second). retainSide is both (default), left or right. Out-of-range or exact-edge targets are returned in skipped; missing or duplicate targets reject the complete edit. Snap the retimed source boundary once and derive the right span so trim halves sum exactly to the original source span. Splits scalar/discrete/composite animations, preserving Bezier curves. Text with words on both sides partitions by word midpoint, rebases timing, row overrides and content; text fallback splits the whole visual layer. New right clip IDs come from the canonical allocator; a text right-only word split retains its original ID. Returns rightElements for selection/readback. Retains media, retime, effects, masks, transition fields and extension fields, synchronizes transcript/word ownership; reciprocal audio/video pairs split together and each result pair is relinked. No ripple. Generated caption visual reflow is excluded. Supports dry run, optimistic revision, idempotent registry retries, cancellation, transactions and Undo/Redo.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "split", "clip", "cut", "חיתוך", "פיצול"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut right_elements = vec![];
                let mut skipped = vec![];
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Split Classic clips",
                    Some(input.expected_revision),
                    |document| {
                        split_document(
                            document,
                            &input,
                            &context,
                            &mut right_elements,
                            &mut skipped,
                            false,
                        )
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    right_elements,
                    skipped,
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

pub(super) fn split_document(
    document: &mut EditorDocument,
    input: &Input,
    context: &InvocationContext,
    right_elements: &mut Vec<Ref>,
    skipped: &mut Vec<Ref>,
    partition_timed_text: bool,
) -> Result<Vec<String>, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(CapabilityError::Conflict(
            "Split target project is not active".into(),
        ));
    }
    let before = project
        .classic
        .as_ref()
        .ok_or_else(|| invalid("Requires Classic project"))?
        .document["scenes"]
        .as_array()
        .and_then(|v| v.iter().find(|s| s["id"] == input.scene_id))
        .ok_or_else(|| invalid("Scene not found"))?["tracks"]
        .clone();
    let mut requested = HashSet::new();
    for target in &input.elements {
        if !requested.insert((target.track_id.clone(), target.element_id.clone())) {
            return Err(invalid("Duplicate split target"));
        }
        if !all(&before)
            .find(|t| t["id"] == target.track_id)
            .and_then(|t| t["elements"].as_array())
            .is_some_and(|v| v.iter().any(|e| e["id"] == target.element_id))
        {
            return Err(invalid("Split clip not found in target track"));
        }
    }
    for target in &input.elements {
        let (_, clip) = classic_source_audio::find_clip(&before, &target.element_id).unwrap();
        if let Some((track, other)) = classic_source_audio::peer(&before, clip) {
            requested.insert((
                track["id"].as_str().unwrap().to_owned(),
                other["id"].as_str().unwrap().to_owned(),
            ));
        }
    }
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).unwrap(),
        &mut occupied,
    );
    let mut tracks = before.clone();
    let mut replacements = vec![];
    let mut retained = vec![];
    let mut removed = vec![];
    let mut split_ids = std::collections::HashMap::new();
    for track in all(&before) {
        for original in track["elements"].as_array().into_iter().flatten() {
            let target = Ref {
                track_id: track["id"].as_str().unwrap().into(),
                element_id: original["id"].as_str().unwrap().into(),
            };
            if !requested.contains(&(target.track_id.clone(), target.element_id.clone())) {
                continue;
            }
            if context.cancellation.is_cancelled() {
                return Err(CapabilityError::Failed("Split cancelled".into()));
            }
            let start = tick(&original["startTime"])?;
            let duration = tick(&original["duration"])?;
            let end = start
                .checked_add(duration)
                .filter(|e| *e <= 9_007_199_254_740_991)
                .ok_or_else(|| invalid("Clip end exceeds safe ticks"))?;
            if input.split_time <= start || input.split_time >= end {
                skipped.push(target);
                continue;
            }
            let relative = input.split_time - start;
            let text = if original["type"] == "text" {
                text_parts(original, relative, partition_timed_text)?
            } else {
                None
            };
            let right_id = if text.is_some() && matches!(input.retain_side, Side::Right) {
                target.element_id.clone()
            } else {
                classic_duplicate::fresh(document, &mut occupied, "classic-clip")
            };
            let boundary = classic_duplicate::fresh(document, &mut occupied, "split-key");
            let (left_animation, right_animation) =
                classic_keyframes::split_animations(&original["animations"], relative, &boundary)?;
            let (mut left, mut right) = if let Some(parts) = text {
                parts
            } else {
                let source_left = rounded(classic_update::source_span(original, relative)?)?;
                let total = rounded(classic_update::source_span(original, duration)?)?;
                let mut l = original.clone();
                let mut r = original.clone();
                l["duration"] = json!(relative);
                l["trimEnd"] = json!(tick(&original["trimEnd"])? + total - source_left);
                r["duration"] = json!(duration - relative);
                r["trimStart"] = json!(tick(&original["trimStart"])? + source_left);
                (l, r)
            };
            left["name"] = json!(format!(
                "{} (left)",
                original["name"].as_str().unwrap_or("")
            ));
            right["name"] = json!(format!(
                "{} (right)",
                original["name"].as_str().unwrap_or("")
            ));
            right["id"] = json!(right_id);
            right["startTime"] = json!(input.split_time);
            animation(&mut left, left_animation);
            animation(&mut right, right_animation);
            for clip in [&left, &right] {
                for field in ["startTime", "duration", "trimStart", "trimEnd"] {
                    tick(&clip[field])?;
                }
            }
            let right_ref = Ref {
                track_id: target.track_id.clone(),
                element_id: right_id,
            };
            split_ids.insert(target.element_id.clone(), right_ref.element_id.clone());
            let values = match input.retain_side {
                Side::Left => {
                    retained.push(target.clone());
                    vec![left]
                }
                Side::Right => {
                    if target.element_id != right_ref.element_id {
                        removed.push(classic_remove::ElementRef {
                            track_id: target.track_id.clone(),
                            element_id: target.element_id.clone(),
                        });
                    } else {
                        retained.push(target.clone());
                    }
                    right_elements.push(right_ref);
                    vec![right]
                }
                Side::Both => {
                    retained.push(target.clone());
                    right_elements.push(right_ref);
                    vec![left, right]
                }
            };
            replacements.push((target, values));
        }
    }
    for (target, mut values) in replacements {
        if !matches!(input.retain_side, Side::Left) {
            let right = values.last_mut().unwrap();
            if let Some(id) = right[classic_source_audio::LINK].as_str() {
                if let Some(peer_id) = split_ids.get(id) {
                    right[classic_source_audio::LINK] = json!(peer_id);
                } else {
                    right
                        .as_object_mut()
                        .unwrap()
                        .remove(classic_source_audio::LINK);
                }
            }
        }
        let main = tracks["main"]["id"] == target.track_id;
        let track = if main {
            &mut tracks["main"]
        } else {
            tracks
                .as_object_mut()
                .unwrap()
                .iter_mut()
                .filter(|(k, _)| matches!(k.as_str(), "overlay" | "audio"))
                .flat_map(|(_, v)| v.as_array_mut().into_iter().flatten())
                .find(|t| t["id"] == target.track_id)
                .unwrap()
        };
        let elements = track["elements"].as_array_mut().unwrap();
        let index = elements
            .iter()
            .position(|e| e["id"] == target.element_id)
            .unwrap();
        elements.splice(index..index + 1, values);
    }
    if !removed.is_empty() {
        classic_captions::reconcile_words(&mut tracks, &removed)?;
    }
    classic_captions::sync_after_edit(&mut tracks, &before, &json!(retained))?;
    classic_captions::reconcile_words(&mut tracks, &[])?;
    let scene = project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == input.scene_id)
        .unwrap();
    scene["tracks"] = tracks;
    Ok(input
        .elements
        .iter()
        .map(|e| e.element_id.clone())
        .chain(right_elements.iter().map(|e| e.element_id.clone()))
        .collect())
}
