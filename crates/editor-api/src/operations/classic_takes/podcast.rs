//! Podcast extracts reuse canonical take rendering, transcript clocks and acoustic boundaries.
use super::*;
mod editorial;
pub(super) mod reference;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PodcastPrepare {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[serde(default)]
    #[schemars(length(max = 100000))]
    element_ids: Vec<String>,
}

// Extracts never restore the unselected episode. Freeze the precise, corrected
// transcript once in their source tracks and retain caption styling templates,
// rather than copying thousands of generated cues into every short. Independent
// authored overlays and the original episode remain untouched.
fn compact_extract_source(
    tracks: &Value,
    element_ids: &[String],
) -> Result<Value, CapabilityError> {
    let evidence = reference::evidence(tracks)?;
    let mut compact = tracks.clone();
    for track in compact["overlay"].as_array_mut().into_iter().flatten() {
        if !track["captionSource"].is_object() {
            continue;
        }
        track["captionSource"]["words"] = json!(evidence);
        track["captionSource"]["sourceId"] = json!("podcast-reference");
        if let Some(elements) = track["elements"].as_array_mut() {
            let mut first = true;
            elements.retain(|e| {
                let keep = first || element_ids.iter().any(|id| e["id"] == *id);
                first = false;
                keep
            });
            for template in elements.iter_mut().filter_map(Value::as_object_mut) {
                template.remove("wordRuns");
            }
        }
    }
    Ok(compact)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Teaser,
    Highlights,
    Chronological,
    Teleprompter,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Video {
    title: String,
    opening_hook: String,
    ending_hook: String,
    #[schemars(range(min = 0, max = 1))]
    confidence: f64,
    #[serde(default)]
    #[schemars(length(max = 5))]
    alternatives: Vec<Alternative>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    groups: Vec<Group>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    discarded: Vec<Discard>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    mode: Mode,
    #[schemars(range(min = 0, max = 90))]
    min_seconds: u32,
    #[schemars(range(min = 0, max = 90))]
    max_seconds: u32,
    #[schemars(range(min = 1, max = 32))]
    max_outputs: usize,
}
impl Options {
    fn validate(&self) -> Result<(), CapabilityError> {
        if self.mode == Mode::Teleprompter {
            if self.min_seconds != 0 || self.max_seconds != 0 || self.max_outputs != 32 {
                return Err(invalid(
                    "Teleprompter uses automatic full-script length and up to 32 scripts (0, 0, 32)",
                ));
            }
            return Ok(());
        }
        if self.min_seconds < 20
            || self.max_seconds > 90
            || self.min_seconds > self.max_seconds
            || !(1..=32).contains(&self.max_outputs)
        {
            return Err(invalid("Choose 20..90 second extracts and 1..32 outputs"));
        }
        Ok(())
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[serde(default)]
    element_ids: Vec<String>,
    options: Options,
    #[schemars(length(min = 1, max = 32))]
    videos: Vec<Video>,
    #[serde(default)]
    audio_evidence: Vec<AudioEvidence>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Window {
    index: usize,
    words: Vec<Word>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ScopeSource {
    revision: u64,
    reference_regions: Vec<reference::Region>,
    has_transcript: bool,
    resume_job_id: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Source {
    revision: u64,
    source_fingerprint: String,
    words: Vec<Word>,
    windows: Vec<Window>,
    reference_regions: Vec<reference::Region>,
    audio_inputs: Vec<reference::AudioInput>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Reviewed {
    durations: Vec<f64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    version: u32,
    source_scene_id: String,
    options: Options,
    title: String,
    opening_hook: String,
    ending_hook: String,
}
pub(super) fn validate_metadata(scene: &Value) -> Result<(), String> {
    if let Some(value) = scene.get("podcastExtract") {
        let m: Metadata = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if m.version != 1
            || !label(&m.source_scene_id)
            || !label(&m.title)
            || !label(&m.opening_hook)
            || !label(&m.ending_hook)
        {
            return Err("Invalid podcast extract metadata".into());
        }
        m.options.validate().map_err(|e| e.to_string())?;
        if let Some(value) = scene.get("takeAssembly") {
            let a: Assembly = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            if !a.selection_only
                || a.plan.groups.is_empty()
                || (m.options.mode != Mode::Teleprompter && a.plan.groups.len() != 1)
            {
                return Err("Invalid podcast take archive".into());
            }
            validate_video(
                &Video {
                    title: m.title,
                    opening_hook: m.opening_hook,
                    ending_hook: m.ending_hook,
                    confidence: a.plan.groups[0].confidence,
                    alternatives: if m.options.mode == Mode::Teleprompter {
                        vec![]
                    } else {
                        a.plan.groups[0].alternatives.clone()
                    },
                    groups: if m.options.mode == Mode::Teleprompter {
                        a.plan.groups.clone()
                    } else {
                        vec![]
                    },
                    discarded: if m.options.mode == Mode::Teleprompter {
                        a.plan.discarded.clone()
                    } else {
                        vec![]
                    },
                },
                &m.options,
                &a.source_words,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn window_index(word: &Word, words: &[Word]) -> usize {
    ((word.start - words[0].start).max(0) / (300 * 120000)) as usize
}
fn validate_video(
    video: &Video,
    options: &Options,
    words: &[Word],
) -> Result<Plan, CapabilityError> {
    if options.mode == Mode::Teleprompter {
        return editorial::teleprompter::video_plan(video, words);
    }
    if !video.groups.is_empty() || !video.discarded.is_empty() {
        return Err(invalid(
            "Per-line take groups are only supported for teleprompter",
        ));
    }
    if !label(&video.title)
        || !label(&video.opening_hook)
        || !label(&video.ending_hook)
        || !video.confidence.is_finite()
        || !(0.0..=1.0).contains(&video.confidence)
        || video.alternatives.is_empty()
        || video.alternatives.len() > 5
    {
        return Err(invalid("Invalid podcast title, hooks or alternatives"));
    }
    let mut used = vec![false; words.len()];

    for alt in &video.alternatives {
        let mut last_end = None;
        let mut duration = 0;
        let max_parts = 12;
        for part in &alt.parts {
            range(part, words)?;
        }
        let parts = quality::merged(&alt.parts, words);
        if parts.is_empty() || parts.len() > max_parts {
            return Err(invalid(
                "Use complete passages: at most 12 per podcast edit",
            ));
        }
        for part in &parts {
            let ids = range(part, words)?;
            let first = &words[part.first_word];
            let last = &words[part.last_word];
            if ids.clone().count() < 4 || last.end - first.start < 120000 {
                return Err(invalid(
                    "Podcast cuts need complete clauses of at least four words and one second",
                ));
            }
            if options.mode == Mode::Chronological && last_end.is_some_and(|end| first.start < end)
            {
                return Err(invalid(
                    "Chronological extracts cannot reorder source passages",
                ));
            }
            last_end = Some(last.end);
            duration += last.end - first.start;
            for i in ids {
                used[i] = true;
            }
        }
        // A chronological short is one local source episode, even when it
        // straddles an arbitrary analysis-window boundary. Highlights may link
        // distant passages, subject to independent semantic review.
        if options.mode == Mode::Chronological
            && words[parts.last().unwrap().last_word].end - words[parts[0].first_word].start
                > 300 * 120000
        {
            return Err(invalid(
                "Chronological shorts must cover one local source span of at most five minutes",
            ));
        }
        if duration < i64::from(options.min_seconds) * 120000
            || duration > i64::from(options.max_seconds) * 120000
        {
            return Err(invalid(format!(
                "Extract '{}' lasts {:.1}s; required {}..{}s",
                video.title,
                duration as f64 / TPS,
                options.min_seconds,
                options.max_seconds
            )));
        }
    }
    let mut discarded = vec![];
    let mut i = 0;
    while i < words.len() {
        if used[i] {
            i += 1;
            continue;
        }
        let first = i;
        while i + 1 < words.len() && !used[i + 1] && words[i + 1].clip_id == words[first].clip_id {
            i += 1;
        }
        discarded.push(Discard {
            first_word: first,
            last_word: i,
            reason: "Outside this extract; preserved in the source scene".into(),
        });
        i += 1;
    }
    let plan = Plan {
        groups: vec![Group {
            review_only: false,
            label: video.title.clone(),
            confidence: video.confidence,
            selected: 0,
            alternatives: video.alternatives.clone(),
        }],
        discarded,
    };
    validate_plan(&plan, words)?;
    Ok(plan)
}
fn validate_request(input: &Request, words: &[Word]) -> Result<Vec<Plan>, CapabilityError> {
    input.options.validate()?;
    if input.videos.is_empty()
        || input.videos.len() > input.options.max_outputs
        || (input.options.mode == Mode::Teaser && input.videos.len() != 1)
    {
        return Err(invalid("Invalid number of podcast outputs"));
    }
    if input.options.mode == Mode::Teleprompter {
        editorial::teleprompter::validate_collection(&input.videos, words)?;
        return input
            .videos
            .iter()
            .map(|v| validate_video(v, &input.options, words))
            .collect();
    }
    let mut seen = HashSet::new();
    let mut plans = vec![];
    let mut previous = None;
    for video in &input.videos {
        let plan = validate_video(video, &input.options, words)?;
        let selected = &video.alternatives[0].parts;
        let first = selected.first().unwrap().first_word;
        if input.options.mode == Mode::Chronological && previous.is_some_and(|last| first <= last) {
            return Err(invalid(
                "Chronological outputs must follow source order without overlapping",
            ));
        }
        previous = selected.last().map(|p| p.last_word);
        // Separate outputs must offer genuinely different passages, not repeat the same short.
        for part in selected {
            for id in range(part, words)? {
                if !seen.insert(id) {
                    return Err(invalid("Podcast outputs repeat source words"));
                }
            }
        }
        plans.push(plan);
    }
    Ok(plans)
}
fn scene_from<'a>(
    store: &'a EditorStore,
    project: &str,
    scene: &str,
    revision: u64,
) -> Result<&'a Value, CapabilityError> {
    if store.active_project_id() != Some(project) || store.document.revision != revision {
        return Err(CapabilityError::Conflict(
            "Podcast source changed; analyze it again".into(),
        ));
    }
    let classic = store
        .document
        .project
        .as_ref()
        .and_then(|p| p.classic.as_ref())
        .ok_or_else(|| invalid("Classic project required"))?;
    arr(&classic.document["scenes"])
        .iter()
        .find(|s| s["id"] == scene)
        .ok_or_else(|| invalid("Scene not found"))
}
pub(super) fn register_podcast(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    editorial::register_editorial(registry, state.clone())?;
    let scope_state = state.clone();
    register::<PodcastPrepare, ScopeSource, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.scope",
        "Read podcast timeline reference scope",
        "Resolve empty selection as the whole edited timeline or explicit clip selection as a strict union of timeline intervals. Supports overlay multicam and separate audio; no transcript, inference, IO or mutation required.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "podcast", "selection", "multicam"],
        move |context, input| {
            let state = scope_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(invalid("Podcast scope cancelled"));
                }
                let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                let scene = scene_from(
                    &store,
                    &input.project_id,
                    &input.scene_id,
                    input.expected_revision,
                )?;
                let regions = reference::regions(&scene["tracks"], &input.element_ids)?;
                let has_words = all(&scene["tracks"])
                    .flat_map(|t| arr(&t["captionSource"]["words"]))
                    .any(|w| {
                        word_times(w).is_ok_and(|(a, b)| {
                            regions
                                .get(regions.partition_point(|r| r.end <= a))
                                .is_some_and(|r| a >= r.start && b <= r.end)
                        })
                    });
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .unwrap()
                    .classic
                    .as_ref()
                    .unwrap();
                let jobs = classic
                    .document
                    .get("transcriptionJobs")
                    .map(arr)
                    .unwrap_or(&[]);
                let imported = all(&scene["tracks"]).any(|t| {
                    !arr(&t["captionSource"]["words"]).is_empty()
                        && !jobs
                            .iter()
                            .any(|j| j["id"] == t["captionSource"]["sourceId"])
                });
                let mut coverage = vec![];
                let mut resume_job_id = None;
                if imported {
                    coverage.extend(regions.iter().map(|r| (r.start, r.end)));
                }
                for job in jobs
                    .iter()
                    .filter(|j| j["sceneId"] == input.scene_id && j["status"] != "superseded")
                {
                    let job_regions =
                        reference::regions(&job["sourceTracks"], &[]).unwrap_or_default();
                    if let Some(chunks) = job["chunks"].as_object() {
                        for key in chunks.keys() {
                            if let Ok(i) = key.parse::<i64>() {
                                for r in &job_regions {
                                    let a = r.start.max(i * 60 * 120000);
                                    let b = r.end.min((i + 1) * 60 * 120000);
                                    if a < b {
                                        coverage.push((a, b));
                                    }
                                }
                            }
                        }
                    }
                    if matches!(job["status"].as_str(), Some("running" | "paused"))
                        && job_regions.len() == regions.len()
                        && job_regions
                            .iter()
                            .zip(&regions)
                            .all(|(a, b)| a.start == b.start && a.end == b.end)
                    {
                        resume_job_id = job["id"].as_str().map(str::to_owned);
                    }
                }
                coverage.sort_unstable();
                let mut covered: Vec<(i64, i64)> = vec![];
                for (a, b) in coverage {
                    if let Some(last) = covered.last_mut() {
                        if a <= last.1 {
                            last.1 = last.1.max(b);
                            continue;
                        }
                    }
                    covered.push((a, b));
                }
                let has_transcript = has_words
                    && regions
                        .iter()
                        .all(|r| covered.iter().any(|(a, b)| r.start >= *a && r.end <= *b));
                if has_transcript {
                    resume_job_id = None;
                }
                Ok(OperationSuccess::new(ScopeSource {
                    revision: store.document.revision,
                    reference_regions: regions,
                    has_transcript,
                    resume_job_id,
                }))
            }
        },
    )?;
    let source_state = state.clone();
    register::<PodcastPrepare, Source, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.prepare",
        "Read podcast extraction source",
        "Read up to 60000 word-indexed transcript words, reference regions and bounded audio inputs for the edited timeline, including multicam overlays, audio routes and camera cuts. Empty elementIds uses all timeline media; explicit selection restricts the temporal reference. Explicit project, scene and revision; no inference or IO. Cancellation supported.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "podcast", "transcript"],
        move |context, input| {
            let state = source_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(invalid("Podcast analysis cancelled"));
                }
                let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                let scene = scene_from(
                    &store,
                    &input.project_id,
                    &input.scene_id,
                    input.expected_revision,
                )?;
                let reference_regions = reference::regions(&scene["tracks"], &input.element_ids)?;
                let (words, _, _) = reference::inventory(&scene["tracks"], &reference_regions)?;
                let audio_inputs = reference::audio_inputs(&scene["tracks"], &reference_regions)?;
                let mut windows: Vec<Window> = vec![];
                for word in &words {
                    let index = window_index(word, &words);
                    if windows.last().is_none_or(|w| w.index != index) {
                        windows.push(Window {
                            index,
                            words: vec![],
                        });
                    }
                    windows.last_mut().unwrap().words.push(word.clone());
                }
                Ok(OperationSuccess::new(Source {
                    revision: store.document.revision,
                    source_fingerprint: format!(
                        "{:x}",
                        Sha256::digest(
                            serde_json::to_vec(
                                &json!({"tracks":scene["tracks"],"regions":reference_regions})
                            )
                            .map_err(|e| invalid(e.to_string()))?
                        )
                    ),
                    words,
                    windows,
                    reference_regions,
                    audio_inputs,
                }))
            }
        },
    )?;
    let review_state = state.clone();
    register::<Request, Reviewed, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.review",
        "Validate podcast extract proposals",
        "Validate duration, complete-word spans, non-overlap, local source span and strict source chronology where requested. No mutation or AI/network. Use before analyzing audio and applying the same plan.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "podcast", "review"],
        move |context, input| {
            let state = review_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(invalid("Podcast review cancelled"));
                }
                let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                let scene = scene_from(
                    &store,
                    &input.project_id,
                    &input.scene_id,
                    input.expected_revision,
                )?;
                let regions = reference::regions(&scene["tracks"], &input.element_ids)?;
                let (words, _, _) = reference::inventory(&scene["tracks"], &regions)?;
                let plans = validate_request(&input, &words)?;
                Ok(OperationSuccess::new(Reviewed {
                    durations: plans
                        .iter()
                        .map(|p| {
                            p.groups
                                .iter()
                                .filter(|g| !g.review_only)
                                .flat_map(|g| &g.alternatives[g.selected].parts)
                                .map(|p| {
                                    (words[p.last_word].end - words[p.first_word].start) as f64
                                        / TPS
                                })
                                .sum()
                        })
                        .collect(),
                }))
            }
        },
    )?;
    register::<Request, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.extract",
        "Create teaser, podcast or teleprompter sequences",
        "Teleprompter mode uses options (minSeconds=0,maxSeconds=0,maxOutputs=32), ordered complete scripts with per-line groups/selected alternatives and explicit discarded ranges; no shorts duration cap. Every scoped word must be accounted across the collection; rejects missing content and overlapping script words. Other modes: atomically create separate editable Classic scenes from edited or multicam timelines for teaser, remixed highlights or chronological shorts. Empty selection references all timeline media; explicit selection strictly bounds dialogue, handles and synchronized media. Preserves existing camera edits and mix in new scenes, without flattening. Preserves the original episode; reuses take alternatives, synchronized audio/overlays, acoustic handles and exact caption rebuilding. Enforces 20..90 second source dialogue duration, max 32 outputs, no reused selected words across outputs, up to12 passages per short, local source span <=five minutes for chronological shorts and strict chronological order in chronological mode. Teaser is one output and may reorder passages. Optional audio evidence protects cut boundaries; missing safe silence is reported in takeAssembly.quality. Word-complete cliffhangers only. Persisted scene.podcastExtract and takeAssembly are canonical document fields. Explicit project/scene/revision, dry run, cancellation, undo/redo, atomic transactions and registry idempotency. No inference, file encoding or network IO.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "podcast", "teaser", "shorts", "teleprompter"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let result = mutate(
                    &state,
                    &events,
                    &context,
                    "Create podcast extracts",
                    Some(input.expected_revision),
                    |document| {
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        let original = arr(&classic.document["scenes"])
                            .iter()
                            .find(|s| s["id"] == input.scene_id)
                            .cloned()
                            .ok_or_else(|| invalid("Scene not found"))?;
                        let canvas = classic.document["settings"]["canvasSize"].clone();
                        let reference_regions =
                            reference::regions(&original["tracks"], &input.element_ids)?;
                        let (words, start, end) =
                            reference::inventory(&original["tracks"], &reference_regions)?;
                        let plans = validate_request(&input, &words)?;
                        let archive_ids =
                            reference::anchor_ids(&original["tracks"], &input.element_ids);
                        let extract_source =
                            compact_extract_source(&original["tracks"], &archive_ids)?;
                        let (compact_words, _, _) =
                            reference::inventory(&extract_source, &reference_regions)?;
                        // Model word IDs and their content/clocks must remain exact. The
                        // source_index is an archive-local pointer: compacted caption
                        // layers may reorder equal-start ASR words by end time.
                        if compact_words.len() != words.len()
                            || compact_words.iter().zip(&words).any(|(a, b)| {
                                a.id != b.id
                                    || a.clip_id != b.clip_id
                                    || a.text != b.text
                                    || a.start != b.start
                                    || a.end != b.end
                            })
                        {
                            return Err(invalid(
                                "Compact extract source changed transcript evidence",
                            ));
                        }
                        let words = compact_words;
                        let audio_ids = reference_regions
                            .iter()
                            .map(|r| r.id.clone())
                            .collect::<Vec<_>>();
                        // Legacy callers may still supply direct main-clip evidence.
                        let audio_evidence = if input
                            .audio_evidence
                            .iter()
                            .all(|e| audio_ids.contains(&e.clip_id))
                        {
                            input.audio_evidence
                        } else {
                            reference::audio_evidence(
                                &extract_source,
                                &reference_regions,
                                input.audio_evidence,
                            )?
                        };
                        let gaps =
                            quality::analyze_audio(&extract_source, &audio_ids, audio_evidence)?;
                        let now = classic_scenes::timestamp()?;
                        let mut occupied = HashSet::new();
                        collect_ids(
                            &serde_json::to_value(&document.project).unwrap(),
                            &mut occupied,
                        );
                        let mut fresh =
                            || classic_duplicate::fresh(document, &mut occupied, "podcast");
                        let mut created = vec![];
                        for (video, plan) in input.videos.iter().zip(plans) {
                            if context.cancellation.is_cancelled() {
                                return Err(invalid("Podcast extraction cancelled"));
                            }
                            let mut a = Assembly {
                                trim_silence: false,
                                silence_groups: None,
                                min_silence_seconds: default_pause(),
                                silence_minimums: Default::default(),
                                version: 3,
                                selection_only: true,
                                reference_regions: reference_regions.clone(),
                                mode: review::Mode::default(),
                                run_metrics: None,
                                id: fresh(),
                                element_ids: archive_ids.clone(),
                                source_tracks: extract_source.clone(),
                                source_bookmarks: original["bookmarks"].clone(),
                                recommendations: plan.groups.iter().map(|g| g.selected).collect(),
                                plan,
                                applied_digest: String::new(),
                                source_words: words.clone(),
                                audio_gaps: gaps.clone(),
                                quality: QualityReport::default(),
                            };
                            for alternative in a.plan.groups.iter().flat_map(|g| &g.alternatives) {
                                let duration = quality::merged(&alternative.parts, &words)
                                    .iter()
                                    .try_fold(0i64, |sum, part| {
                                    let (from, to) = quality::bounds(
                                        part,
                                        &words,
                                        &a.source_tracks,
                                        &a.audio_gaps,
                                    )?;
                                    Ok::<_, CapabilityError>(sum + to - from)
                                })?;
                                if input.options.mode != Mode::Teleprompter
                                    && duration > i64::from(input.options.max_seconds) * 120000
                                {
                                    return Err(invalid(
                                        "Speech-safe handles exceed the maximum duration; choose a shorter complete passage",
                                    ));
                                }
                            }
                            a.quality =
                                quality::report(&a.plan, &words, &a.source_tracks, &a.audio_gaps)?;
                            let (tracks, bookmarks) =
                                render(&a, &words, start, end, &canvas, &mut fresh, &context)?;
                            // Track identities are scene-local; allocate new ones for the output and
                            // matching archived tracks, so later alternative selection retains them.
                            let mut tracks = tracks;
                            let mut ids = HashMap::new();
                            for t in all(&tracks) {
                                ids.insert(t["id"].as_str().unwrap().to_owned(), fresh());
                            }
                            for value in [&mut tracks, &mut a.source_tracks] {
                                for key in ["overlay", "audio"] {
                                    for t in value[key].as_array_mut().into_iter().flatten() {
                                        if let Some(id) = t["id"].as_str().and_then(|s| ids.get(s))
                                        {
                                            t["id"] = json!(id);
                                        }
                                    }
                                }
                                if let Some(id) =
                                    value["main"]["id"].as_str().and_then(|s| ids.get(s))
                                {
                                    value["main"]["id"] = json!(id);
                                }
                                for id in value["order"].as_array_mut().into_iter().flatten() {
                                    if let Some(next) = id.as_str().and_then(|s| ids.get(s)) {
                                        *id = json!(next);
                                    }
                                }
                            }
                            a.applied_digest = digest(&tracks, &bookmarks);
                            let id = fresh();
                            created.push(json!({"id":id,"name":video.title,"isMain":false,"tracks":tracks,"bookmarks":bookmarks,"createdAt":now,"updatedAt":now,"takeAssembly":a,"podcastExtract":Metadata{version:1,source_scene_id:input.scene_id.clone(),options:input.options.clone(),title:video.title.clone(),opening_hook:video.opening_hook.clone(),ending_hook:video.ending_hook.clone()}}));
                        }
                        let mut changed = vec![input.project_id.clone()];
                        changed
                            .extend(created.iter().map(|s| s["id"].as_str().unwrap().to_owned()));
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        classic
                            .document
                            .insert("currentSceneId".into(), created[0]["id"].clone());
                        classic
                            .document
                            .get_mut("scenes")
                            .unwrap()
                            .as_array_mut()
                            .unwrap()
                            .extend(created);
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] = json!(now);
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(result)
                    .summary("Created podcast extracts")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
