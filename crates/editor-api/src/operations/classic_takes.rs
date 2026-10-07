//! Smart take assemblies: immutable source archive, semantic alternatives, one canonical edit.
//! Provider inference happens outside the transaction; all slicing, validation and reflow is Rust.
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

const TPS: f64 = 120_000.0;
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Part {
    #[schemars(range(max = 14999))]
    pub first_word: usize,
    #[schemars(range(max = 14999))]
    pub last_word: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Alternative {
    pub label: String,
    pub reason: String,
    #[schemars(length(min = 1, max = 100))]
    pub parts: Vec<Part>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Group {
    pub label: String,
    #[schemars(range(min = 0, max = 1))]
    pub confidence: f64,
    #[schemars(range(max = 19))]
    pub selected: usize,
    #[schemars(length(min = 1, max = 20))]
    pub alternatives: Vec<Alternative>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Discard {
    #[schemars(range(max = 14999))]
    pub first_word: usize,
    #[schemars(range(max = 14999))]
    pub last_word: usize,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Plan {
    #[schemars(length(min = 1, max = 1000))]
    pub groups: Vec<Group>,
    #[schemars(length(max = 15000))]
    pub discarded: Vec<Discard>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Word {
    id: usize,
    source_index: usize,
    clip_id: String,
    text: String,
    start: i64,
    end: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assembly {
    version: u32,
    id: String,
    element_ids: Vec<String>,
    source_tracks: Value,
    source_bookmarks: Value,
    plan: Plan,
    applied_digest: String,
    source_words: Vec<Word>,
    recommendations: Vec<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    element_ids: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    revision: u64,
    words: Vec<Word>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    Assemble {
        #[serde(rename = "elementIds")]
        element_ids: Vec<String>,
        plan: Plan,
    },
    Select {
        #[serde(rename = "groupIndex")]
        group_index: usize,
        #[serde(rename = "alternativeIndex")]
        alternative_index: usize,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    change: Change,
}
fn invalid(s: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn tick(v: &Value) -> Result<i64, CapabilityError> {
    v.as_i64()
        .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid("Take timing must use nonnegative safe integer ticks"))
}
fn seconds(v: &Value) -> Result<i64, CapabilityError> {
    let value = v
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 1e9)
        .ok_or_else(|| invalid("Invalid transcript word time"))?;
    Ok((value * TPS).round() as i64)
}
fn digest(tracks: &Value, bookmarks: &Value) -> String {
    // JS round-trips integral floats as integers. Normalize numeric representation
    // before hashing so a WASM read/save/reopen does not masquerade as an edit.
    fn normalize(value: &mut Value) {
        match value {
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() <= crate::classic::MAX_SAFE_INTEGER as f64 {
                        *n = serde_json::Number::from(f as i64);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(normalize),
            Value::Object(fields) => fields.values_mut().for_each(normalize),
            _ => {}
        }
    }
    let mut value = json!([tracks, bookmarks]);
    normalize(&mut value);
    format!("{:x}", Sha256::digest(serde_json::to_vec(&value).unwrap()))
}

fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(arr(&tracks["overlay"]))
        .chain(arr(&tracks["audio"]))
}
fn source(tracks: &Value) -> Result<&Value, CapabilityError> {
    let index = classic_timeline::caption_source_track_index(tracks)
        .ok_or_else(|| invalid("Transcribe the scene before assembling takes"))?;
    let source = &tracks["overlay"][index]["captionSource"];
    if all(tracks).any(|t| {
        t["captionSource"].is_object() && !classic_timeline::caption_sources_match(t, source)
    }) {
        return Err(invalid("Use one transcript source for the take assembly"));
    }
    Ok(source)
}
fn inventory(tracks: &Value, ids: &[String]) -> Result<(Vec<Word>, i64, i64), CapabilityError> {
    let unique: HashSet<_> = ids.iter().collect();
    if ids.is_empty() || ids.len() > 1000 || unique.len() != ids.len() {
        return Err(invalid("Select 1..1000 distinct main-track videos"));
    }
    let mut clips: Vec<_> = arr(&tracks["main"]["elements"])
        .iter()
        .filter(|e| ids.iter().any(|id| e["id"] == *id))
        .collect();
    if clips.len() != ids.len() || clips.iter().any(|e| e["type"] != "video") {
        return Err(invalid("Smart takes requires videos on the main track"));
    }
    clips.sort_by_key(|e| e["startTime"].as_i64());
    let start = tick(&clips[0]["startTime"])?;
    let mut end = start;
    for clip in &clips {
        let s = tick(&clip["startTime"])?;
        if s < end {
            return Err(invalid("Selected videos must not overlap"));
        }
        // Gaps are intentionally removed, but unselected clips are never removed implicitly.
        end = s + tick(&clip["duration"])?;
        if clip.get("unifiedAngles").is_some() || clip.get("sourceAudio").is_some() {
            return Err(invalid(
                "Flatten compound/source-audio clips before assembling takes",
            ));
        }
    }
    for clip in arr(&tracks["main"]["elements"]) {
        if tick(&clip["startTime"])? < end
            && tick(&clip["startTime"])? + tick(&clip["duration"])? > start
            && !ids.iter().any(|id| clip["id"] == *id)
        {
            return Err(invalid(
                "Select every main-track clip between the first and last take",
            ));
        }
    }
    let transcript = source(tracks)?;
    let mut words = vec![];
    for (source_index, word) in arr(&transcript["words"]).iter().enumerate() {
        if word["source"]["type"] == "text-layer" {
            continue;
        }
        let s = seconds(&word["start"])?;
        let e = seconds(&word["end"])?;
        if e <= s {
            return Err(invalid("Transcript words must have positive duration"));
        }
        let mid = s + (e - s) / 2;
        if let Some(clip) = clips.iter().find(|clip| {
            mid >= clip["startTime"].as_i64().unwrap()
                && mid < clip["startTime"].as_i64().unwrap() + clip["duration"].as_i64().unwrap()
        }) {
            let clip_start = tick(&clip["startTime"])?;
            let clip_end = clip_start + tick(&clip["duration"])?;
            words.push(Word {
                id: 0,
                source_index,
                clip_id: clip["id"].as_str().unwrap().into(),
                text: word["text"].as_str().unwrap_or("").into(),
                start: s.max(clip_start),
                end: e.min(clip_end),
            });
        }
    }
    words.sort_by_key(|w| (w.start, w.end));
    for (i, w) in words.iter_mut().enumerate() {
        w.id = i;
    }
    if words.is_empty() || words.len() > 15000 {
        return Err(invalid(
            "Select transcribed footage containing 1..15000 words",
        ));
    }
    // Manual text within the edited region cannot safely be re-attributed to new spoken words.
    if arr(&transcript["words"]).iter().any(|w| {
        w["source"]["type"] == "text-layer"
            && seconds(&w["start"]).is_ok_and(|s| s < end)
            && seconds(&w["end"]).is_ok_and(|e| e > start)
    }) {
        return Err(invalid(
            "Resolve manually owned transcript words in the selected region first",
        ));
    }
    Ok((words, start, end))
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 2000
}
fn range(part: &Part, words: &[Word]) -> Result<std::ops::RangeInclusive<usize>, CapabilityError> {
    if part.first_word > part.last_word
        || part.last_word >= words.len()
        || words[part.first_word].clip_id != words[part.last_word].clip_id
    {
        return Err(invalid(
            "Take part must reference an ordered word range within one source clip",
        ));
    }
    Ok(part.first_word..=part.last_word)
}
fn validate_plan(plan: &Plan, words: &[Word]) -> Result<(), CapabilityError> {
    if plan.groups.is_empty() || plan.groups.len() > 1000 || plan.discarded.len() > 15000 {
        return Err(invalid("Take plan must contain 1..1000 story groups"));
    }
    if plan
        .groups
        .iter()
        .flat_map(|g| &g.alternatives)
        .map(|a| a.parts.len())
        .sum::<usize>()
        > 20000
    {
        return Err(invalid("Take alternatives exceed the 20000-part budget"));
    }
    let mut owners = vec![None; words.len()];
    for (gi, g) in plan.groups.iter().enumerate() {
        if !label(&g.label)
            || !g.confidence.is_finite()
            || !(0.0..=1.0).contains(&g.confidence)
            || g.alternatives.is_empty()
            || g.alternatives.len() > 20
            || g.selected >= g.alternatives.len()
        {
            return Err(invalid(
                "Invalid take group, confidence or selected alternative",
            ));
        }
        let mut signatures = HashSet::new();
        for a in &g.alternatives {
            if !label(&a.label) || !label(&a.reason) || a.parts.is_empty() || a.parts.len() > 100 {
                return Err(invalid(
                    "Alternative needs a label, rationale and 1..100 parts",
                ));
            }
            if !signatures.insert(serde_json::to_string(&a.parts).unwrap()) {
                return Err(invalid("Duplicate take alternative"));
            }
            let mut used = HashSet::new();
            let mut spans = vec![];
            for p in &a.parts {
                for i in range(p, words)? {
                    if !used.insert(i) || owners[i].is_some_and(|owner| owner != gi) {
                        return Err(invalid(
                            "A source word cannot repeat within a take or belong to different story groups",
                        ));
                    }
                    owners[i] = Some(gi);
                }
                let span = (words[p.first_word].start, words[p.last_word].end);
                if spans.iter().any(|(s, e)| span.0 < *e && span.1 > *s) {
                    return Err(invalid("Overlapping source spans within an alternative"));
                }
                spans.push(span);
            }
        }
    }
    for d in &plan.discarded {
        if !label(&d.reason) {
            return Err(invalid("Every discarded range requires a reason"));
        }
        for i in range(
            &Part {
                first_word: d.first_word,
                last_word: d.last_word,
            },
            words,
        )? {
            if owners[i].is_some() {
                return Err(invalid(
                    "Discarded speech overlaps a take or another discard",
                ));
            }
            owners[i] = Some(usize::MAX);
        }
    }
    if owners.iter().any(Option::is_none) {
        return Err(invalid(
            "Every source word must be assigned to a take or an explicit discard",
        ));
    }
    Ok(())
}
/// Called by ClassicProject::validate, including app.state.patch and session restoration.
pub(crate) fn validate_scene(scene: &Value, asset_ids: &HashSet<&str>) -> Result<(), String> {
    let Some(value) = scene.get("takeAssembly") else {
        return Ok(());
    };
    let a: Assembly = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    if a.version != 1 || !label(&a.id) || a.applied_digest.len() != 64 {
        return Err("Invalid take assembly version/identity".into());
    }
    let archive_scene = json!({"tracks":a.source_tracks});
    let tracks = crate::classic::tracks(&archive_scene).map_err(|e| e.to_string())?;
    let mut ids = HashSet::new();
    for track in tracks {
        let track_id = track["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Archived track ID missing")?;
        if !ids.insert(track_id) {
            return Err("Duplicate archived track or clip ID".into());
        }
        let elements = track["elements"]
            .as_array()
            .ok_or("Archived track elements must be an array")?;
        if elements.len() > 100000 {
            return Err("Archived take track is too large".into());
        }
        for clip in elements {
            let id = clip["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("Archived clip ID missing")?;
            if !ids.insert(id) {
                return Err("Duplicate archived track or clip ID".into());
            }
            for field in ["startTime", "duration", "trimStart", "trimEnd"] {
                tick(&clip[field]).map_err(|e| e.to_string())?;
            }
            if clip["startTime"].as_i64().unwrap() + clip["duration"].as_i64().unwrap()
                > crate::classic::MAX_SAFE_INTEGER
            {
                return Err("Archived clip end exceeds safe timing".into());
            }
            if let Some(media) = clip.get("mediaId") {
                if !media.as_str().is_some_and(|id| asset_ids.contains(id)) {
                    return Err("Take alternatives reference missing source media".into());
                }
            }
        }
    }
    for b in arr(&a.source_bookmarks) {
        tick(&b["time"]).map_err(|e| e.to_string())?;
    }
    let (words, _, _) = inventory(&a.source_tracks, &a.element_ids).map_err(|e| e.to_string())?;
    if serde_json::to_value(&a.source_words).unwrap() != serde_json::to_value(&words).unwrap()
        || a.recommendations.len() != a.plan.groups.len()
        || a.recommendations
            .iter()
            .zip(&a.plan.groups)
            .any(|(i, g)| *i >= g.alternatives.len())
    {
        return Err("Invalid take source evidence or recommendations".into());
    }
    validate_plan(&a.plan, &words).map_err(|e| e.to_string())
}

pub(super) fn register_classic_takes(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    register::<Prepare, Prepared, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.takes.prepare",
        "Read smart-take source words",
        "Read bounded word-indexed source evidence for selected main-track videos. Returns revision and word IDs with original clip identity and absolute integer tick timing. No inference or IO; generated transcript only. Contiguous selection (gaps allowed), one caption source. Use the returned revision for takes.edit. Up to 15000 words. Cancellation supported.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "takes", "transcript"],
        move |context, input| {
            let state = read_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("Take preparation cancelled".into()));
                }
                let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                if store.active_project_id() != Some(input.project_id.as_str())
                    || store.document.revision != input.expected_revision
                {
                    return Err(CapabilityError::Conflict(
                        "Take source project or revision changed".into(),
                    ));
                }
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| invalid("Classic project required"))?;
                let scene = arr(&classic.document["scenes"])
                    .iter()
                    .find(|s| s["id"] == input.scene_id)
                    .ok_or_else(|| invalid("Scene not found"))?;
                let (words, _, _) = inventory(&scene["tracks"], &input.element_ids)?;
                Ok(OperationSuccess::new(Prepared {
                    revision: store.document.revision,
                    words,
                }))
            }
        },
    )?;
    register::<Edit, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.takes.edit",
        "Assemble or select smart takes",
        "Atomically apply a semantic story plan or select a group's alternative, including multi-cut alternatives of unequal duration. Plan groups are in narrative order, selected indexes are recommendations, parts reference inclusive word IDs from takes.prepare, discarded ranges require reasons, and every word must be accounted for. No AI/network inside this capability. Retains immutable source tracks/bookmarks and all alternatives in scene.takeAssembly; no source files deleted. Rebuilds transcript/captions, retimed trims, animation slices and synchronized tracks; ripples following material. Selection rejects subsequent timeline/bookmark edits rather than overwriting them. Explicit project/scene/revision; registry idempotency, dry run, cancellation, transactions and Undo/Redo. Read state through app.state.read.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "takes", "alternatives", "assembly", "transcript"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let result = mutate(
                    &state,
                    &events,
                    &context,
                    "Smart take assembly",
                    Some(input.expected_revision),
                    |document| {
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        let scene = arr(&classic.document["scenes"])
                            .iter()
                            .find(|s| s["id"] == input.scene_id)
                            .ok_or_else(|| invalid("Scene not found"))?
                            .clone();
                        let mut assembly = match input.change {
                            Change::Assemble { element_ids, plan } => {
                                if scene.get("takeAssembly").is_some() {
                                    return Err(invalid(
                                        "This scene already has take alternatives. Undo the assembly or use a new scene to analyze again",
                                    ));
                                }
                                Assembly {
                                    source_words: vec![],
                                    recommendations: plan
                                        .groups
                                        .iter()
                                        .map(|g| g.selected)
                                        .collect(),
                                    version: 1,
                                    id: format!("takes-{}", document.revision),
                                    element_ids,
                                    source_tracks: scene["tracks"].clone(),
                                    source_bookmarks: scene["bookmarks"].clone(),
                                    plan,
                                    applied_digest: String::new(),
                                }
                            }
                            Change::Select {
                                group_index,
                                alternative_index,
                            } => {
                                let mut a: Assembly =
                                    serde_json::from_value(scene["takeAssembly"].clone())
                                        .map_err(|_| invalid("No take assembly in this scene"))?;
                                if a.applied_digest != digest(&scene["tracks"], &scene["bookmarks"])
                                {
                                    return Err(CapabilityError::Conflict("Timeline changed after the assembly. Undo those edits before switching takes".into()));
                                }
                                let g = a
                                    .plan
                                    .groups
                                    .get_mut(group_index)
                                    .ok_or_else(|| invalid("Take group not found"))?;
                                if alternative_index >= g.alternatives.len() {
                                    return Err(invalid("Take alternative not found"));
                                }
                                g.selected = alternative_index;
                                a
                            }
                        };
                        let (words, start, end) =
                            inventory(&assembly.source_tracks, &assembly.element_ids)?;
                        validate_plan(&assembly.plan, &words)?;
                        assembly.source_words = words.clone();
                        let canvas = classic_scenes::classic_target(document, &input.project_id)?
                            .document["settings"]["canvasSize"]
                            .clone();
                        let mut occupied = HashSet::new();
                        collect_ids(
                            &serde_json::to_value(&document.project).unwrap(),
                            &mut occupied,
                        );
                        let mut fresh =
                            || classic_duplicate::fresh(document, &mut occupied, "take");
                        let (tracks, bookmarks) =
                            render(&assembly, &words, start, end, &canvas, &mut fresh, &context)?;
                        assembly.applied_digest = digest(&tracks, &bookmarks);
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        let target = classic
                            .document
                            .get_mut("scenes")
                            .unwrap()
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .unwrap();
                        target["tracks"] = tracks;
                        target["bookmarks"] = bookmarks;
                        target["takeAssembly"] = serde_json::to_value(assembly).unwrap();
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                            json!(classic_scenes::timestamp()?);
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(result)
                    .summary("Updated smart take assembly")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
#[derive(Clone)]
struct Span {
    from: i64,
    to: i64,
    dest: i64,
    group: Option<usize>,
    word_indices: Option<HashSet<usize>>,
}
fn slice(
    original: &Value,
    from: i64,
    to: i64,
    dest: i64,
    fresh: &mut dyn FnMut() -> String,
) -> Result<Value, CapabilityError> {
    let start = tick(&original["startTime"])?;
    let duration = tick(&original["duration"])?;
    let offset = from - start;
    let length = to - from;
    let rate = if matches!(original["type"].as_str(), Some("video" | "audio")) {
        classic_update::rate(original)
    } else {
        1.0
    };
    let mut clip = original.clone();
    clip["id"] = json!(fresh());
    clip["startTime"] = json!(dest);
    clip["duration"] = json!(length);
    clip["trimStart"] =
        json!(tick(&original["trimStart"])? + (offset as f64 * rate).round() as i64);
    clip["trimEnd"] = json!(
        tick(&original["trimEnd"])? + (duration as f64 * rate).round() as i64
            - ((offset + length) as f64 * rate).round() as i64
    );
    if offset > 0 || length != duration {
        if original["type"] == "text" && !arr(&original["wordRuns"]).is_empty() {
            return Err(invalid(
                "Move manually authored text outside the take region before assembling",
            ));
        }
        let (_, right) =
            classic_keyframes::split_animations(&original["animations"], offset, &fresh())?;
        let (animation, _) = classic_keyframes::split_animations(&right, length, &fresh())?;
        if animation.is_null() {
            clip.as_object_mut().unwrap().remove("animations");
        } else {
            clip["animations"] = animation;
        }
        classic_update::transitions(&mut clip, original)?;
    }
    Ok(clip)
}
fn render(
    a: &Assembly,
    words: &[Word],
    start: i64,
    end: i64,
    canvas: &Value,
    fresh: &mut dyn FnMut() -> String,
    context: &InvocationContext,
) -> Result<(Value, Value), CapabilityError> {
    let mut spans = vec![];
    if start > 0 {
        spans.push(Span {
            from: 0,
            to: start,
            dest: 0,
            group: None,
            word_indices: None,
        });
    }
    let mut cursor = start;
    for (gi, g) in a.plan.groups.iter().enumerate() {
        for part in &g.alternatives[g.selected].parts {
            let from = words[part.first_word].start;
            let to = words[part.last_word].end;
            spans.push(Span {
                from,
                to,
                dest: cursor,
                group: Some(gi),
                word_indices: Some(
                    (part.first_word..=part.last_word)
                        .map(|i| words[i].source_index)
                        .collect(),
                ),
            });
            cursor += to - from;
        }
    }
    let mut max_end = all(&a.source_tracks)
        .flat_map(|t| arr(&t["elements"]))
        .map(|e| tick(&e["startTime"]).and_then(|s| Ok(s + tick(&e["duration"])?)))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .unwrap_or(end)
        .max(end);
    // Markers can intentionally outlive the last clip. They must ripple, not vanish.
    for bookmark in arr(&a.source_bookmarks) {
        let duration = bookmark
            .get("duration")
            .filter(|v| !v.is_null())
            .map(tick)
            .transpose()?
            .unwrap_or(0);
        let bound = tick(&bookmark["time"])?
            .checked_add(duration)
            .and_then(|v| v.checked_add(1))
            .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("Bookmark range exceeds safe take timing"))?;
        max_end = max_end.max(bound);
    }
    if max_end > end {
        spans.push(Span {
            from: end,
            to: max_end,
            dest: cursor,
            group: None,
            word_indices: None,
        });
    }
    let transcript = source(&a.source_tracks)?;
    let mut tracks = a.source_tracks.clone();
    for track in std::iter::once(&mut tracks["main"]) {
        remap_track(track, &spans, a, fresh, context)?;
    }
    for key in ["overlay", "audio"] {
        for track in tracks[key].as_array_mut().into_iter().flatten() {
            if !track["captionSource"].is_object() {
                remap_track(track, &spans, a, fresh, context)?;
            }
        }
    }
    let mut mapped_words = vec![];
    for span in &spans {
        for (index, w) in arr(&transcript["words"]).iter().enumerate() {
            let s = seconds(&w["start"])?;
            let e = seconds(&w["end"])?;
            let mid = s + (e - s) / 2;
            if span
                .word_indices
                .as_ref()
                .map_or(mid >= span.from && mid < span.to, |ids| {
                    ids.contains(&index)
                })
            {
                let mut word = w.clone();
                word["start"] = json!((span.dest + s.max(span.from) - span.from) as f64 / TPS);
                word["end"] = json!((span.dest + e.min(span.to) - span.from) as f64 / TPS);
                mapped_words.push(word);
            }
        }
    }
    mapped_words.sort_by(|a, b| {
        a["start"]
            .as_f64()
            .partial_cmp(&b["start"].as_f64())
            .unwrap()
    });
    let template = arr(&a.source_tracks["overlay"])
        .iter()
        .filter(|t| t["captionSource"].is_object())
        .flat_map(|t| arr(&t["elements"]))
        .next()
        .cloned()
        .unwrap_or_else(|| json!({"type":"text","trimStart":0,"trimEnd":0,"params":{}}));
    let request = json!({"tracks":tracks,"words":mapped_words,"settings":transcript["settings"],"canvasSize":canvas,
        "layerCount":transcript["layerCount"],"preserveEditedElements":true,"trackDefaults":{"type":"text","hidden":false,"elements":[]},
        "defaults":{"element":template,"bottomFadeOutEndOpacity":0.25},"fontSizeScaleReference":90});
    let rebuilt = classic_timeline::rebuild_caption_scene(&request, &mut || Ok(fresh()), None)
        .map_err(invalid)?;
    let mut tracks = rebuilt
        .tracks
        .ok_or_else(|| invalid("Could not rebuild take transcript"))?;
    // Resolve explicit shared-value references returned by the same caption builder used by the UI.
    for r in rebuilt.references {
        let value = request
            .pointer(&r.source)
            .ok_or_else(|| invalid("Invalid caption reference"))?
            .clone();
        *tracks
            .pointer_mut(&r.target)
            .ok_or_else(|| invalid("Invalid caption target"))? = value;
    }
    // The caption builder separates manually edited caption clips into new tracks.
    // Remap these too, preserving unaffected authored text rather than dropping it.
    let old_track_ids: HashSet<_> = all(&a.source_tracks)
        .filter_map(|t| t["id"].as_str())
        .collect();
    for track in tracks["overlay"].as_array_mut().into_iter().flatten() {
        if !track["captionSource"].is_object()
            && !old_track_ids.contains(track["id"].as_str().unwrap_or(""))
        {
            remap_track(track, &spans, a, fresh, context)?;
        }
    }
    let mut bookmarks = vec![];
    for span in &spans {
        for b in arr(&a.source_bookmarks) {
            let time = tick(&b["time"])?;
            if time >= span.from && time < span.to {
                let mut note = b.clone();
                note["time"] = json!(span.dest + time - span.from);
                if let Some(d) = b.get("duration") {
                    note["duration"] = json!(tick(d)?.min(span.to - time));
                }
                bookmarks.push(note);
            }
        }
    }
    bookmarks.sort_by_key(|b| b["time"].as_i64());
    Ok((tracks, json!(bookmarks)))
}
fn remap_track(
    track: &mut Value,
    spans: &[Span],
    a: &Assembly,
    fresh: &mut dyn FnMut() -> String,
    context: &InvocationContext,
) -> Result<(), CapabilityError> {
    let mut result = vec![];
    for span in spans {
        for clip in arr(&track["elements"]) {
            if context.cancellation.is_cancelled() {
                return Err(CapabilityError::Failed("Take assembly cancelled".into()));
            }
            let start = tick(&clip["startTime"])?;
            let end = start + tick(&clip["duration"])?;
            let from = start.max(span.from);
            let to = end.min(span.to);
            if from >= to {
                continue;
            }
            let mut next = if span.group.is_none() && from == start && to == end {
                let mut c = clip.clone();
                c["startTime"] = json!(span.dest + from - span.from);
                c
            } else {
                slice(clip, from, to, span.dest + from - span.from, fresh)?
            };
            if let Some(group) = span.group {
                if a.element_ids.iter().any(|id| clip["id"] == *id) {
                    next["takeGroup"] = json!({"assemblyId":a.id,"groupIndex":group});
                }
            }
            if result.len() >= 20000 {
                return Err(invalid(
                    "Take assembly exceeds the 20000-clip per-track bound",
                ));
            }
            result.push(next);
        }
    }
    result.sort_by_key(|e| e["startTime"].as_i64());
    track["elements"] = json!(result);
    Ok(())
}
