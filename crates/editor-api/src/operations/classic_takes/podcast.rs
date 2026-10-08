//! Podcast extracts reuse canonical take rendering, transcript clocks and acoustic boundaries.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Teaser,
    Highlights,
    Chronological,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Video {
    title: String,
    opening_hook: String,
    ending_hook: String,
    #[schemars(range(min = 0, max = 1))]
    confidence: f64,
    #[schemars(length(min = 1, max = 5))]
    alternatives: Vec<Alternative>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    mode: Mode,
    #[schemars(range(min = 20, max = 90))]
    min_seconds: u32,
    #[schemars(range(min = 20, max = 90))]
    max_seconds: u32,
    #[schemars(range(min = 1, max = 32))]
    max_outputs: usize,
}
impl Options {
    fn validate(&self) -> Result<(), CapabilityError> {
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
struct Source {
    revision: u64,
    words: Vec<Word>,
    windows: Vec<Window>,
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
            if !a.selection_only || a.plan.groups.len() != 1 {
                return Err("Invalid podcast take archive".into());
            }
            validate_video(
                &Video {
                    title: m.title,
                    opening_hook: m.opening_hook,
                    ending_hook: m.ending_hook,
                    confidence: a.plan.groups[0].confidence,
                    alternatives: a.plan.groups[0].alternatives.clone(),
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
    let mut base_window = None;
    for alt in &video.alternatives {
        let mut last_end = None;
        let mut duration = 0;
        let max_parts = if options.mode == Mode::Highlights {
            3
        } else {
            12
        };
        for part in &alt.parts {
            range(part, words)?;
        }
        let parts = quality::merged(&alt.parts, words);
        if parts.is_empty() || parts.len() > max_parts {
            return Err(invalid(
                "Use complete passages: at most 3 moments per highlight or 12 per teaser/chronological extract",
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
            if options.mode != Mode::Teaser {
                let index = window_index(first, words);
                if window_index(last, words) != index || base_window.is_some_and(|i| i != index) {
                    return Err(invalid("Each short must use one five-minute source window"));
                }
                base_window = Some(index);
            }
            last_end = Some(last.end);
            duration += last.end - first.start;
            for i in ids {
                used[i] = true;
            }
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
fn scene_from(
    store: &EditorStore,
    project: &str,
    scene: &str,
    revision: u64,
) -> Result<Value, CapabilityError> {
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
        .cloned()
        .ok_or_else(|| invalid("Scene not found"))
}
pub(super) fn register_podcast(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let source_state = state.clone();
    register::<Prepare, Source, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.podcast.prepare",
        "Read podcast extraction source",
        "Read up to 60000 word-indexed transcript words and five-minute analysis windows for selected video. Explicit project, scene and revision; no inference or IO. Cancellation supported.",
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
                if scene.get("takeAssembly").is_some() {
                    return Err(invalid(
                        "Choose the original episode scene before extracting podcast clips",
                    ));
                }
                let (words, _, _) = inventory(&scene["tracks"], &input.element_ids, true)?;
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
                    words,
                    windows,
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
        "Validate duration, complete-word spans, non-overlap, window locality and strict source chronology where requested. No mutation or AI/network. Use before analyzing audio and applying the same plan.",
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
                let (words, _, _) = inventory(&scene["tracks"], &input.element_ids, true)?;
                validate_request(&input, &words)?;
                Ok(OperationSuccess::new(Reviewed {
                    durations: input
                        .videos
                        .iter()
                        .map(|v| {
                            v.alternatives[0]
                                .parts
                                .iter()
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
        "Create teaser or podcast short sequences",
        "Atomically create separate editable Classic scenes for teaser, remixed highlights or chronological shorts. Preserves the original episode; reuses take alternatives, synchronized audio/overlays, acoustic handles and exact caption rebuilding. Enforces 20..90 second source dialogue duration, max 32 outputs, no reused selected words across outputs, 3 passages per five-minute highlight and strict chronological order in chronological mode. Teaser is one output and may reorder passages. Optional audio evidence protects cut boundaries; missing safe silence is reported in takeAssembly.quality. Word-complete cliffhangers only. Persisted scene.podcastExtract and takeAssembly are canonical document fields. Explicit project/scene/revision, dry run, cancellation, undo/redo, atomic transactions and registry idempotency. No inference, file encoding or network IO.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "podcast", "teaser", "shorts"],
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
                        if original.get("takeAssembly").is_some() {
                            return Err(invalid("Use the original episode scene"));
                        }
                        let canvas = classic.document["settings"]["canvasSize"].clone();
                        let (words, start, end) =
                            inventory(&original["tracks"], &input.element_ids, true)?;
                        let plans = validate_request(&input, &words)?;
                        let gaps = quality::analyze_audio(
                            &original["tracks"],
                            &input.element_ids,
                            input.audio_evidence,
                        )?;
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
                                version: 2,
                                selection_only: true,
                                mode: review::Mode::default(),
                                run_metrics: None,
                                id: fresh(),
                                element_ids: input.element_ids.clone(),
                                source_tracks: original["tracks"].clone(),
                                source_bookmarks: original["bookmarks"].clone(),
                                plan,
                                applied_digest: String::new(),
                                source_words: words.clone(),
                                recommendations: vec![0],
                                audio_gaps: gaps.clone(),
                                quality: QualityReport::default(),
                            };
                            for alternative in &a.plan.groups[0].alternatives {
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
                                if duration > i64::from(input.options.max_seconds) * 120000 {
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
