//! Durable scene edit intent and publication. Host workers own IO, never source documents.
use super::*;
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum Action {
    FullAuto,
    CenterSubject,
    Framing,
    Zoom,
    Transitions,
    WordAnimation,
    Music,
    AutoTexts,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recipe {
    zoom: bool,
    transitions: bool,
    word_animation: bool,
    music: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    brand_kit_id: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    scene_id: String,
    worker_project_id: String,
    output_scene_id: String,
    action: Action,
    options: Recipe,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    Prepare {
        #[serde(rename = "sceneId")]
        scene_id: String,
    },
    Enqueue {
        jobs: Vec<Job>,
    },
    Publish {
        #[serde(rename = "jobId")]
        job_id: String,
        worker: crate::ClassicProject,
    },
    Checkpoint {
        completed: u32,
    },
}

fn prepare_worker(
    document: &mut serde_json::Map<String, Value>,
    project_id: &str,
    scene_id: &str,
) -> Result<(), CapabilityError> {
    let invalid = |message: &str| CapabilityError::InvalidInput(message.into());
    let source = document.get("automationSource").unwrap_or(&Value::Null);
    if document["metadata"]["automationWorkingCopy"] != true
        || source["projectId"]
            .as_str()
            .is_none_or(|id| id.is_empty() || id == project_id)
        || source["jobId"].as_str().is_none_or(str::is_empty)
        || source["sceneId"] != scene_id
        || document.get("automationCheckpoint").and_then(Value::as_u64) != Some(0)
    {
        return Err(invalid(
            "Prepare Full Auto Edit only in its isolated worker before editing",
        ));
    }
    let scene = document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == scene_id)
        .ok_or_else(|| invalid("Scene not found"))?;
    let tracks = &mut scene["tracks"];
    let mut clips = tracks["main"]["elements"].as_array().unwrap().clone();
    let routed = clips.is_empty();
    if tracks["main"]["locked"] == true {
        return Err(invalid(
            "Unlock the worker's main track before automatic editing",
        ));
    }
    if routed {
        for track in tracks["overlay"].as_array().unwrap() {
            if track["type"] != "video" || track["hidden"] == true {
                continue;
            }
            for clip in track["elements"].as_array().unwrap() {
                if clip["enabled"] == false || clip["hidden"] == true {
                    continue;
                }
                if track["locked"] == true {
                    return Err(invalid(
                        "Unlock routed camera tracks before automatic editing",
                    ));
                }
                let mut selected = clip.clone();
                if track["muted"] == true {
                    selected["isSourceAudioEnabled"] = json!(false);
                }
                clips.push(selected);
            }
        }
    }
    clips.sort_by_key(|clip| clip["startTime"].as_i64().unwrap_or(0));
    if clips.is_empty()
        || clips
            .iter()
            .any(|clip| !classic_timeline::supports_full_auto_framing(clip))
    {
        return Err(invalid(
            "Full Auto Edit needs selected video cuts without retiming or animated transforms",
        ));
    }
    if clips.windows(2).any(|pair| {
        pair[0]["startTime"].as_i64().unwrap_or(0) + pair[0]["duration"].as_i64().unwrap_or(0)
            > pair[1]["startTime"].as_i64().unwrap_or(0)
    }) {
        return Err(invalid(
            "Overlapping camera composition needs an explicit main video; no angle was discarded",
        ));
    }
    if routed {
        let moved: HashSet<String> = clips
            .iter()
            .filter_map(|clip| clip["id"].as_str().map(str::to_owned))
            .collect();
        tracks["main"]["elements"] = json!(clips);
        for track in tracks["overlay"].as_array_mut().unwrap() {
            track["elements"]
                .as_array_mut()
                .unwrap()
                .retain(|clip| !clip["id"].as_str().is_some_and(|id| moved.contains(id)));
        }
    }
    // Freeze only this isolated edit. Original take choices and transcript remain
    // in the source scene; the worker retains timed captions and all audio DSP.
    for bucket in ["overlay", "audio"] {
        for track in tracks[bucket].as_array_mut().unwrap() {
            for clip in track["elements"].as_array_mut().unwrap() {
                clip.as_object_mut().unwrap().remove("takeGroup");
            }
        }
    }
    for clip in tracks["main"]["elements"].as_array_mut().unwrap() {
        clip.as_object_mut().unwrap().remove("takeGroup");
    }
    scene.as_object_mut().unwrap().remove("takeAssembly");
    document.get_mut("metadata").unwrap()["updatedAt"] = json!(classic_scenes::timestamp()?);
    Ok(())
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    change: Change,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    workers: Vec<Value>,
}

pub(crate) fn validate(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let jobs = value.as_array().ok_or("automationEdits must be an array")?;
    if jobs.len() > 500 {
        return Err("Too many retained scene edit jobs".into());
    }
    let mut ids = HashSet::new();
    for job in jobs {
        let mut stored = job.clone();
        stored
            .as_object_mut()
            .ok_or("Invalid automation job")?
            .remove("status");
        serde_json::from_value::<Job>(stored)
            .map_err(|e| format!("Invalid scene edit recipe: {e}"))?;
        let id = job["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing automation job ID")?;
        if !ids.insert(id) || !matches!(job["status"].as_str(), Some("queued" | "published")) {
            return Err("Invalid automation job".into());
        }
    }
    Ok(())
}
pub(super) fn register_classic_automation(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.automation.edit",
        "Queue or publish isolated scene AI edits",
        "Enqueue 1..100 scene jobs with explicit identities and immutable recipes; returns isolated worker project snapshots. Prepare only an isolated worker: expose its selected non-overlapping routed camera cuts on the main track without rendering, preserve captions/effects/microphone audio, and freeze take choices. Publish a validated worker as a NEW scene, with independent canvas settings, collision-safe identities and media bindings. Never replaces source scenes, captions, project settings or viewer navigation. Exact job publication is idempotent. Checkpoint stores a worker's durable completed-stage boundary. Host handles media IO and execution leases separately. Revision checked, cancellable, dry run, atomic and undoable; state is readable at app.state.read /project/classic/document/automationEdits.",
        "automation",
        AccessLevel::Write,
        false,
        false,
        &["classic", "scene", "automation", "queue", "batch"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if let Change::Publish { job_id, .. } = &input.change {
                    let store = state
                        .read()
                        .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                    if store.document.revision != input.expected_revision {
                        return Err(CapabilityError::Conflict(
                            "Scene edit revision changed".into(),
                        ));
                    }
                    let classic = store
                        .document
                        .project
                        .as_ref()
                        .filter(|p| p.id == input.project_id)
                        .and_then(|p| p.classic.as_ref())
                        .ok_or_else(|| {
                            CapabilityError::Conflict("Scene edit project changed".into())
                        })?;
                    if classic
                        .document
                        .get("automationEdits")
                        .and_then(Value::as_array)
                        .is_some_and(|jobs| {
                            jobs.iter()
                                .any(|j| j["id"] == *job_id && j["status"] == "published")
                        })
                    {
                        return Ok(OperationSuccess::new(Output {
                            mutation: MutationOutput {
                                project_id: Some(input.project_id),
                                previous_revision: input.expected_revision,
                                revision: input.expected_revision,
                                committed: false,
                                undo_entry: None,
                                warnings: vec![],
                                changed_ids: vec![],
                            },
                            workers: vec![],
                        }));
                    }
                }
                let mut workers = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Scene AI edit",
                    Some(input.expected_revision),
                    |document| {
                        if context.cancellation.is_cancelled() {
                            return Err(CapabilityError::Failed("operation was cancelled".into()));
                        }
                        match input.change {
                            Change::Prepare { scene_id } => {
                                let classic =
                                    classic_scenes::classic_target(document, &input.project_id)?;
                                prepare_worker(
                                    &mut classic.document,
                                    &input.project_id,
                                    &scene_id,
                                )?;
                            }
                            Change::Enqueue { jobs } => {
                                if jobs.is_empty() || jobs.len() > 100 {
                                    return Err(CapabilityError::InvalidInput(
                                        "Select 1..100 scenes".into(),
                                    ));
                                }
                                let classic =
                                    classic_scenes::classic_target(document, &input.project_id)?;
                                let mut retained = classic
                                    .document
                                    .get("automationEdits")
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default();
                                let mut ids: HashSet<String> = retained
                                    .iter()
                                    .filter_map(|j| j["id"].as_str().map(str::to_owned))
                                    .collect();
                                for job in jobs {
                                    for id in
                                        [&job.id, &job.worker_project_id, &job.output_scene_id]
                                    {
                                        if id.is_empty() || id.len() > 160 {
                                            return Err(CapabilityError::InvalidInput(
                                                "Invalid job identity".into(),
                                            ));
                                        }
                                    }
                                    if !ids.insert(job.id.clone()) {
                                        return Err(CapabilityError::Conflict(
                                            "Job already queued".into(),
                                        ));
                                    }
                                    let mut scene = classic.document["scenes"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .find(|s| s["id"] == job.scene_id)
                                        .cloned()
                                        .ok_or_else(|| {
                                            CapabilityError::InvalidInput("Scene not found".into())
                                        })?;
                                    let mut worker = classic.document.clone();
                                    worker.remove("automationEdits");
                                    worker.remove("transcriptionJobs");
                                    worker.remove("aiEditHistory");
                                    worker.insert("automationCheckpoint".into(), json!(0));
                                    worker.insert("automationSource".into(),json!({"projectId":input.project_id,"jobId":job.id,"sceneId":job.scene_id}));
                                    worker.get_mut("metadata").unwrap()["automationWorkingCopy"] =
                                        json!(true);
                                    worker.get_mut("metadata").unwrap()["id"] =
                                        json!(job.worker_project_id);
                                    worker.get_mut("metadata").unwrap()["name"] = json!(format!(
                                        "{} · AI working copy",
                                        scene["name"].as_str().unwrap_or("Scene")
                                    ));
                                    if let Some(settings) = scene.get("settings").cloned() {
                                        worker.insert("settings".into(), settings);
                                    }
                                    scene["isMain"] = json!(true);
                                    worker.insert("currentSceneId".into(), json!(job.scene_id));
                                    let mut scenes =
                                        classic.document["scenes"].as_array().unwrap().clone();
                                    for item in &mut scenes {
                                        item["isMain"] = json!(item["id"] == job.scene_id);
                                        if item["id"] == job.scene_id {
                                            item.as_object_mut().unwrap().remove("settings");
                                        }
                                    }
                                    // Keep nested sequence/B-roll references available in the isolated document.
                                    worker.insert("scenes".into(), json!(scenes));
                                    workers.push(json!({"jobId":job.id,"project":worker}));
                                    let mut value = serde_json::to_value(job).map_err(|e| {
                                        CapabilityError::InvalidInput(e.to_string())
                                    })?;
                                    value["status"] = json!("queued");
                                    retained.push(value);
                                }
                                classic
                                    .document
                                    .insert("automationEdits".into(), json!(retained));
                            }
                            Change::Checkpoint { completed } => {
                                let classic =
                                    classic_scenes::classic_target(document, &input.project_id)?;
                                let before = classic
                                    .document
                                    .get("automationCheckpoint")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0);
                                if completed > 20 || u64::from(completed) < before {
                                    return Err(CapabilityError::InvalidInput(
                                        "Invalid stage checkpoint".into(),
                                    ));
                                }
                                classic
                                    .document
                                    .insert("automationCheckpoint".into(), json!(completed));
                            }
                            Change::Publish { job_id, worker } => {
                                worker
                                    .validate()
                                    .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                                let classic =
                                    classic_scenes::classic_target(document, &input.project_id)?;
                                let mut jobs = classic
                                    .document
                                    .get("automationEdits")
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default();
                                let job = jobs.iter_mut().find(|j| j["id"] == job_id).ok_or_else(
                                    || CapabilityError::InvalidInput("Unknown scene job".into()),
                                )?;
                                if job["status"] == "published" {
                                    return Ok(vec![input.project_id.clone()]);
                                }
                                if worker.document["metadata"]["id"] != job["workerProjectId"] {
                                    return Err(CapabilityError::Conflict(
                                        "Worker does not own this job".into(),
                                    ));
                                }
                                let mut scene = worker.document["scenes"]
                                    .as_array()
                                    .and_then(|s| s.iter().find(|s| s["id"] == job["sceneId"]))
                                    .cloned()
                                    .ok_or_else(|| {
                                        CapabilityError::InvalidInput("Worker scene missing".into())
                                    })?;
                                let mut occupied = HashSet::new();
                                collect_ids(&json!(classic), &mut occupied);
                                let mut remap = HashMap::new();
                                let mut scene_ids = HashSet::new();
                                collect_ids(&scene, &mut scene_ids);
                                let mut n = 0;
                                let mut scene_ids: Vec<_> = scene_ids.into_iter().collect();
                                scene_ids.sort();
                                for id in scene_ids {
                                    loop {
                                        n += 1;
                                        let fresh = format!("{}-{}", job_id, n);
                                        if occupied.insert(fresh.clone()) {
                                            remap.insert(id, fresh);
                                            break;
                                        }
                                    }
                                }
                                remap_strings(&mut scene, &remap);
                                scene["id"] = job["outputSceneId"].clone();
                                scene["isMain"] = json!(false);
                                scene["name"] = json!(format!(
                                    "{} · {}",
                                    scene["name"].as_str().unwrap_or("Scene"),
                                    job["action"].as_str().unwrap_or("AI")
                                ));
                                scene["settings"] = worker.document["settings"].clone();
                                for media in worker.media_assets {
                                    if !classic
                                        .media_assets
                                        .iter()
                                        .any(|m| m.get("id") == media.get("id"))
                                    {
                                        classic.media_assets.push(media);
                                    }
                                }
                                classic.document["scenes"]
                                    .as_array_mut()
                                    .unwrap()
                                    .push(scene);
                                job["status"] = json!("published");
                                classic
                                    .document
                                    .insert("automationEdits".into(), json!(jobs));
                            }
                        }
                        Ok(vec![input.project_id.clone()])
                    },
                )?;
                Ok(
                    OperationSuccess::new(Output { mutation, workers }).changed([
                        STATE_RESOURCE,
                        PROJECT_RESOURCE,
                        TIMELINE_RESOURCE,
                    ]),
                )
            }
        },
    )
}
fn remap_strings(value: &mut Value, ids: &HashMap<String, String>) {
    match value {
        Value::String(s) => {
            if let Some(id) = ids.get(s) {
                *s = id.clone()
            }
        }
        Value::Array(a) => {
            for v in a {
                remap_strings(v, ids)
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                remap_strings(v, ids)
            }
        }
        _ => {}
    }
}
