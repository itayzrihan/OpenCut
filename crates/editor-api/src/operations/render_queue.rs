use super::*;
use crate::{ClassicProject, QueueExportOptions, QueueStatus, QueuedRender, snapshot_hash};
use serde_json::json;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Captured {
    snapshot: ClassicProject,
    source_revision: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    Enqueue {
        snapshot: ClassicProject,
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "sourceRevision")]
        source_revision: u64,
        options: QueueExportOptions,
    },
    Claim {
        attempt: String,
    },
    Report {
        attempt: String,
        progress: f64,
        message: String,
        status: QueueStatus,
    },
    Configure {
        options: QueueExportOptions,
    },
    Cancel,
    Retry,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    project_id: String,
    expected_revision: u64,
    id: String,
    now_ms: u64,
    change: Change,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    mutation: MutationOutput,
    job: QueuedRender,
}
pub(super) fn register_queue(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let capture_state = state.clone();
    register::<Capture, Captured, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.export.capture",
        "Capture immutable render snapshot",
        "Capture the complete Classic scene dependency graph, project settings, media bindings and HyperFrames at an explicit project revision, without modifying the editor. Host submits these frozen bytes to render.queue.edit. No IO. Classic-only compositor bridge.",
        "export",
        AccessLevel::Read,
        true,
        false,
        &["classic", "export", "snapshot"],
        move |ctx, input| {
            let state = capture_state.clone();
            async move {
                if ctx.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("Cancelled".into()));
                }
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict("Export revision changed".into()));
                }
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == input.project_id)
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| CapabilityError::Conflict("Export project changed".into()))?;
                if !classic.document["scenes"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["id"] == input.scene_id))
                {
                    return Err(CapabilityError::InvalidInput("Unknown scene".into()));
                }
                Ok(OperationSuccess::new(Captured {
                    snapshot: classic.clone(),
                    source_revision: input.expected_revision,
                }))
            }
        },
    )?;
    register::<Edit, Output, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "render.queue.edit",
        "Manage frozen background render jobs",
        "Canonical durable queue transitions: enqueue a validated frozen Classic snapshot and export recipe; claim one serial worker with an attempt fence; report monotonic progress/completion/failure; cancel; retry the identical snapshot. Explicit project, queue revision and idempotency metadata. Cancellation requests are acknowledged by workers. A claim after 120 seconds without a heartbeat marks the old attempt failed; late reports cannot publish. Pure in-memory, atomic, dry-run and undo supported; host persists runtime bytes and owns external compositor/file IO separately. Queue is readable via app.state.read /renderQueue; outputId names a host export, never an arbitrary path. Classic-only render payloads, shared runtime queue.",
        "export",
        AccessLevel::Write,
        false,
        false,
        &["classic", "render", "queue", "export"],
        move |ctx, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut result = None;
                let mutation = mutate(
                    &state,
                    &events,
                    &ctx,
                    "Render queue",
                    Some(input.expected_revision),
                    |doc| {
                        if ctx.cancellation.is_cancelled() {
                            return Err(CapabilityError::Failed("Cancelled".into()));
                        }
                        let invalid = |s: &str| CapabilityError::InvalidInput(s.into());
                        if input.id.is_empty()
                            || input.id.len() > 160
                            || input.project_id.is_empty()
                            || input.now_ms == 0
                        {
                            return Err(invalid("Invalid job identity or host time"));
                        }
                        if let Change::Enqueue {
                            snapshot,
                            scene_id,
                            source_revision,
                            options,
                        } = input.change
                        {
                            if doc.render_queue.iter().any(|j| j.id == input.id) {
                                return Err(CapabilityError::Conflict(
                                    "Render job already exists".into(),
                                ));
                            }
                            if doc.render_queue.len() >= 200 {
                                return Err(invalid(
                                    "Render queue is full; archive finished jobs before adding more",
                                ));
                            }
                            let job = QueuedRender {
                                id: input.id.clone(),
                                project_id: input.project_id.clone(),
                                scene_id: scene_id.clone(),
                                source_revision,
                                snapshot_hash: snapshot_hash(&snapshot, &options, &scene_id),
                                snapshot,
                                options,
                                status: QueueStatus::Queued,
                                created_at_ms: input.now_ms,
                                updated_at_ms: input.now_ms,
                                progress: 0.0,
                                message: "Queued".into(),
                                attempt: None,
                                cancel_requested: false,
                                output_id: None,
                            };
                            job.validate().map_err(|e| invalid(&e.to_string()))?;
                            result = Some(job.clone());
                            doc.render_queue.push(job);
                        } else {
                            if matches!(&input.change, Change::Claim { .. }) {
                                for job in &mut doc.render_queue {
                                    if job.status == QueueStatus::Rendering
                                        && input.now_ms.saturating_sub(job.updated_at_ms) > 120_000
                                    {
                                        job.status = if job.cancel_requested {
                                            QueueStatus::Cancelled
                                        } else {
                                            QueueStatus::Failed
                                        };
                                        job.message="Renderer disconnected; retry uses the original snapshot".into();
                                        job.attempt = None;
                                    }
                                }
                                if doc
                                    .render_queue
                                    .iter()
                                    .any(|j| j.status == QueueStatus::Rendering)
                                {
                                    return Err(CapabilityError::Conflict(
                                        "A renderer is already active".into(),
                                    ));
                                }
                                if doc
                                    .render_queue
                                    .iter()
                                    .find(|j| j.status == QueueStatus::Queued)
                                    .is_some_and(|j| j.id != input.id)
                                {
                                    return Err(CapabilityError::Conflict(
                                        "Render the oldest queued job first".into(),
                                    ));
                                }
                            }
                            let job = doc
                                .render_queue
                                .iter_mut()
                                .find(|j| j.id == input.id && j.project_id == input.project_id)
                                .ok_or_else(|| invalid("Unknown project render job"))?;
                            if input.now_ms < job.updated_at_ms {
                                return Err(CapabilityError::Conflict(
                                    "Stale worker report".into(),
                                ));
                            }
                            match input.change {
                                Change::Claim { attempt } => {
                                    if job.status != QueueStatus::Queued
                                        || attempt.is_empty()
                                        || attempt.len() > 160
                                    {
                                        return Err(invalid(
                                            "Job is not queued or attempt is invalid",
                                        ));
                                    }
                                    job.status = QueueStatus::Rendering;
                                    job.attempt = Some(attempt);
                                    job.message = "Preparing render".into();
                                }
                                Change::Report {
                                    attempt,
                                    progress,
                                    message,
                                    status,
                                } => {
                                    if job.status != QueueStatus::Rendering
                                        || job.attempt.as_deref() != Some(&attempt)
                                    {
                                        return Err(CapabilityError::Conflict(
                                            "Render attempt no longer owns this job".into(),
                                        ));
                                    }
                                    if !progress.is_finite()
                                        || !(job.progress..=1.0).contains(&progress)
                                        || message.len() > 4000
                                        || matches!(status, QueueStatus::Queued)
                                    {
                                        return Err(invalid(
                                            "Invalid progress or render transition",
                                        ));
                                    }
                                    job.progress = progress;
                                    job.message = message;
                                    job.status = if job.cancel_requested
                                        && status != QueueStatus::Rendering
                                    {
                                        QueueStatus::Cancelled
                                    } else {
                                        status
                                    };
                                    if job.status == QueueStatus::Completed {
                                        job.progress = 1.0;
                                        job.output_id = Some(job.id.clone());
                                    }
                                    if job.status != QueueStatus::Rendering {
                                        job.attempt = None;
                                    }
                                }
                                Change::Configure { options } => {
                                    if job.status != QueueStatus::Queued {
                                        return Err(invalid(
                                            "Change settings only before rendering starts",
                                        ));
                                    }
                                    job.options = options;
                                    job.snapshot_hash =
                                        snapshot_hash(&job.snapshot, &job.options, &job.scene_id);
                                }
                                Change::Cancel => {
                                    if job.status == QueueStatus::Rendering {
                                        job.cancel_requested = true;
                                        job.message = "Cancelling…".into();
                                    } else if job.status == QueueStatus::Queued {
                                        job.status = QueueStatus::Cancelled;
                                        job.message = "Cancelled".into();
                                    } else {
                                        return Err(invalid(
                                            "Only pending or active jobs can be cancelled",
                                        ));
                                    }
                                }
                                Change::Retry => {
                                    if !matches!(
                                        job.status,
                                        QueueStatus::Failed | QueueStatus::Cancelled
                                    ) {
                                        return Err(invalid(
                                            "Only failed or cancelled jobs can be retried",
                                        ));
                                    }
                                    job.status = QueueStatus::Queued;
                                    job.progress = 0.0;
                                    job.message = "Queued again · original snapshot".into();
                                    job.attempt = None;
                                    job.cancel_requested = false;
                                    job.output_id = None;
                                }
                                Change::Enqueue { .. } => unreachable!(),
                            }
                            job.updated_at_ms = input.now_ms;
                            result = Some(job.clone());
                        }
                        Ok(vec![input.id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    job: result.expect("Mutation output"),
                }))
            }
        },
    )?;
    let _ = json!({});
    Ok(())
}
