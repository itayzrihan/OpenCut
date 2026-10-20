//! Classic transcription checkpoints and incremental publication. Inference and
//! disk IO belong to the host; source-clock mapping and document edits live here.
use super::classic_scenes::classic_target;
use super::*;
use classic_timeline::{ClipAudioTimingOptions, resolve_clip_audio_timing};
use serde_json::json;
use std::collections::BTreeMap;
const TPS: f64 = 120000.0;
const SECTION: f64 = 60.0;
fn invalid(s: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn n(v: &Value, fallback: f64) -> f64 {
    v.as_f64().unwrap_or(fallback)
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(arr(&tracks["audio"]))
        .chain(arr(&tracks["overlay"]))
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Word {
    text: String,
    start: f64,
    end: f64,
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Engine {
    #[default]
    Local,
    External,
}
pub(crate) fn validate_engine(value: Option<&Value>) -> Result<(), String> {
    if let Some(v) = value {
        serde_json::from_value::<Engine>(v.clone())
            .map_err(|_| "Invalid transcription engine".to_string())?;
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    scene_id: String,
    language: String,
    settings: Value,
    defaults: Value,
    #[serde(default)]
    engine: Engine,
    #[serde(default)]
    external_configuration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference_element_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    reference_regions: Vec<classic_takes::PodcastReferenceRegion>,
    source_tracks: Value,
    source_media: Vec<Map<String, Value>>,
    total_duration: i64,
    status: Status,
    #[serde(deserialize_with = "deserialize_chunks")]
    chunks: BTreeMap<usize, Vec<Word>>,
}
// Tagged enums deserialize through Serde's content representation, whose
// map keys do not coerce JSON strings to usize. Preserve the JSON map decoder.
fn deserialize_chunks<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<usize, Vec<Word>>, D::Error> {
    serde_json::from_value(Value::deserialize(d)?).map_err(serde::de::Error::custom)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Status {
    Running,
    Paused,
    Complete,
    Superseded,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    SetEngine {
        engine: Engine,
    },
    ImportSrt {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[schemars(length(max = 5000000))]
        text: String,
        settings: Value,
        defaults: Value,
    },
    Start {
        #[serde(default, rename = "referenceElementIds")]
        reference_element_ids: Option<Vec<String>>,
        #[serde(default)]
        engine: Engine,
        #[serde(default, rename = "externalConfiguration")]
        external_configuration: Option<String>,
        #[serde(rename = "sceneId")]
        scene_id: String,
        language: String,
        settings: Value,
        defaults: Value,
        #[serde(rename = "totalDuration")]
        total_duration: i64,
    },
    Append {
        index: usize,
        #[schemars(length(max = 10000))]
        words: Vec<Word>,
    },
    Restore {
        snapshot: Job,
    },
    Pause,
    Resume,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    job_id: String,
    change: Change,
}

fn validate_job(job: &Job) -> Result<(), String> {
    if job.id.is_empty()
        || job.scene_id.is_empty()
        || job.language.is_empty()
        || job.total_duration <= 0
        || job.total_duration > 86400 * 120000
        || !job.settings.is_object()
        || !job.defaults["element"]["params"].is_object()
        || !job.source_tracks["main"].is_object()
        || !job.source_tracks["audio"].is_array()
        || !job.source_tracks["overlay"].is_array()
    {
        return Err("Invalid transcription source snapshot".into());
    }
    if job.reference_element_ids.is_some() {
        if job.reference_regions.is_empty() || job.reference_regions.len() > 20000 {
            return Err("Invalid scoped transcription regions".into());
        }
        let mut end = -1;
        for r in &job.reference_regions {
            if r.start < 0 || r.start <= end || r.end <= r.start || r.end > job.total_duration {
                return Err("Invalid transcription scope timing".into());
            }
            end = r.end;
        }
        for t in all(&job.source_tracks) {
            for e in arr(&t["elements"]) {
                let a = n(&e["startTime"], -1.0) as i64;
                let b = a + n(&e["duration"], 0.0) as i64;
                if !job
                    .reference_regions
                    .iter()
                    .any(|r| a >= r.start && b <= r.end)
                {
                    return Err("Transcription source exceeds selected reference".into());
                }
            }
        }
    } else if !job.reference_regions.is_empty() {
        return Err("Unbound transcription scope".into());
    }
    if job.engine == Engine::External
        && job
            .external_configuration
            .as_ref()
            .is_none_or(|s| s.is_empty() || s.len() > 128)
    {
        return Err("External transcription requires a configuration identity".into());
    }
    let count = (job.total_duration as f64 / TPS / SECTION).ceil() as usize;
    for (&index, words) in &job.chunks {
        if index >= count || words.len() > 10000 {
            return Err("Invalid transcription section".into());
        }
        for w in words {
            let middle = (w.start + w.end) / 2.0;
            if w.text.trim().is_empty()
                || w.text.len() > 10000
                || !w.start.is_finite()
                || !w.end.is_finite()
                || w.start < 0.0
                || w.end < w.start
                || w.end > job.total_duration as f64 / TPS + 0.001
                || (!job.reference_regions.is_empty()
                    && !job
                        .reference_regions
                        .iter()
                        .any(|r| w.start >= r.start as f64 / TPS && w.end <= r.end as f64 / TPS))
                || middle < index as f64 * SECTION
                || middle >= ((index + 1) as f64 * SECTION).min(job.total_duration as f64 / TPS)
            {
                return Err("Invalid transcription word or section ownership".into());
            }
        }
    }
    if job.status == Status::Complete && job.chunks.len() != count {
        return Err("Incomplete transcription cannot be marked complete".into());
    }
    Ok(())
}
pub(crate) fn validate_jobs(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let jobs: Vec<Job> = serde_json::from_value(value.clone())
        .map_err(|e| format!("Invalid transcription jobs: {e}"))?;
    if jobs.len() > 32 {
        return Err("Too many retained transcription jobs".into());
    }
    let mut ids = HashSet::new();
    for job in jobs {
        if !ids.insert(job.id.clone()) {
            return Err("Duplicate transcription job".into());
        }
        validate_job(&job)?;
    }
    Ok(())
}
struct Span {
    media: String,
    start: f64,
    duration: f64,
    trim: f64,
    rate: f64,
}
fn spans(tracks: &Value, media: &[Map<String, Value>]) -> Vec<Span> {
    all(tracks)
        .filter(|t| t["muted"] != true)
        .flat_map(|t| arr(&t["elements"]))
        .filter_map(|e| {
            if !matches!(e["type"].as_str(), Some("video" | "audio"))
                || e["enabled"] == false
                || e["params"]["muted"] == true
                || (e["type"] == "video" && e["isSourceAudioEnabled"] == false)
            {
                return None;
            }
            let id = e["mediaId"].as_str()?;
            let asset = media
                .iter()
                .find(|a| a.get("id").and_then(Value::as_str) == Some(id))?;
            let audio_id = asset
                .get("unifiedAngles")
                .and_then(|a| a["audioAssetId"].as_str())
                .unwrap_or(id);
            let rate = n(&e["retime"]["rate"], 1.0).clamp(0.01, 5.0);
            let timing = resolve_clip_audio_timing(ClipAudioTimingOptions {
                start_time: n(&e["startTime"], 0.0) / TPS,
                duration: n(&e["duration"], 0.0) / TPS,
                trim_start: n(&e["trimStart"], 0.0) / TPS,
                rate,
                offset_seconds: n(&e["params"]["audioSyncOffset"], 0.0),
                source_offset_seconds: e["params"]["sourceAudioOffsetSeconds"].as_f64(),
            });
            Some(Span {
                media: audio_id.into(),
                start: timing.start_time,
                duration: timing.duration,
                trim: timing.trim_start,
                rate,
            })
        })
        .collect()
}
fn binding_unchanged(
    id: &str,
    before: &[Map<String, Value>],
    after: &[Map<String, Value>],
) -> bool {
    let find = |items: &[Map<String, Value>]| {
        items
            .iter()
            .find(|a| a.get("id").and_then(Value::as_str) == Some(id))
            .cloned()
    };
    match (find(before), find(after)) {
        (Some(a), Some(b)) => ["bindingRevision", "sourcePath", "lastModified", "size"]
            .iter()
            .all(|k| a.get(*k) == b.get(*k)),
        _ => false,
    }
}
fn map_words(
    job: &Job,
    words: &[Word],
    tracks: &Value,
    media: &[Map<String, Value>],
) -> Vec<Value> {
    let before = spans(&job.source_tracks, &job.source_media);
    let after = spans(tracks, media);
    let mut mapped = vec![];
    let mut seen = HashSet::new();
    for word in words {
        let middle = (word.start + word.end) / 2.0;
        // A mixed recording can contain overlapping microphone/camera sources.
        // Prefer the first surviving source, never create duplicate dialogue.
        for source in before
            .iter()
            .filter(|s| middle >= s.start && middle < s.start + s.duration)
        {
            if !binding_unchanged(&source.media, &job.source_media, media) {
                continue;
            }
            let from = source.trim + (word.start - source.start) * source.rate;
            let to = source.trim + (word.end - source.start) * source.rate;
            let source_middle = (from + to) / 2.0;
            let mut found = false;
            for target in after.iter().filter(|t| {
                t.media == source.media
                    && source_middle >= t.trim
                    && source_middle < t.trim + t.duration * t.rate
            }) {
                let start = (target.start + (from - target.trim) / target.rate).max(target.start);
                let end = (target.start + (to - target.trim) / target.rate)
                    .min(target.start + target.duration)
                    .max(start + 1.0 / TPS);
                let key = format!(
                    "{}:{}:{}",
                    word.text,
                    (start * TPS).round(),
                    (end * TPS).round()
                );
                if seen.insert(key) {
                    mapped.push(json!({"text":word.text,"start":start,"end":end}));
                }
                found = true;
            }
            if found {
                break;
            }
        }
    }
    mapped.sort_by(|a, b| n(&a["start"], 0.0).total_cmp(&n(&b["start"], 0.0)));
    if !job.reference_regions.is_empty() {
        mapped.retain(|w| {
            job.reference_regions.iter().any(|r| {
                n(&w["start"], -1.0) >= r.start as f64 / TPS
                    && n(&w["end"], f64::MAX) <= r.end as f64 / TPS
            })
        });
    }
    mapped
}
fn publish(
    classic: &mut crate::ClassicProject,
    job: &Job,
    words: &[Word],
    fresh: &mut dyn FnMut() -> Result<String, String>,
) -> Result<(), CapabilityError> {
    let Some(index) = arr(&classic.document["scenes"])
        .iter()
        .position(|s| s["id"] == job.scene_id)
    else {
        return Ok(());
    };
    let scene = &classic.document["scenes"][index];
    let mapped = map_words(job, words, &scene["tracks"], &classic.media_assets);
    if mapped.is_empty() {
        return Ok(());
    }
    let bootstrap = json!({"main":{"id":"transcription-placeholder","elements":[]},"audio":[],"overlay":[{"id":fresh().map_err(invalid)?,"type":"text","name":"Captions","elements":[],"captionSource":{"sourceId":job.id,"words":[],"settings":job.settings}}]});
    let request = json!({"tracks":bootstrap,"words":mapped,"settings":job.settings,"canvasSize":classic.document["settings"]["canvasSize"],"layerCount":2,
        "preserveEditedElements":false,"trackDefaults":{"type":"text","hidden":false,"elements":[]},"defaults":job.defaults,"fontSizeScaleReference":90});
    let rebuilt =
        classic_timeline::rebuild_caption_scene(&request, fresh, None).map_err(invalid)?;
    let mut generated = rebuilt
        .tracks
        .ok_or_else(|| invalid("Caption generation failed"))?;
    for reference in rebuilt.references {
        let value = request
            .pointer(&reference.source)
            .ok_or_else(|| invalid("Caption reference missing"))?
            .clone();
        *generated
            .pointer_mut(&reference.target)
            .ok_or_else(|| invalid("Caption target missing"))? = value;
    }
    let tracks = &mut classic.document.get_mut("scenes").unwrap()[index]["tracks"];
    // Preserve prior cue IDs, manual wording, style and timing. Only append this
    // new section, to the job's existing unlocked layers (or create new layers).
    let mut source_words = arr(&tracks["overlay"])
        .iter()
        .find(|t| t["captionSource"]["sourceId"] == job.id)
        .map(|t| arr(&t["captionSource"]["words"]).to_vec())
        .unwrap_or_default();
    source_words.extend(mapped);
    source_words.sort_by(|a, b| n(&a["start"], 0.0).total_cmp(&n(&b["start"], 0.0)));
    for new_track in arr(&generated["overlay"]) {
        let target = tracks["overlay"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| {
                t["captionSource"]["sourceId"] == job.id
                    && t["captionSource"]["layerIndex"] == new_track["captionSource"]["layerIndex"]
                    && t["locked"] != true
            });
        if let Some(target) = target {
            target["elements"]
                .as_array_mut()
                .unwrap()
                .extend(arr(&new_track["elements"]).iter().cloned());
        } else {
            if let Some(order) = tracks["order"].as_array_mut() {
                order.insert(0, new_track["id"].clone());
            }
            tracks["overlay"]
                .as_array_mut()
                .unwrap()
                .insert(0, new_track.clone());
        }
    }
    for track in tracks["overlay"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|t| t["captionSource"]["sourceId"] == job.id)
    {
        track["captionSource"]["words"] = json!(source_words);
    }
    Ok(())
}
fn apply(document: &mut EditorDocument, input: Input) -> Result<Vec<String>, CapabilityError> {
    let mut classic = classic_target(document, &input.project_id)?.clone();
    let mut jobs: Vec<Job> = serde_json::from_value(
        classic
            .document
            .get("transcriptionJobs")
            .cloned()
            .unwrap_or(json!([])),
    )
    .map_err(|e| invalid(e.to_string()))?;
    let found = jobs.iter().position(|j| j.id == input.job_id);
    let mut occupied = HashSet::new();
    collect_ids(&serde_json::to_value(&*document).unwrap(), &mut occupied);
    let mut fresh = || {
        Ok(super::classic_duplicate::fresh(
            document,
            &mut occupied,
            "transcript",
        ))
    };
    match input.change {
        Change::SetEngine { engine } => {
            classic
                .document
                .insert("transcriptionEngine".into(), json!(engine));
        }
        Change::ImportSrt {
            scene_id,
            text,
            settings,
            defaults,
        } => {
            import_srt(
                &mut classic,
                &scene_id,
                &input.job_id,
                &text,
                &settings,
                &defaults,
                &mut fresh,
            )?;
            for job in jobs
                .iter_mut()
                .filter(|j| j.scene_id == scene_id && j.status != Status::Complete)
            {
                job.status = Status::Superseded;
            }
        }
        Change::Start {
            reference_element_ids,
            engine,
            external_configuration,
            scene_id,
            language,
            settings,
            defaults,
            total_duration,
        } => {
            if found.is_none() {
                for previous in jobs.iter_mut().filter(|j| {
                    j.scene_id == scene_id
                        && matches!(j.status, Status::Running | Status::Paused)
                        && j.reference_element_ids
                            .as_deref()
                            .unwrap_or(&[])
                            .iter()
                            .collect::<std::collections::BTreeSet<_>>()
                            == reference_element_ids
                                .as_deref()
                                .unwrap_or(&[])
                                .iter()
                                .collect::<std::collections::BTreeSet<_>>()
                }) {
                    previous.status = Status::Superseded;
                }
                let scene = arr(&classic.document["scenes"])
                    .iter()
                    .find(|s| s["id"] == scene_id)
                    .ok_or_else(|| invalid("Transcription scene not found"))?;
                let reference_regions = match &reference_element_ids {
                    Some(ids) => classic_takes::podcast_reference_scope(&scene["tracks"], ids)?,
                    None => vec![],
                };
                let source_tracks = if reference_regions.is_empty() {
                    scene["tracks"].clone()
                } else {
                    classic_takes::podcast_reference_tracks(&scene["tracks"], &reference_regions)?
                };
                let total_duration = reference_regions
                    .last()
                    .map_or(total_duration, |r| total_duration.min(r.end));
                let chunks = if reference_regions.is_empty() {
                    BTreeMap::new()
                } else {
                    (0..(total_duration as f64 / TPS / SECTION).ceil() as usize)
                        .filter(|i| {
                            !reference_regions.iter().any(|r| {
                                (*i as i64) * 60 * 120000 < r.end
                                    && (*i as i64 + 1) * 60 * 120000 > r.start
                            })
                        })
                        .map(|i| (i, vec![]))
                        .collect()
                };
                jobs.push(Job {
                    id: input.job_id.clone(),
                    scene_id,
                    language,
                    settings,
                    defaults,
                    total_duration,
                    engine,
                    external_configuration,
                    reference_element_ids,
                    reference_regions,
                    source_tracks,
                    source_media: classic.media_assets.clone(),
                    status: Status::Running,
                    chunks,
                });
            }
        }
        Change::Restore { mut snapshot } => {
            if snapshot.id != input.job_id {
                return Err(invalid("Transcription snapshot ID mismatch"));
            }
            validate_job(&snapshot).map_err(invalid)?;
            if found.is_none() {
                snapshot.chunks.clear();
                snapshot.status = Status::Running;
                jobs.push(snapshot);
            }
        }
        Change::Append { index, mut words } => {
            let job = jobs
                .get_mut(found.ok_or_else(|| invalid("Transcription job not found"))?)
                .unwrap();
            if job.status == Status::Superseded {
                return Err(invalid(
                    "Transcription was superseded by another transcript",
                ));
            }
            if !job.reference_regions.is_empty() {
                words.retain(|w| {
                    job.reference_regions
                        .iter()
                        .any(|r| w.start >= r.start as f64 / TPS && w.end <= r.end as f64 / TPS)
                });
            }
            if let Some(existing) = job.chunks.get(&index) {
                if *existing != words {
                    return Err(invalid("Conflicting transcription section replay"));
                }
            } else {
                job.chunks.insert(index, words.clone());
                validate_job(job).map_err(invalid)?;
                publish(&mut classic, job, &words, &mut fresh)?;
                if job.chunks.len() == (job.total_duration as f64 / TPS / SECTION).ceil() as usize {
                    job.status = Status::Complete;
                }
            }
        }
        Change::Pause | Change::Resume => {
            let job = jobs
                .get_mut(found.ok_or_else(|| invalid("Transcription job not found"))?)
                .unwrap();
            if !matches!(job.status, Status::Complete | Status::Superseded) {
                job.status = if matches!(input.change, Change::Pause) {
                    Status::Paused
                } else {
                    Status::Running
                };
            }
        }
    }
    classic
        .document
        .insert("transcriptionJobs".into(), json!(jobs));
    validate_jobs(classic.document.get("transcriptionJobs")).map_err(invalid)?;
    *classic_target(document, &input.project_id)? = classic;
    Ok(vec![input.project_id, input.job_id])
}
pub(super) fn register_transcription(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "transcription.classic.edit",
        "Checkpoint and publish Classic transcription",
        "Select the persisted local/external engine, import SRT as the active transcript (replaces caption-source tracks, preserves cue times, estimates word times, supersedes unfinished jobs), or start a source-bound transcription job and append one completed 60-second section exactly once, or pause/resume it. Stores immutable source tracks, durable media identity and timed words in the Classic document. Appending maps source clocks into the latest target scene after moves, trims, splits and retiming; removed or relinked media stays archived without misplaced captions. Appends new cues without replacing prior text or unrelated edits, even when the active scene changed. A duplicate identical section is a no-op; conflicting replay rejects. Host inference/IO occurs outside this transaction. Explicit project/current expectedRevision, dry run, cancellation, idempotency and grouped Undo/Redo supported. Read jobs at app.state.read /project/classic/document/transcriptionJobs.",
        "captions",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "transcription",
            "checkpoint",
            "captions",
            "resume",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let group = format!("transcription:{}", input.job_id);
                let result = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Transcription section",
                    Some(input.expected_revision),
                    Some(&group),
                    |document| apply(document, input),
                )?;
                Ok(OperationSuccess::new(result).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}

fn srt_time(value: &str) -> Result<f64, CapabilityError> {
    let value = value.trim().replace(',', ".");
    let (clock, fraction) = value
        .split_once('.')
        .ok_or_else(|| invalid("Invalid SRT timestamp"))?;
    let parts: Vec<_> = clock.split(':').collect();
    if parts.len() != 3
        || fraction.is_empty()
        || fraction.len() > 3
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid("Invalid SRT timestamp"));
    }
    let numbers: Vec<u32> = parts
        .iter()
        .map(|s| s.parse::<u32>())
        .collect::<Result<_, _>>()
        .map_err(|_| invalid("Invalid SRT timestamp"))?;
    if numbers[0] >= 24 || numbers[1] >= 60 || numbers[2] >= 60 {
        return Err(invalid(
            "SRT timestamp exceeds 24 hours or has invalid minutes/seconds",
        ));
    }
    Ok((numbers[0] * 3600 + numbers[1] * 60 + numbers[2]) as f64
        + fraction.parse::<u32>().unwrap() as f64 / 10_f64.powi(fraction.len() as i32))
}
fn import_srt(
    classic: &mut crate::ClassicProject,
    scene_id: &str,
    source_id: &str,
    input: &str,
    settings: &Value,
    defaults: &Value,
    fresh: &mut dyn FnMut() -> Result<String, String>,
) -> Result<(), CapabilityError> {
    if input.len() > 5_000_000
        || !settings.is_object()
        || !defaults["element"]["params"].is_object()
    {
        return Err(invalid("Invalid SRT input or caption defaults"));
    }
    let scene_index = arr(&classic.document["scenes"])
        .iter()
        .position(|s| s["id"] == scene_id)
        .ok_or_else(|| invalid("SRT target scene not found"))?;
    let normalized = input
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut blocks: Vec<Vec<&str>> = vec![];
    for line in normalized.lines() {
        if line.trim().is_empty() {
            if blocks.last().is_some_and(|b| !b.is_empty()) {
                blocks.push(vec![]);
            }
        } else {
            if blocks.is_empty() {
                blocks.push(vec![]);
            }
            blocks.last_mut().unwrap().push(line.trim());
        }
    }
    let mut elements = vec![];
    let mut words = vec![];
    for lines in blocks.into_iter().filter(|b| !b.is_empty()) {
        if elements.len() >= 20000 {
            return Err(invalid("SRT exceeds 20000 cues"));
        }
        let index = if lines[0].contains("-->") { 0 } else { 1 };
        let timestamp = lines
            .get(index)
            .ok_or_else(|| invalid("SRT cue is missing timestamps"))?;
        let (from, to) = timestamp
            .split_once("-->")
            .ok_or_else(|| invalid("Invalid SRT cue timestamp"))?;
        let start = srt_time(from)?;
        let end = srt_time(to.split_whitespace().next().unwrap_or(""))?;
        let raw = lines[index + 1..].join("\n");
        // Formatting tags are not transcript words; preserve plain multilingual text.
        let mut tag = false;
        let text: String = raw
            .chars()
            .filter(|c| {
                if *c == '<' {
                    tag = true;
                    false
                } else if *c == '>' {
                    tag = false;
                    false
                } else {
                    !tag
                }
            })
            .collect();
        let tokens: Vec<_> = text.split_whitespace().collect();
        if end <= start || tokens.is_empty() || tokens.len() > 10000 {
            return Err(invalid("SRT cue has empty text or invalid duration"));
        }
        let cue_words:Vec<_>=tokens.iter().enumerate().map(|(i,text)|json!({"text":text,"start":start+(end-start)*i as f64/tokens.len() as f64,"end":start+(end-start)*(i+1) as f64/tokens.len() as f64})).collect();
        let request = json!({"index":elements.len(),"caption":{"text":text,"startTime":start,"duration":end-start,"words":cue_words},"canvasSize":classic.document["settings"]["canvasSize"],"layoutSettings":settings,"defaults":defaults,"fontSizeScaleReference":90});
        let mut element =
            classic_timeline::build_caption_text_element(&request, None).map_err(invalid)?;
        element["id"] = json!(fresh().map_err(invalid)?);
        elements.push(element);
        words.extend(cue_words);
    }
    if elements.is_empty() {
        return Err(invalid("No valid subtitle cues were found in the SRT file"));
    }
    words.sort_by(|a, b| n(&a["start"], 0.0).total_cmp(&n(&b["start"], 0.0)));
    let track = json!({"id":fresh().map_err(invalid)?,"type":"text","name":"Imported SRT","hidden":false,"elements":elements,"captionSource":{"sourceId":source_id,"words":words,"settings":settings,"layerIndex":0,"layerCount":1,"origin":"srt","wordTiming":"estimated"}});
    let tracks = &mut classic.document.get_mut("scenes").unwrap()[scene_index]["tracks"];
    let removed: HashSet<_> = arr(&tracks["overlay"])
        .iter()
        .filter(|t| t["captionSource"].is_object())
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect();
    tracks["overlay"]
        .as_array_mut()
        .unwrap()
        .retain(|t| !t["id"].as_str().is_some_and(|id| removed.contains(id)));
    if let Some(order) = tracks["order"].as_array_mut() {
        order.retain(|id| !id.as_str().is_some_and(|id| removed.contains(id)));
        order.insert(0, track["id"].clone());
    }
    tracks["overlay"].as_array_mut().unwrap().insert(0, track);
    Ok(())
}
