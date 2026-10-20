//! Canonical progress/provenance for host-owned audio workers. No decoder or IO.
use super::*;

#[derive(Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskStatus {
    Running,
    Failed,
    Cancelled,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncTask {
    pub id: String,
    pub status: TaskStatus,
    pub progress: f64,
    pub stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub sources: Vec<CameraSource>,
}
impl SyncTask {
    pub fn validate(&self, u: &Unified) -> bool {
        !self.id.is_empty()
            && self.id.len() <= 160
            && self.stage.len() <= 240
            && self.error.as_ref().is_none_or(|s| s.len() <= 2000)
            && self.progress.is_finite()
            && (0.0..=1.0).contains(&self.progress)
            && self.sources.len() == u.source_ids().len()
            && self
                .sources
                .iter()
                .map(|s| &s.id)
                .collect::<HashSet<_>>()
                .len()
                == self.sources.len()
            && self.sources.iter().all(|s| {
                u.source_ids().contains(&s.id)
                    && s.duration.is_finite()
                    && s.duration > 0.0
                    && s.start == 0.0
            })
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Action {
    Start,
    Progress,
    Fail,
    Cancel,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    media_id: String,
    #[schemars(length(min = 1, max = 160))]
    task_id: String,
    action: Action,
    #[serde(default)]
    replace_task_id: Option<String>,
    #[serde(default)]
    #[schemars(range(min = 0, max = 1))]
    progress: Option<f64>,
    #[serde(default)]
    #[schemars(length(max = 240))]
    stage: Option<String>,
    #[serde(default)]
    #[schemars(length(max = 2000))]
    error: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    mutation: MutationOutput,
    unified_angles: Unified,
}

pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::super::register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.unified.sync_task",
        "Update Unified Angles audio synchronization task",
        "Start, report progress, fail or cancel a host audio worker. Captures every camera binding and duration; task IDs reject late results. Replacing interrupted work requires its exact previous task ID. Progress is monotonic and grouped in revision-fenced undo history. Returns canonical media metadata for a bounded UI projection without reloading scene tracks. No IO. Explicit project/revision, dry run, cancellation and registry idempotency; Classic-only.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["classic", "unified", "audio", "sync", "task"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut updated = None;
                let group = format!("unified-sync:{}:{}", input.media_id, input.task_id);
                let mutation = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Synchronize camera audio",
                    Some(input.expected_revision),
                    Some(&group),
                    |document| {
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        let index = classic
                            .media_assets
                            .iter()
                            .position(|a| a["id"] == input.media_id)
                            .ok_or_else(|| invalid("Unified media not found"))?;
                        let mut u = metadata(&classic.media_assets[index])
                            .map_err(|s| invalid(&s))?
                            .ok_or_else(|| invalid("Not a Unified Angles asset"))?;
                        match input.action {
                            Action::Start => {
                                if let Some(old) = &u.sync_task {
                                    if old.status == TaskStatus::Running
                                        && input.replace_task_id.as_deref() != Some(&old.id)
                                    {
                                        return Err(CapabilityError::Conflict("Audio synchronization is already running; target the interrupted task explicitly".into()));
                                    }
                                    if old.id == input.task_id {
                                        return Err(invalid("Use a new synchronization task ID"));
                                    }
                                }
                                let sources=u.source_ids().iter().map(|id| {
                            let a=classic.media_assets.iter().find(|a|a["id"]==*id).ok_or_else(||invalid("Camera missing"))?;
                            if a.get("missing").and_then(Value::as_bool)==Some(true) || a.get("hasAudio").and_then(Value::as_bool)==Some(false) {
                                return Err(invalid("Every camera needs available reference audio to synchronize"));
                            }
                            Ok(CameraSource{id:id.clone(),duration:a.get("duration").and_then(Value::as_f64).unwrap_or(0.0),start:0.0,binding_revision:a.get("bindingRevision").and_then(Value::as_u64).unwrap_or(0)})
                        }).collect::<Result<Vec<_>,CapabilityError>>()?;
                                u.sync_task = Some(SyncTask {
                                    id: input.task_id.clone(),
                                    status: TaskStatus::Running,
                                    progress: 0.0,
                                    stage: "Preparing camera audio".into(),
                                    error: None,
                                    sources,
                                });
                            }
                            action => {
                                let t = u
                                    .sync_task
                                    .as_mut()
                                    .filter(|t| {
                                        t.id == input.task_id && t.status == TaskStatus::Running
                                    })
                                    .ok_or_else(|| {
                                        CapabilityError::Conflict(
                                            "Audio synchronization task was replaced or stopped"
                                                .into(),
                                        )
                                    })?;
                                match action {
                                    Action::Progress => {
                                        let progress = input
                                            .progress
                                            .ok_or_else(|| invalid("Progress is required"))?;
                                        if !progress.is_finite()
                                            || !(t.progress..=1.0).contains(&progress)
                                        {
                                            return Err(invalid(
                                                "Audio sync progress must be finite, monotonic and between zero and one",
                                            ));
                                        }
                                        t.progress = progress;
                                        if let Some(stage) = &input.stage {
                                            t.stage = stage.clone();
                                        }
                                    }
                                    Action::Fail => {
                                        t.status = TaskStatus::Failed;
                                        t.error = Some(
                                            input
                                                .error
                                                .clone()
                                                .filter(|s| !s.trim().is_empty())
                                                .ok_or_else(|| {
                                                    invalid("Failure needs an explanation")
                                                })?,
                                        );
                                        t.stage = "Audio sync failed".into();
                                    }
                                    Action::Cancel => {
                                        t.status = TaskStatus::Cancelled;
                                        t.stage = "Audio sync interrupted".into();
                                    }
                                    Action::Start => unreachable!(),
                                }
                            }
                        }
                        if !u.sync_task.as_ref().is_some_and(|t| t.validate(&u)) {
                            return Err(invalid("Invalid audio synchronization task"));
                        }
                        updated = Some(u.clone());
                        classic.media_assets[index].insert("unifiedAngles".into(), json!(u));
                        Ok(vec![input.media_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    unified_angles: updated.unwrap(),
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}
