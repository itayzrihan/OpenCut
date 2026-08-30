use std::{
    collections::HashSet,
    future::Future,
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, RwLock},
};

use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::{
    ARTIFACT_URI_PREFIX, AccessLevel, ArtifactRef, ArtifactStore, AudioProperties, BlendMode,
    CapabilityDescriptor, CapabilityError, CapabilityRegistry, CapabilityResult, EditorDocument,
    Effect, ExportPreset, FnCapability, InvocationContext, JobManager, JobRecord, JobStatus,
    Keyframe, KeyframeInterpolation, Marker, MediaAsset, MediaType, ModelError, PlaybackState,
    Project, ProjectSettings, Rational, RegistryError, SMART_LAYER_MASK_ARTIFACT_MIME_TYPE,
    SelectionState, ShapeProperties, SmartLayer, SmartLayerAppliedSnapshot, SmartLayerBackground,
    SmartLayerBackgroundRemoval, SmartLayerFade, SmartLayerSourceItemSnapshot,
    SpeakerFrameBreakoutSettings, SpeakerFrameLayout, TextProperties, Timeline, TimelineItem,
    TimelineItemKind, Track, TrackKind, Transform, Transition, UnifiedAngles, VisualFitMode,
    render::{RenderTarget, render},
    runtime::{EditorStore, HistoryEntry, now_ms},
};

const STATE_RESOURCE: &str = "opencut://state";
const PROJECT_RESOURCE: &str = "opencut://project";
const TIMELINE_RESOURCE: &str = "opencut://timeline";

pub(crate) fn register_all(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
    jobs: JobManager,
) -> Result<(), RegistryError> {
    register_manifest(registry)?;
    register_state_read(registry, state.clone())?;
    register_state_patch(registry, state.clone(), events.clone())?;
    register_application_operations(registry, state.clone(), events.clone())?;
    register_observation_operations(registry, state.clone())?;
    register_project_operations(registry, state.clone(), events.clone())?;
    register_media_probe(registry)?;
    register_media_operations(registry, state.clone(), events.clone())?;
    register_media_observation_operations(
        registry,
        state.clone(),
        events.clone(),
        artifacts.clone(),
    )?;
    register_track_operations(registry, state.clone(), events.clone())?;
    register_item_operations(registry, state.clone(), events.clone())?;
    register_speaker_frame_breakout_operations(
        registry,
        state.clone(),
        events.clone(),
        artifacts.clone(),
    )?;
    register_advanced_edit_operations(registry, state.clone(), events.clone())?;
    register_effect_operations(registry, state.clone(), events.clone())?;
    register_keyframe_operations(registry, state.clone(), events.clone())?;
    register_transition_operations(registry, state.clone(), events.clone())?;
    register_marker_operations(registry, state.clone(), events.clone())?;
    register_caption_operations(registry, state.clone(), events.clone(), artifacts.clone())?;
    register_playback_operations(registry, state.clone(), events.clone())?;
    register_selection_operations(registry, state.clone(), events.clone())?;
    register_workspace_operations(registry, state.clone(), events.clone())?;
    register_render_operations(registry, state.clone(), artifacts)?;
    register_history_operations(registry, state, events)?;
    register_job_operations(registry, jobs)?;
    Ok(())
}

struct OperationSuccess<T> {
    output: T,
    summary: Option<String>,
    changed_resources: Vec<String>,
    artifacts: Vec<ArtifactRef>,
}

impl<T> OperationSuccess<T> {
    fn new(output: T) -> Self {
        Self {
            output,
            summary: None,
            changed_resources: Vec::new(),
            artifacts: Vec::new(),
        }
    }

    fn summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    fn changed(mut self, resources: impl IntoIterator<Item = &'static str>) -> Self {
        self.changed_resources = resources.into_iter().map(str::to_owned).collect();
        self
    }

    fn artifact(mut self, artifact: ArtifactRef) -> Self {
        self.artifacts.push(artifact);
        self
    }
}

#[allow(clippy::too_many_arguments)]
fn register<I, O, F, Fut>(
    registry: &CapabilityRegistry,
    id: &'static str,
    title: &'static str,
    description: &'static str,
    category: &'static str,
    access: AccessLevel,
    idempotent: bool,
    open_world: bool,
    tags: &[&str],
    handler: F,
) -> Result<(), RegistryError>
where
    I: DeserializeOwned + JsonSchema + Send + 'static,
    O: Serialize + JsonSchema + Send + 'static,
    F: Fn(InvocationContext, I) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<OperationSuccess<O>, CapabilityError>> + Send + 'static,
{
    let mut descriptor = CapabilityDescriptor::read(
        id,
        title,
        description,
        category,
        schema::<I>(),
        schema::<O>(),
    );
    descriptor.access = access;
    descriptor.idempotent = idempotent;
    descriptor.open_world = open_world;
    descriptor.transactional = access <= AccessLevel::Write
        && !open_world
        && !id.starts_with("history.")
        && !id.starts_with("job.")
        && !matches!(
            id,
            "project.create" | "project.open" | "project.close" | "project.activate"
        );
    descriptor.supports_dry_run = descriptor.transactional;
    descriptor.cancellable = id.starts_with("export.")
        || id.starts_with("preview.")
        || id.starts_with("media.probe")
        || id.starts_with("media.thumbnail.")
        || id.starts_with("media.waveform.")
        || id.starts_with("caption.transcribe");
    descriptor.cancellable |= id.starts_with("timeline.smart_layer.") && id.ends_with(".apply");
    descriptor.tags = tags.iter().map(|tag| (*tag).to_owned()).collect();
    let handler = Arc::new(handler);
    registry.register(Arc::new(FnCapability::new(
        descriptor,
        move |context, input| {
            let handler = handler.clone();
            Box::pin(async move {
                let input = serde_json::from_value(input)
                    .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                let success = handler(context, input).await?;
                let data = serde_json::to_value(success.output)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(CapabilityResult {
                    data,
                    summary: success.summary,
                    changed_resources: success.changed_resources,
                    artifacts: success.artifacts,
                })
            })
        },
    )))
}

fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("generated JSON Schema must serialize")
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyInput {}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ManifestOutput {
    revision: u64,
    capabilities: Vec<CapabilityDescriptor>,
}

fn register_manifest(registry: &CapabilityRegistry) -> Result<(), RegistryError> {
    let registry_for_handler = registry.clone();
    register::<EmptyInput, ManifestOutput, _, _>(
        registry,
        "app.capabilities.list",
        "List app capabilities",
        "Returns every live Editor API capability, including capabilities registered by new features and plugins.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["manifest", "features", "tools", "discovery"],
        move |_, _| {
            let registry = registry_for_handler.clone();
            async move {
                let snapshot = registry
                    .snapshot()
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(ManifestOutput {
                    revision: snapshot.revision,
                    capabilities: snapshot.capabilities,
                }))
            }
        },
    )
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateReadInput {
    #[serde(default)]
    pointer: String,
    project_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct StateReadOutput {
    pointer: String,
    value: Value,
    revision: u64,
    dirty: bool,
    can_undo: bool,
    can_redo: bool,
}

fn register_state_read(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<StateReadInput, StateReadOutput, _, _>(
        registry,
        "app.state.read",
        "Read complete editor state",
        "Reads the entire typed editor document or any subtree by RFC 6901 JSON Pointer, including project, assets, tracks, layers, text, effects, keyframes, selection, playback, and workspace state.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["state", "inspect", "timeline", "layers", "text", "playhead"],
        move |_, input| {
            let state = state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document =
                    store
                        .document_for(input.project_id.as_deref())
                        .ok_or_else(|| {
                            CapabilityError::Unavailable(format!(
                                "project `{}` is not open",
                                input.project_id.as_deref().unwrap_or_default()
                            ))
                        })?;
                let serialized = serde_json::to_value(document)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let value = if input.pointer.is_empty() {
                    serialized
                } else {
                    serialized.pointer(&input.pointer).cloned().ok_or_else(|| {
                        CapabilityError::Unavailable(format!(
                            "no editor state exists at `{}`",
                            input.pointer
                        ))
                    })?
                };
                Ok(OperationSuccess::new(StateReadOutput {
                    pointer: input.pointer,
                    value,
                    revision: document.revision,
                    dirty: if input.project_id.as_deref().is_none()
                        || store.active_project_id() == input.project_id.as_deref()
                    {
                        document.project.is_some()
                            && store.last_saved_revision != Some(document.revision)
                    } else {
                        store
                            .inactive_sessions
                            .get(input.project_id.as_deref().unwrap_or_default())
                            .is_some_and(|session| {
                                session.last_saved_revision != Some(document.revision)
                            })
                    },
                    can_undo: if input.project_id.as_deref().is_none()
                        || store.active_project_id() == input.project_id.as_deref()
                    {
                        !store.undo.is_empty()
                    } else {
                        store
                            .inactive_sessions
                            .get(input.project_id.as_deref().unwrap_or_default())
                            .is_some_and(|session| !session.undo.is_empty())
                    },
                    can_redo: if input.project_id.as_deref().is_none()
                        || store.active_project_id() == input.project_id.as_deref()
                    {
                        !store.redo.is_empty()
                    } else {
                        store
                            .inactive_sessions
                            .get(input.project_id.as_deref().unwrap_or_default())
                            .is_some_and(|session| !session.redo.is_empty())
                    },
                }))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatePatchInput {
    /// RFC 6902 operations. Paths address the document returned by app.state.read.
    patch: Vec<Value>,
    expected_revision: Option<u64>,
    #[serde(default = "default_patch_label")]
    label: String,
}

fn default_patch_label() -> String {
    "Agent state patch".into()
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MutationOutput {
    project_id: Option<String>,
    previous_revision: u64,
    revision: u64,
    committed: bool,
    undo_entry: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    changed_ids: Vec<String>,
}

fn register_state_patch(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<StatePatchInput, MutationOutput, _, _>(
        registry,
        "app.state.patch",
        "Patch any editor state",
        "Applies validated RFC 6902 operations to the complete editor document with optimistic revision control. This is the future-proof escape hatch: newly added serializable feature fields are immediately readable and editable without adding MCP-specific code.",
        "app",
        AccessLevel::Admin,
        false,
        false,
        &["patch", "json", "future", "complete-control", "automation"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let patch: json_patch::Patch = serde_json::from_value(Value::Array(input.patch))
                    .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    &input.label,
                    input.expected_revision,
                    |document| {
                        let mut serialized = serde_json::to_value(&*document)
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                        json_patch::patch(&mut serialized, &patch)
                            .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                        *document = serde_json::from_value(serialized)
                            .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                        document
                            .migrate_to_current()
                            .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                        Ok(Vec::new())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Patched editor state")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCreateInput {
    name: String,
    settings: Option<ProjectSettings>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectTargetInput {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectActivateInput {
    project_id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ProjectSessionsOutput {
    active_project_id: Option<String>,
    sessions: Vec<crate::ProjectSessionInfo>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RecentProjectsOutput {
    projects: Vec<crate::RecentProjectInfo>,
}

fn register_application_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let list_state = state.clone();
    register::<EmptyInput, ProjectSessionsOutput, _, _>(
        registry,
        "project.sessions.list",
        "List open projects",
        "Lists every OpenCut project tab with its active, dirty, revision, path, and thumbnail state.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["projects", "tabs", "active", "dirty", "browser"],
        move |_, _| {
            let state = list_state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                Ok(OperationSuccess::new(ProjectSessionsOutput {
                    active_project_id: store.active_project_id().map(str::to_owned),
                    sessions: store.session_infos(),
                }))
            }
        },
    )?;

    let activate_state = state.clone();
    let activate_events = events.clone();
    register::<ProjectActivateInput, ProjectSessionsOutput, _, _>(
        registry,
        "project.activate",
        "Activate project",
        "Activates an already-open OpenCut project tab without closing other projects.",
        "project",
        AccessLevel::Write,
        true,
        false,
        &["projects", "tabs", "activate", "switch"],
        move |context, input| {
            let state = activate_state.clone();
            let events = activate_events.clone();
            async move {
                if context.dry_run {
                    let store = state.read().map_err(|_| {
                        CapabilityError::Failed("editor state lock was poisoned".into())
                    })?;
                    if store.document_for(Some(&input.project_id)).is_none() {
                        return Err(CapabilityError::Unavailable(format!(
                            "project `{}` is not open",
                            input.project_id
                        )));
                    }
                    return Ok(OperationSuccess::new(ProjectSessionsOutput {
                        active_project_id: Some(input.project_id),
                        sessions: store.session_infos(),
                    }));
                }
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                store
                    .activate(&input.project_id)
                    .map_err(|error| CapabilityError::Unavailable(error.to_string()))?;
                let revision = store.document.revision;
                let output = ProjectSessionsOutput {
                    active_project_id: store.active_project_id().map(str::to_owned),
                    sessions: store.session_infos(),
                };
                drop(store);
                let _ = events.send(revision);
                Ok(OperationSuccess::new(output)
                    .summary("Activated project")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    register::<EmptyInput, RecentProjectsOutput, _, _>(
        registry,
        "project.recent.list",
        "List recent projects",
        "Lists recently opened OpenCut projects in most-recent-first order.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["projects", "recent", "browser"],
        move |_, _| {
            let state = state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                Ok(OperationSuccess::new(RecentProjectsOutput {
                    projects: store.recent_projects.clone(),
                }))
            }
        },
    )
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditListInput {
    capability_id: Option<String>,
    #[serde(default = "default_audit_limit")]
    limit: usize,
}

fn default_audit_limit() -> usize {
    100
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AuditListOutput {
    entries: Vec<crate::InvocationAudit>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct HealthOutput {
    healthy: bool,
    app_version: String,
    schema_version: u32,
    registry_revision: u64,
    capability_count: usize,
    open_project_count: usize,
    active_project_id: Option<String>,
    ffmpeg_available: bool,
    ffprobe_available: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PermissionsOutput {
    policy: crate::AccessPolicy,
    effective_capability_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateDiffInput {
    since_revision: u64,
    project_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct StateDiffOutput {
    project_id: Option<String>,
    from_revision: u64,
    to_revision: u64,
    full_snapshot_required: bool,
    patch: Vec<Value>,
    snapshot: Option<Value>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineQueryInput {
    project_id: Option<String>,
    position_seconds: Option<f64>,
    range_start_seconds: Option<f64>,
    range_end_seconds: Option<f64>,
    text: Option<String>,
    #[serde(default)]
    selected_only: bool,
    #[serde(default)]
    include_disabled: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TimelineQueryTrack {
    track: Track,
    items: Vec<TimelineItem>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TimelineQueryOutput {
    project_id: String,
    revision: u64,
    duration_seconds: f64,
    tracks: Vec<TimelineQueryTrack>,
    transitions: Vec<Transition>,
    markers: Vec<Marker>,
    selection: SelectionState,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryListInput {
    project_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct HistoryListOutput {
    project_id: String,
    revision: u64,
    undo: Vec<String>,
    redo: Vec<String>,
}

fn register_observation_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    let health_registry = registry.clone();
    let health_state = state.clone();
    register::<EmptyInput, HealthOutput, _, _>(
        registry,
        "app.health.read",
        "Read application health",
        "Reports runtime, capability, project-session, and FFmpeg/FFprobe availability.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["health", "diagnostics", "ffmpeg", "status"],
        move |_, _| {
            let registry = health_registry.clone();
            let state = health_state.clone();
            async move {
                let manifest = registry
                    .effective_snapshot()
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                Ok(OperationSuccess::new(HealthOutput {
                    healthy: true,
                    app_version: env!("CARGO_PKG_VERSION").into(),
                    schema_version: store.document.schema_version,
                    registry_revision: manifest.revision,
                    capability_count: manifest.capabilities.len(),
                    open_project_count: store.session_infos().len(),
                    active_project_id: store.active_project_id().map(str::to_owned),
                    ffmpeg_available: command_available(
                        &std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()),
                    ),
                    ffprobe_available: command_available(
                        &std::env::var("OPENCUT_FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into()),
                    ),
                }))
            }
        },
    )?;

    let permissions_registry = registry.clone();
    register::<EmptyInput, PermissionsOutput, _, _>(
        registry,
        "app.permissions.read",
        "Read effective MCP permissions",
        "Returns the runtime access policy and the capability IDs currently allowed by it.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["permissions", "policy", "access", "security"],
        move |_, _| {
            let registry = permissions_registry.clone();
            async move {
                let policy = registry
                    .effective_policy()
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let effective_capability_ids = registry
                    .effective_snapshot()
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?
                    .capabilities
                    .into_iter()
                    .map(|descriptor| descriptor.id)
                    .collect();
                Ok(OperationSuccess::new(PermissionsOutput {
                    policy,
                    effective_capability_ids,
                }))
            }
        },
    )?;

    let audit_registry = registry.clone();
    register::<AuditListInput, AuditListOutput, _, _>(
        registry,
        "app.audit.list",
        "List editor activity",
        "Returns recent capability invocations with actor, request, result, resource, and timestamp metadata.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["audit", "activity", "actor", "operations"],
        move |_, input| {
            let registry = audit_registry.clone();
            async move {
                let entries = registry
                    .audit_log(input.limit, input.capability_id.as_deref())
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(AuditListOutput { entries }))
            }
        },
    )?;

    let diff_state = state.clone();
    register::<StateDiffInput, StateDiffOutput, _, _>(
        registry,
        "app.state.diff",
        "Read state changes",
        "Returns an RFC 6902 patch from a retained project revision, or a full snapshot when the revision is no longer retained.",
        "app",
        AccessLevel::Read,
        true,
        false,
        &["state", "diff", "revision", "changes"],
        move |_, input| {
            let state = diff_state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let target = store
                    .document_for(input.project_id.as_deref())
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let project_id = target.project.as_ref().map(|project| project.id.clone());
                let current = serde_json::to_value(target)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                if input.since_revision == target.revision {
                    return Ok(OperationSuccess::new(StateDiffOutput {
                        project_id,
                        from_revision: input.since_revision,
                        to_revision: target.revision,
                        full_snapshot_required: false,
                        patch: Vec::new(),
                        snapshot: None,
                    }));
                }
                let history = if store.active_project_id() == input.project_id.as_deref()
                    || input.project_id.is_none()
                {
                    Some(&store.undo)
                } else {
                    input
                        .project_id
                        .as_deref()
                        .and_then(|id| store.inactive_sessions.get(id))
                        .map(|session| &session.undo)
                };
                let base = history.and_then(|history| {
                    history
                        .iter()
                        .find(|entry| entry.document.revision == input.since_revision)
                });
                if let Some(base) = base {
                    let old = serde_json::to_value(&base.document)
                        .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                    let patch = serde_json::to_value(json_patch::diff(&old, &current))
                        .map_err(|error| CapabilityError::Failed(error.to_string()))?
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    Ok(OperationSuccess::new(StateDiffOutput {
                        project_id,
                        from_revision: input.since_revision,
                        to_revision: target.revision,
                        full_snapshot_required: false,
                        patch,
                        snapshot: None,
                    }))
                } else {
                    Ok(OperationSuccess::new(StateDiffOutput {
                        project_id,
                        from_revision: input.since_revision,
                        to_revision: target.revision,
                        full_snapshot_required: true,
                        patch: Vec::new(),
                        snapshot: Some(current),
                    }))
                }
            }
        },
    )?;

    let query_state = state.clone();
    register::<TimelineQueryInput, TimelineQueryOutput, _, _>(
        registry,
        "timeline.query",
        "Query timeline",
        "Queries timeline tracks and items by project, playhead, range, text, enabled state, or current selection.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &[
            "timeline",
            "query",
            "layers",
            "visible",
            "playhead",
            "text",
            "selection",
        ],
        move |_, input| {
            let state = query_state.clone();
            async move {
                if input
                    .range_start_seconds
                    .zip(input.range_end_seconds)
                    .is_some_and(|(start, end)| end < start)
                {
                    return Err(CapabilityError::InvalidInput(
                        "rangeEndSeconds must be greater than or equal to rangeStartSeconds".into(),
                    ));
                }
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store
                    .document_for(input.project_id.as_deref())
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let project = document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let needle = input.text.as_deref().map(str::to_ascii_lowercase);
                let tracks = project
                    .timeline
                    .tracks
                    .iter()
                    .filter(|track| input.include_disabled || (track.enabled && !track.hidden))
                    .filter_map(|track| {
                        let items: Vec<_> = track
                            .items
                            .iter()
                            .filter(|item| input.include_disabled || item.enabled)
                            .filter(|item| {
                                input.position_seconds.is_none_or(|position| {
                                    item.start_seconds <= position && position < item.end_seconds()
                                })
                            })
                            .filter(|item| {
                                input
                                    .range_start_seconds
                                    .is_none_or(|start| item.end_seconds() >= start)
                                    && input
                                        .range_end_seconds
                                        .is_none_or(|end| item.start_seconds <= end)
                            })
                            .filter(|item| {
                                !input.selected_only
                                    || document.selection.item_ids.contains(&item.id)
                            })
                            .filter(|item| {
                                needle.as_ref().is_none_or(|needle| {
                                    item.name.to_ascii_lowercase().contains(needle)
                                        || item.text.as_ref().is_some_and(|text| {
                                            text.content.to_ascii_lowercase().contains(needle)
                                        })
                                })
                            })
                            .cloned()
                            .collect();
                        (!items.is_empty()
                            || input.position_seconds.is_none()
                                && input.range_start_seconds.is_none()
                                && input.range_end_seconds.is_none()
                                && input.text.is_none()
                                && !input.selected_only)
                            .then(|| TimelineQueryTrack {
                                track: track.clone(),
                                items,
                            })
                    })
                    .collect();
                Ok(OperationSuccess::new(TimelineQueryOutput {
                    project_id: project.id.clone(),
                    revision: document.revision,
                    duration_seconds: project.timeline.duration(),
                    tracks,
                    transitions: project.timeline.transitions.clone(),
                    markers: project.timeline.markers.clone(),
                    selection: document.selection.clone(),
                }))
            }
        },
    )?;

    register::<HistoryListInput, HistoryListOutput, _, _>(
        registry,
        "history.list",
        "List undo history",
        "Lists retained undo and redo entries for an open project without changing it.",
        "history",
        AccessLevel::Read,
        true,
        false,
        &["history", "undo", "redo", "activity"],
        move |_, input| {
            let state = state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store
                    .document_for(input.project_id.as_deref())
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let project_id = document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?
                    .id
                    .clone();
                let (undo, redo) = if store.active_project_id() == Some(project_id.as_str()) {
                    (&store.undo, &store.redo)
                } else {
                    let session = store.inactive_sessions.get(&project_id).ok_or_else(|| {
                        CapabilityError::Unavailable("project is not open".into())
                    })?;
                    (&session.undo, &session.redo)
                };
                Ok(OperationSuccess::new(HistoryListOutput {
                    project_id,
                    revision: document.revision,
                    undo: undo.iter().rev().map(|entry| entry.label.clone()).collect(),
                    redo: redo.iter().rev().map(|entry| entry.label.clone()).collect(),
                }))
            }
        },
    )
}

fn command_available(executable: &str) -> bool {
    Command::new(executable)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathInput {
    path: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSaveInput {
    path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MergePatchInput {
    patch: Value,
    expected_revision: Option<u64>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SaveOutput {
    revision: u64,
    path: String,
    bytes_written: u64,
}

fn register_project_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let create_state = state.clone();
    let create_events = events.clone();
    register::<ProjectCreateInput, MutationOutput, _, _>(
        registry,
        "project.create",
        "Create project",
        "Creates a new editable project with video, audio, text, and overlay tracks.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["new", "canvas", "sequence"],
        move |context, input| {
            let state = create_state.clone();
            let events = create_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Create project",
                    None,
                    |document| {
                        let project_id = document.allocate_id("project");
                        let video_id = document.allocate_id("track");
                        let overlay_id = document.allocate_id("track");
                        let text_id = document.allocate_id("track");
                        let audio_id = document.allocate_id("track");
                        document.project = Some(Project {
                            id: project_id.clone(),
                            name: input.name,
                            file_path: None,
                            settings: input.settings.unwrap_or_default(),
                            assets: Vec::new(),
                            timeline: Timeline {
                                tracks: vec![
                                    new_track(video_id, "Video 1", TrackKind::Video),
                                    new_track(overlay_id, "Overlay 1", TrackKind::Overlay),
                                    new_track(text_id, "Text 1", TrackKind::Text),
                                    new_track(audio_id, "Audio 1", TrackKind::Audio),
                                ],
                                ..Timeline::default()
                            },
                            metadata: Default::default(),
                            export_presets: default_export_presets(),
                            extensions: Map::new(),
                        });
                        document.selection = SelectionState::default();
                        document.playback = PlaybackState::default();
                        Ok(vec![project_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Created project")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let open_state = state.clone();
    let open_events = events.clone();
    register::<PathInput, MutationOutput, _, _>(
        registry,
        "project.open",
        "Open project",
        "Loads an OpenCut project JSON file into the canonical editor runtime.",
        "project",
        AccessLevel::Write,
        false,
        true,
        &["load", "file", "open"],
        move |context, input| {
            let state = open_state.clone();
            let events = open_events.clone();
            async move {
                let bytes = std::fs::read(&input.path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let mut loaded = match serde_json::from_slice::<EditorDocument>(&bytes) {
                    Ok(document) => document,
                    Err(document_error) => {
                        let project: Project = serde_json::from_slice(&bytes).map_err(|error| {
                            CapabilityError::InvalidInput(format!(
                                "file is neither an OpenCut document ({document_error}) nor a legacy project ({error})"
                            ))
                        })?;
                        EditorDocument {
                            schema_version: 1,
                            next_id: next_id_for_project(&project),
                            project: Some(project),
                            ..EditorDocument::default()
                        }
                    }
                };
                loaded
                    .migrate_to_current()
                    .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                let project = loaded.project.as_mut().ok_or_else(|| {
                    CapabilityError::InvalidInput("project file has no project".into())
                })?;
                project.file_path = Some(input.path.clone());
                let project_id = project.id.clone();
                loaded.selection = SelectionState::default();
                loaded.playback.playing = false;
                loaded
                    .validate()
                    .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Open project",
                    None,
                    |document| {
                        *document = loaded;
                        Ok(vec![project_id])
                    },
                )?;
                if output.committed {
                    let mut store = state.write().map_err(|_| {
                        CapabilityError::Failed("editor state lock was poisoned".into())
                    })?;
                    store.last_saved_revision = Some(store.document.revision);
                }
                Ok(OperationSuccess::new(output)
                    .summary("Opened project")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let save_state = state.clone();
    let save_events = events.clone();
    register::<ProjectSaveInput, SaveOutput, _, _>(
        registry,
        "project.save",
        "Save project",
        "Serializes the complete current OpenCut project to disk.",
        "project",
        AccessLevel::Destructive,
        true,
        true,
        &["save", "file", "persistence"],
        move |context, input| {
            let state = save_state.clone();
            let events = save_events.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "project.save does not support dry-run; use app.state.read to inspect"
                            .into(),
                    ));
                }
                let (mut document, revision) = {
                    let store = state.read().map_err(|_| {
                        CapabilityError::Failed("editor state lock was poisoned".into())
                    })?;
                    (store.document.clone(), store.document.revision)
                };
                check_target(&document, &context)?;
                check_revision(
                    &document,
                    context
                        .metadata
                        .get("opencut/expectedRevision")
                        .and_then(Value::as_u64),
                )?;
                let project = document
                    .project
                    .as_mut()
                    .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
                let path = input
                    .path
                    .or_else(|| project.file_path.clone())
                    .ok_or_else(|| {
                        CapabilityError::InvalidInput("a save path is required".into())
                    })?;
                project.file_path = Some(path.clone());
                let bytes = serde_json::to_vec_pretty(&document)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                if let Some(parent) = Path::new(&path).parent()
                    && !parent.as_os_str().is_empty()
                {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                }
                crate::runtime::atomic_write(Path::new(&path), &bytes)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let mut saved_revision = revision;
                if store.document.revision == revision {
                    let old_path = store
                        .document
                        .project
                        .as_ref()
                        .and_then(|project| project.file_path.as_ref());
                    if old_path != Some(&path) {
                        let before = store.document.clone();
                        store
                            .document
                            .project
                            .as_mut()
                            .expect("project was checked above")
                            .file_path = Some(path.clone());
                        store.document.revision += 1;
                        saved_revision = store.document.revision;
                        store.undo.push(HistoryEntry {
                            label: "Set project save path".into(),
                            document: before,
                        });
                        store.redo.clear();
                        trim_history(&mut store.undo);
                    }
                    store.last_saved_revision = Some(saved_revision);
                }
                drop(store);
                if saved_revision != revision {
                    let _ = events.send(saved_revision);
                }
                Ok(OperationSuccess::new(SaveOutput {
                    revision: saved_revision,
                    path,
                    bytes_written: bytes.len() as u64,
                })
                .summary("Saved project")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;

    let close_state = state.clone();
    let close_events = events.clone();
    register::<ProjectTargetInput, MutationOutput, _, _>(
        registry,
        "project.close",
        "Close project",
        "Closes the active project. The operation is recorded in history and can be undone while the runtime remains open.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["close", "unload"],
        move |context, input| {
            let state = close_state.clone();
            let events = close_events.clone();
            async move {
                let target = input
                    .project_id
                    .or_else(|| requested_project_id(&context).map(str::to_owned))
                    .or_else(|| {
                        state
                            .read()
                            .ok()
                            .and_then(|store| store.active_project_id().map(str::to_owned))
                    })
                    .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if context.dry_run {
                    if store.document_for(Some(&target)).is_none() {
                        return Err(CapabilityError::Unavailable(format!(
                            "project `{target}` is not open"
                        )));
                    }
                    return Ok(OperationSuccess::new(MutationOutput {
                        project_id: Some(target.clone()),
                        previous_revision: store.document.revision,
                        revision: store.document.revision,
                        committed: false,
                        undo_entry: None,
                        warnings: Vec::new(),
                        changed_ids: vec![target],
                    }));
                }
                let was_active = store.active_project_id() == Some(target.as_str());
                let previous_revision = store
                    .document_for(Some(&target))
                    .map(|document| document.revision)
                    .unwrap_or(store.document.revision);
                store
                    .close_project(&target)
                    .map_err(|error| CapabilityError::Unavailable(error.to_string()))?;
                let revision = store.document.revision;
                let output = MutationOutput {
                    project_id: Some(target.clone()),
                    previous_revision,
                    revision,
                    committed: true,
                    undo_entry: None,
                    warnings: Vec::new(),
                    changed_ids: vec![target],
                };
                drop(store);
                if was_active {
                    let _ = events.send(revision);
                }
                Ok(OperationSuccess::new(output)
                    .summary("Closed project")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events;
    register::<MergePatchInput, MutationOutput, _, _>(
        registry,
        "project.update",
        "Update project",
        "Applies a JSON Merge Patch to project metadata, settings, extensions, or export presets while validating the complete project.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["settings", "metadata", "canvas", "fps"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update project",
                    input.expected_revision,
                    |document| {
                        let project = project_mut(document)?;
                        merge_typed(project, input.patch)?;
                        Ok(vec![project.id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated project")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaImportInput {
    name: String,
    source: String,
    media_type: MediaType,
    duration_seconds: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<f64>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
    #[serde(default)]
    metadata: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaAnglesUnifyInput {
    asset_ids: Vec<String>,
    name: Option<String>,
    audio_asset_id: Option<String>,
    default_angle_asset_id: Option<String>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntityPatchInput {
    id: String,
    patch: Value,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntityRemoveInput {
    id: String,
    #[serde(default)]
    cascade: bool,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaProbeInput {
    path: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MediaProbeOutput {
    path: String,
    probe: Value,
}

fn register_media_probe(registry: &CapabilityRegistry) -> Result<(), RegistryError> {
    register::<MediaProbeInput, MediaProbeOutput, _, _>(
        registry,
        "media.probe",
        "Probe media file",
        "Reads streams, duration, dimensions, frame rate, codecs, tags, and other technical metadata from a local media file through FFprobe.",
        "media",
        AccessLevel::Read,
        true,
        true,
        &["media", "metadata", "ffprobe", "duration", "codec"],
        move |context, input| async move {
            if context.cancellation.is_cancelled() {
                return Err(CapabilityError::Failed("operation was cancelled".into()));
            }
            let executable =
                std::env::var("OPENCUT_FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into());
            let output = Command::new(&executable)
                .args([
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-of",
                    "json",
                    &input.path,
                ])
                .stdin(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .map_err(|error| {
                    CapabilityError::Failed(format!("failed to launch `{executable}`: {error}"))
                })?;
            if !output.status.success() {
                return Err(CapabilityError::Failed(format!(
                    "FFprobe exited with {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            let probe = serde_json::from_slice(&output.stdout)
                .map_err(|error| CapabilityError::Failed(error.to_string()))?;
            Ok(OperationSuccess::new(MediaProbeOutput {
                path: input.path,
                probe,
            })
            .summary("Probed media file"))
        },
    )
}

fn register_media_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let import_state = state.clone();
    let import_events = events.clone();
    register::<MediaImportInput, MutationOutput, _, _>(
        registry,
        "media.import",
        "Import media asset",
        "Adds a video, audio, image, subtitle, font, or other media asset to the active project.",
        "media",
        AccessLevel::Write,
        false,
        true,
        &["asset", "video", "audio", "image", "subtitle"],
        move |context, input| {
            let state = import_state.clone();
            let events = import_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Import media",
                    None,
                    |document| {
                        let id = document.allocate_id("asset");
                        let media_type = input.media_type;
                        let asset = MediaAsset {
                            id: id.clone(),
                            name: input.name,
                            source: input.source,
                            media_type,
                            duration_seconds: input.duration_seconds,
                            width: input.width,
                            height: input.height,
                            frame_rate: input.frame_rate,
                            sample_rate: input.sample_rate,
                            channels: input.channels,
                            has_video: matches!(
                                media_type,
                                MediaType::Video | MediaType::Image | MediaType::AnimatedImage
                            ),
                            has_audio: matches!(media_type, MediaType::Video | MediaType::Audio),
                            proxy_source: None,
                            offline: false,
                            unified_angles: None,
                            metadata: input.metadata,
                            extensions: Map::new(),
                        };
                        project_mut(document)?.assets.push(asset);
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Imported media")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;

    let unify_state = state.clone();
    let unify_events = events.clone();
    register::<MediaAnglesUnifyInput, MutationOutput, _, _>(
        registry,
        "media.angles.unify",
        "Create Unified Angles asset",
        "Creates one virtual video asset from exactly two concrete camera-angle videos and selects one source for all audio.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["media", "video", "multicam", "angles", "unify"],
        move |context, input| {
            let state = unify_state.clone();
            let events = unify_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Create Unified Angles",
                    input.expected_revision,
                    |document| {
                        if input.asset_ids.len() < 2
                            || input.asset_ids.iter().collect::<HashSet<_>>().len()
                                != input.asset_ids.len()
                        {
                            return Err(CapabilityError::InvalidInput(
                                "assetIds must contain at least two distinct video assets".into(),
                            ));
                        }
                        let sources: Vec<_> = {
                            let project = project_mut(document)?;
                            input
                                .asset_ids
                                .iter()
                                .map(|source_id| {
                                    project
                                        .assets
                                        .iter()
                                        .find(|asset| asset.id == *source_id)
                                        .cloned()
                                        .ok_or_else(|| unknown("asset", source_id))
                                })
                                .collect::<Result<_, _>>()?
                        };
                        if sources.iter().any(|asset| {
                            asset.media_type != MediaType::Video || asset.unified_angles.is_some()
                        }) {
                            return Err(CapabilityError::InvalidInput(
                                "Unified Angles sources must be concrete video assets".into(),
                            ));
                        }
                        let default_angle_asset_id = input
                            .default_angle_asset_id
                            .unwrap_or_else(|| sources[0].id.clone());
                        let audio_asset_id = input.audio_asset_id.unwrap_or_else(|| {
                            sources
                                .iter()
                                .find(|asset| asset.has_audio)
                                .map(|asset| asset.id.clone())
                                .unwrap_or_else(|| sources[0].id.clone())
                        });
                        if !input.asset_ids.contains(&default_angle_asset_id)
                            || !input.asset_ids.contains(&audio_asset_id)
                        {
                            return Err(CapabilityError::InvalidInput(
                                "defaultAngleAssetId and audioAssetId must be selected angles"
                                    .into(),
                            ));
                        }
                        let audio_source = sources
                            .iter()
                            .find(|asset| asset.id == audio_asset_id)
                            .expect("audio source belongs to selected angles");
                        if !audio_source.has_audio {
                            return Err(CapabilityError::InvalidInput(format!(
                                "asset `{audio_asset_id}` has no audio stream"
                            )));
                        }
                        let default_source = sources
                            .iter()
                            .find(|asset| asset.id == default_angle_asset_id)
                            .expect("default source belongs to selected angles");
                        let id = document.allocate_id("asset");
                        let name = input.name.unwrap_or_else(|| {
                            format!("{} + {}", sources[0].name, sources[1].name)
                        });
                        let duration_seconds = sources
                            .iter()
                            .filter_map(|asset| asset.duration_seconds)
                            .reduce(f64::min);
                        project_mut(document)?.assets.push(MediaAsset {
                            id: id.clone(),
                            name,
                            source: format!("opencut://unified-angles/{id}"),
                            media_type: MediaType::Video,
                            duration_seconds,
                            width: default_source.width,
                            height: default_source.height,
                            frame_rate: default_source.frame_rate,
                            sample_rate: audio_source.sample_rate,
                            channels: audio_source.channels,
                            has_video: true,
                            has_audio: true,
                            proxy_source: None,
                            offline: false,
                            unified_angles: Some(UnifiedAngles {
                                angle_asset_ids: input.asset_ids,
                                default_angle_asset_id,
                                audio_asset_id,
                            }),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Created Unified Angles asset")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events.clone();
    register::<EntityPatchInput, MutationOutput, _, _>(
        registry,
        "media.update",
        "Update media asset",
        "Applies a validated JSON Merge Patch to a media asset, including relinking, proxy, metadata, and offline state.",
        "media",
        AccessLevel::Write,
        false,
        true,
        &["relink", "proxy", "metadata"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update media",
                    input.expected_revision,
                    |document| {
                        let asset = project_mut(document)?
                            .assets
                            .iter_mut()
                            .find(|asset| asset.id == id)
                            .ok_or_else(|| unknown("asset", &id))?;
                        merge_typed(asset, input.patch)?;
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated media")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;

    let remove_state = state;
    let remove_events = events;
    register::<EntityRemoveInput, MutationOutput, _, _>(
        registry,
        "media.remove",
        "Remove media asset",
        "Removes a media asset. With cascade enabled, timeline items using it are also removed.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["delete", "asset", "cascade"],
        move |context, input| {
            let state = remove_state.clone();
            let events = remove_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Remove media",
                    input.expected_revision,
                    |document| {
                        let project = project_mut(document)?;
                        let used = project
                            .timeline
                            .tracks
                            .iter()
                            .flat_map(|track| &track.items)
                            .any(|item| item.asset_id.as_deref() == Some(&id));
                        if used && !input.cascade {
                            return Err(CapabilityError::InvalidInput(format!(
                                "asset `{id}` is used on the timeline; set cascade to true"
                            )));
                        }
                        let before = project.assets.len();
                        project.assets.retain(|asset| asset.id != id);
                        if project.assets.len() == before {
                            return Err(unknown("asset", &id));
                        }
                        if input.cascade {
                            for track in &mut project.timeline.tracks {
                                track
                                    .items
                                    .retain(|item| item.asset_id.as_deref() != Some(&id));
                            }
                        }
                        document.selection.asset_ids.remove(&id);
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Removed media")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaDependenciesInput {
    project_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MediaDependency {
    asset_id: String,
    name: String,
    source: String,
    exists: bool,
    offline: bool,
    used_by_item_ids: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MediaDependenciesOutput {
    project_id: String,
    missing_count: usize,
    dependencies: Vec<MediaDependency>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaRelinkInput {
    asset_id: String,
    new_source: String,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaArtifactInput {
    asset_id: String,
    position_seconds: Option<f64>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MediaArtifactOutput {
    asset_id: String,
    artifact: ArtifactRef,
}

fn register_media_observation_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    let scan_state = state.clone();
    register::<MediaDependenciesInput, MediaDependenciesOutput, _, _>(
        registry,
        "media.dependencies.scan",
        "Scan media dependencies",
        "Reports every project media source, whether it exists or is offline, and which timeline items use it.",
        "media",
        AccessLevel::Read,
        true,
        true,
        &["media", "dependencies", "offline", "missing", "relink"],
        move |_, input| {
            let state = scan_state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store
                    .document_for(input.project_id.as_deref())
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let project = document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let dependencies: Vec<_> = project
                    .assets
                    .iter()
                    .map(|asset| MediaDependency {
                        asset_id: asset.id.clone(),
                        name: asset.name.clone(),
                        source: asset.source.clone(),
                        exists: Path::new(&asset.source).exists(),
                        offline: asset.offline,
                        used_by_item_ids: project
                            .timeline
                            .tracks
                            .iter()
                            .flat_map(|track| &track.items)
                            .filter(|item| item.asset_id.as_deref() == Some(asset.id.as_str()))
                            .map(|item| item.id.clone())
                            .collect(),
                    })
                    .collect();
                Ok(OperationSuccess::new(MediaDependenciesOutput {
                    project_id: project.id.clone(),
                    missing_count: dependencies
                        .iter()
                        .filter(|dependency| !dependency.exists || dependency.offline)
                        .count(),
                    dependencies,
                }))
            }
        },
    )?;

    let relink_state = state.clone();
    let relink_events = events;
    register::<MediaRelinkInput, MutationOutput, _, _>(
        registry,
        "media.relink",
        "Relink media",
        "Changes one asset to an existing replacement file and clears its offline state.",
        "media",
        AccessLevel::Write,
        false,
        true,
        &["media", "offline", "missing", "relink", "source"],
        move |context, input| {
            let state = relink_state.clone();
            let events = relink_events.clone();
            async move {
                if !Path::new(&input.new_source).is_file() {
                    return Err(CapabilityError::InvalidInput(format!(
                        "replacement media `{}` does not exist or is not a file",
                        input.new_source
                    )));
                }
                let asset_id = input.asset_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Relink media",
                    input.expected_revision,
                    |document| {
                        let asset = project_mut(document)?
                            .assets
                            .iter_mut()
                            .find(|asset| asset.id == asset_id)
                            .ok_or_else(|| unknown("asset", &asset_id))?;
                        asset.source = input.new_source;
                        asset.offline = false;
                        Ok(vec![asset_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Relinked media")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let thumbnail_state = state.clone();
    let thumbnail_artifacts = artifacts.clone();
    register::<MediaArtifactInput, MediaArtifactOutput, _, _>(
        registry,
        "media.thumbnail.generate",
        "Generate media thumbnail",
        "Generates a PNG thumbnail for a project media asset and returns it directly as an artifact.",
        "media",
        AccessLevel::Read,
        true,
        true,
        &["media", "thumbnail", "image", "artifact"],
        move |context, input| {
            let state = thumbnail_state.clone();
            let artifacts = thumbnail_artifacts.clone();
            async move {
                let asset = active_asset(&state, &input.asset_id)?;
                {
                    let document = state
                        .read()
                        .map_err(|_| {
                            CapabilityError::Failed("editor state lock was poisoned".into())
                        })?
                        .document
                        .clone();
                    check_target(&document, &context)?;
                }
                let position = input.position_seconds.unwrap_or_default().max(0.0);
                let path = temporary_media_artifact_path("thumbnail", "png");
                run_ffmpeg_artifact(
                    &[
                        "-ss".into(),
                        position.to_string(),
                        "-i".into(),
                        asset.source,
                        "-frames:v".into(),
                        "1".into(),
                        "-vf".into(),
                        "scale=640:-2".into(),
                        "-y".into(),
                        path.to_string_lossy().into_owned(),
                    ],
                    &context,
                )?;
                let bytes = std::fs::read(&path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let _ = std::fs::remove_file(&path);
                let artifact = artifacts
                    .put(bytes, "image/png", Some(640), None, None)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(MediaArtifactOutput {
                    asset_id: input.asset_id,
                    artifact: artifact.clone(),
                })
                .artifact(artifact)
                .summary("Generated media thumbnail"))
            }
        },
    )?;

    register::<MediaArtifactInput, MediaArtifactOutput, _, _>(
        registry,
        "media.waveform.generate",
        "Generate audio waveform",
        "Generates a PNG waveform for a project media asset and returns it directly as an artifact.",
        "media",
        AccessLevel::Read,
        true,
        true,
        &["media", "audio", "waveform", "image", "artifact"],
        move |context, input| {
            let state = state.clone();
            let artifacts = artifacts.clone();
            async move {
                let asset = active_asset(&state, &input.asset_id)?;
                if !asset.has_audio {
                    return Err(CapabilityError::InvalidInput(format!(
                        "asset `{}` has no audio stream",
                        asset.id
                    )));
                }
                let path = temporary_media_artifact_path("waveform", "png");
                run_ffmpeg_artifact(
                    &[
                        "-i".into(),
                        asset.source,
                        "-filter_complex".into(),
                        "showwavespic=s=1280x240:colors=white".into(),
                        "-frames:v".into(),
                        "1".into(),
                        "-y".into(),
                        path.to_string_lossy().into_owned(),
                    ],
                    &context,
                )?;
                let bytes = std::fs::read(&path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let _ = std::fs::remove_file(&path);
                let artifact = artifacts
                    .put(bytes, "image/png", Some(1280), Some(240), None)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(MediaArtifactOutput {
                    asset_id: input.asset_id,
                    artifact: artifact.clone(),
                })
                .artifact(artifact)
                .summary("Generated audio waveform"))
            }
        },
    )
}

fn active_asset(
    state: &Arc<RwLock<EditorStore>>,
    asset_id: &str,
) -> Result<MediaAsset, CapabilityError> {
    state
        .read()
        .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?
        .document
        .project
        .as_ref()
        .and_then(|project| project.assets.iter().find(|asset| asset.id == asset_id))
        .cloned()
        .ok_or_else(|| unknown("asset", asset_id))
}

fn temporary_media_artifact_path(prefix: &str, extension: &str) -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("opencut-{prefix}-{nonce}.{extension}"))
}

fn run_ffmpeg_artifact(
    arguments: &[String],
    context: &InvocationContext,
) -> Result<(), CapabilityError> {
    let executable = std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
    let mut child = Command::new(&executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            CapabilityError::Failed(format!("failed to launch `{executable}`: {error}"))
        })?;
    loop {
        if context.cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CapabilityError::Failed("operation was cancelled".into()));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| CapabilityError::Failed(error.to_string()))?
        {
            if status.success() {
                return Ok(());
            }
            return Err(CapabilityError::Failed(format!(
                "FFmpeg exited with {status}"
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrackAddInput {
    name: String,
    kind: TrackKind,
    index: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReorderInput {
    id: String,
    index: usize,
    expected_revision: Option<u64>,
}

fn register_track_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let add_state = state.clone();
    let add_events = events.clone();
    register::<TrackAddInput, MutationOutput, _, _>(
        registry,
        "timeline.track.add",
        "Add timeline track",
        "Adds a video, audio, text, caption, overlay, or adjustment track at a requested layer index.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["track", "layer", "add"],
        move |context, input| {
            let state = add_state.clone();
            let events = add_events.clone();
            async move {
                let output = mutate(&state, &events, &context, "Add track", None, |document| {
                    let id = document.allocate_id("track");
                    let project = project_mut(document)?;
                    let index = input.index.unwrap_or(project.timeline.tracks.len());
                    if index > project.timeline.tracks.len() {
                        return Err(CapabilityError::InvalidInput(
                            "track index is out of range".into(),
                        ));
                    }
                    project
                        .timeline
                        .tracks
                        .insert(index, new_track(id.clone(), &input.name, input.kind));
                    Ok(vec![id])
                })?;
                Ok(OperationSuccess::new(output)
                    .summary("Added track")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events.clone();
    register::<EntityPatchInput, MutationOutput, _, _>(
        registry,
        "timeline.track.update",
        "Update timeline track",
        "Updates track name, kind, visibility, lock, mute, solo, height, metadata, or extensions.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["track", "layer", "mute", "lock", "visibility"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update track",
                    input.expected_revision,
                    |document| {
                        let track = find_track_mut(document, &id)?;
                        merge_typed(track, input.patch)?;
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated track")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let delete_state = state.clone();
    let delete_events = events.clone();
    register::<EntityRemoveInput, MutationOutput, _, _>(
        registry,
        "timeline.track.delete",
        "Delete timeline track",
        "Deletes a timeline track and its items. The operation can be undone.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["track", "layer", "delete"],
        move |context, input| {
            let state = delete_state.clone();
            let events = delete_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete track",
                    input.expected_revision,
                    |document| {
                        let project = project_mut(document)?;
                        let before = project.timeline.tracks.len();
                        project.timeline.tracks.retain(|track| track.id != id);
                        if before == project.timeline.tracks.len() {
                            return Err(unknown("track", &id));
                        }
                        document.selection.track_ids.remove(&id);
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted track")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let reorder_state = state;
    let reorder_events = events;
    register::<ReorderInput, MutationOutput, _, _>(
        registry,
        "timeline.track.reorder",
        "Reorder timeline track",
        "Moves a track to a new layer index, controlling compositing order.",
        "timeline",
        AccessLevel::Write,
        true,
        false,
        &["track", "layer", "order", "z-index"],
        move |context, input| {
            let state = reorder_state.clone();
            let events = reorder_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Reorder track",
                    input.expected_revision,
                    |document| {
                        let tracks = &mut project_mut(document)?.timeline.tracks;
                        let current = tracks
                            .iter()
                            .position(|track| track.id == id)
                            .ok_or_else(|| unknown("track", &id))?;
                        let track = tracks.remove(current);
                        let index = input.index.min(tracks.len());
                        tracks.insert(index, track);
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Reordered track")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemAddInput {
    track_id: String,
    name: String,
    kind: TimelineItemKind,
    start_seconds: f64,
    duration_seconds: f64,
    asset_id: Option<String>,
    text: Option<TextProperties>,
    shape: Option<ShapeProperties>,
    source_in_seconds: Option<f64>,
    source_out_seconds: Option<f64>,
    speed: Option<f64>,
    transform: Option<Transform>,
    opacity: Option<f64>,
    blend_mode: Option<BlendMode>,
    audio: Option<AudioProperties>,
    index: Option<usize>,
    #[serde(default)]
    metadata: std::collections::BTreeMap<String, Value>,
    #[serde(default)]
    extensions: Map<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemMoveInput {
    item_ids: Vec<String>,
    target_track_id: Option<String>,
    start_seconds: Option<f64>,
    delta_seconds: Option<f64>,
    index: Option<usize>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemTrimInput {
    item_id: String,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    source_in_seconds: Option<f64>,
    source_out_seconds: Option<f64>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemSplitInput {
    item_id: String,
    at_seconds: f64,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemAngleSetInput {
    item_id: String,
    angle_asset_id: String,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemAnglesSetInput {
    item_ids: Vec<String>,
    angle_asset_id: String,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemAnglesCycleInput {
    item_ids: Vec<String>,
    starting_angle_asset_id: String,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemsFitModeSetInput {
    item_ids: Vec<String>,
    fit_mode: VisualFitMode,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemDuplicateInput {
    item_ids: Vec<String>,
    #[serde(default)]
    offset_seconds: f64,
    target_track_id: Option<String>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextUpdateInput {
    item_id: String,
    patch: Value,
    expected_revision: Option<u64>,
}

fn register_item_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let add_state = state.clone();
    let add_events = events.clone();
    register::<ItemAddInput, MutationOutput, _, _>(
        registry,
        "timeline.item.add",
        "Add timeline item",
        "Adds video, audio, image, text, caption, shape, adjustment, or compound content to a track.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "layer", "text", "media", "add"],
        move |context, input| {
            let state = add_state.clone();
            let events = add_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Add timeline item",
                    None,
                    |document| {
                        let id = document.allocate_id("item");
                        let track = find_track_mut(document, &input.track_id)?;
                        ensure_unlocked(track, None)?;
                        let item = TimelineItem {
                            id: id.clone(),
                            name: input.name,
                            kind: input.kind,
                            start_seconds: input.start_seconds,
                            duration_seconds: input.duration_seconds,
                            start: None,
                            duration: None,
                            source_in_seconds: input.source_in_seconds.unwrap_or(0.0),
                            source_out_seconds: input.source_out_seconds,
                            source_in: None,
                            source_out: None,
                            speed: input.speed.unwrap_or(1.0),
                            enabled: true,
                            locked: false,
                            group_id: None,
                            linked_item_ids: Default::default(),
                            asset_id: input.asset_id,
                            active_angle_asset_id: None,
                            fit_mode: None,
                            transform: input.transform.unwrap_or_default(),
                            opacity: input.opacity.unwrap_or(1.0),
                            blend_mode: input.blend_mode.unwrap_or_default(),
                            audio: input.audio.unwrap_or_default(),
                            text: if matches!(
                                input.kind,
                                TimelineItemKind::Text | TimelineItemKind::Caption
                            ) {
                                Some(input.text.unwrap_or_default())
                            } else {
                                input.text
                            },
                            shape: input.shape,
                            smart_layer: None,
                            masks: Vec::new(),
                            effects: Vec::new(),
                            keyframes: Vec::new(),
                            metadata: input.metadata,
                            extensions: input.extensions,
                        };
                        let index = input.index.unwrap_or(track.items.len());
                        if index > track.items.len() {
                            return Err(CapabilityError::InvalidInput(
                                "item index is out of range".into(),
                            ));
                        }
                        track.items.insert(index, item);
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Added timeline item")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events.clone();
    register::<EntityPatchInput, MutationOutput, _, _>(
        registry,
        "timeline.item.update",
        "Update timeline item",
        "Applies a validated JSON Merge Patch to any timeline item property, including timing, transform, crop, opacity, blend, audio, text, shape, metadata, and extensions.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "layer", "transform", "crop", "opacity", "audio"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update timeline item",
                    input.expected_revision,
                    |document| {
                        let item = find_editable_item_mut(document, &id)?;
                        merge_typed(item, input.patch)?;
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated timeline item")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let delete_state = state.clone();
    let delete_events = events.clone();
    register::<EntityRemoveInput, MutationOutput, _, _>(
        registry,
        "timeline.item.delete",
        "Delete timeline item",
        "Deletes a timeline item and related transitions. The operation can be undone.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "layer", "delete"],
        move |context, input| {
            let state = delete_state.clone();
            let events = delete_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete timeline item",
                    input.expected_revision,
                    |document| {
                        let project = project_mut(document)?;
                        let mut found = false;
                        for track in &mut project.timeline.tracks {
                            if track.locked {
                                continue;
                            }
                            let before = track.items.len();
                            track.items.retain(|item| item.id != id || item.locked);
                            found |= track.items.len() != before;
                        }
                        if !found {
                            return Err(unknown("unlocked timeline item", &id));
                        }
                        project.timeline.transitions.retain(|transition| {
                            transition.from_item_id.as_deref() != Some(&id)
                                && transition.to_item_id.as_deref() != Some(&id)
                        });
                        document.selection.item_ids.remove(&id);
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted timeline item")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let move_state = state.clone();
    let move_events = events.clone();
    register::<ItemMoveInput, MutationOutput, _, _>(
        registry,
        "timeline.item.move",
        "Move timeline items",
        "Moves one or more items in time and optionally between tracks while preserving their relative offsets.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "layer", "move", "track", "time"],
        move |context, input| {
            let state = move_state.clone();
            let events = move_events.clone();
            async move {
                let ids = input.item_ids.clone();
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Move timeline items",
                    input.expected_revision,
                    |document| {
                        move_items(document, &ids, &input)?;
                        Ok(ids.clone())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Moved timeline items")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let trim_state = state.clone();
    let trim_events = events.clone();
    register::<ItemTrimInput, MutationOutput, _, _>(
        registry,
        "timeline.item.trim",
        "Trim timeline item",
        "Changes an item's timeline start, duration, and source in/out points.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "trim", "duration", "source"],
        move |context, input| {
            let state = trim_state.clone();
            let events = trim_events.clone();
            async move {
                let id = input.item_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Trim timeline item",
                    input.expected_revision,
                    |document| {
                        let item = find_editable_item_mut(document, &id)?;
                        if let Some(value) = input.start_seconds {
                            item.start_seconds = value;
                        }
                        if let Some(value) = input.duration_seconds {
                            item.duration_seconds = value;
                        }
                        if let Some(value) = input.source_in_seconds {
                            item.source_in_seconds = value;
                        }
                        if let Some(value) = input.source_out_seconds {
                            item.source_out_seconds = Some(value);
                        }
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Trimmed timeline item")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let split_state = state.clone();
    let split_events = events.clone();
    register::<ItemSplitInput, MutationOutput, _, _>(
        registry,
        "timeline.item.split",
        "Split timeline item",
        "Splits an item at an absolute timeline position and adjusts source offsets and keyframes.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "cut", "razor", "split"],
        move |context, input| {
            let state = split_state.clone();
            let events = split_events.clone();
            async move {
                let original_id = input.item_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Split timeline item",
                    input.expected_revision,
                    |document| {
                        let new_id = document.allocate_id("item");
                        let (track_index, item_index) = find_item_location(document, &original_id)?;
                        let track = &mut project_mut(document)?.timeline.tracks[track_index];
                        if track.locked {
                            return Err(CapabilityError::Denied(format!(
                                "track `{}` is locked",
                                track.id
                            )));
                        }
                        if track.items[item_index].locked {
                            return Err(CapabilityError::Denied(format!(
                                "timeline item `{}` is locked",
                                original_id
                            )));
                        }
                        let item = &mut track.items[item_index];
                        if input.at_seconds <= item.start_seconds
                            || input.at_seconds >= item.end_seconds()
                        {
                            return Err(CapabilityError::InvalidInput(
                                "split point must be inside the timeline item".into(),
                            ));
                        }
                        let left_duration = input.at_seconds - item.start_seconds;
                        let mut right = item.clone();
                        right.id = new_id.clone();
                        right.name = format!("{} (split)", right.name);
                        right.start_seconds = input.at_seconds;
                        right.duration_seconds -= left_duration;
                        right.source_in_seconds += left_duration * item.speed;
                        right.keyframes = right
                            .keyframes
                            .into_iter()
                            .filter_map(|mut keyframe| {
                                if keyframe.time_seconds >= left_duration {
                                    keyframe.time_seconds -= left_duration;
                                    Some(keyframe)
                                } else {
                                    None
                                }
                            })
                            .collect();
                        item.duration_seconds = left_duration;
                        item.keyframes
                            .retain(|keyframe| keyframe.time_seconds <= left_duration);
                        track.items.insert(item_index + 1, right);
                        Ok(vec![original_id.clone(), new_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Split timeline item")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let angle_state = state.clone();
    let angle_events = events.clone();
    register::<ItemAngleSetInput, MutationOutput, _, _>(
        registry,
        "timeline.item.angle.set",
        "Switch Unified Angles camera",
        "Switches one timeline segment to another camera inside its Unified Angles asset without changing the clip or its single audio source.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["timeline", "clip", "multicam", "angle", "switch"],
        move |context, input| {
            let state = angle_state.clone();
            let events = angle_events.clone();
            async move {
                let id = input.item_id;
                let angle_asset_id = input.angle_asset_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Switch camera angle",
                    input.expected_revision,
                    |document| {
                        let (track_index, item_index) = find_item_location(document, &id)?;
                        let unified_asset_id = document
                            .project
                            .as_ref()
                            .expect("item location requires an open project")
                            .timeline
                            .tracks[track_index]
                            .items[item_index]
                            .asset_id
                            .clone()
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(format!(
                                    "timeline item `{id}` has no media asset"
                                ))
                            })?;
                        let unified = document
                            .project
                            .as_ref()
                            .expect("item location requires an open project")
                            .assets
                            .iter()
                            .find(|asset| asset.id == unified_asset_id)
                            .and_then(|asset| asset.unified_angles.as_ref())
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(format!(
                                    "timeline item `{id}` does not use a Unified Angles asset"
                                ))
                            })?;
                        if !unified.angle_asset_ids.contains(&angle_asset_id) {
                            return Err(CapabilityError::InvalidInput(format!(
                                "asset `{angle_asset_id}` is not an angle of `{unified_asset_id}`"
                            )));
                        }
                        find_editable_item_mut(document, &id)?.active_angle_asset_id =
                            Some(angle_asset_id.clone());
                        Ok(vec![id.clone(), angle_asset_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Switched camera angle")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let set_angles_state = state.clone();
    let set_angles_events = events.clone();
    register::<ItemAnglesSetInput, MutationOutput, _, _>(
        registry,
        "timeline.items.angle.set",
        "Switch selected Unified Angles cameras",
        "Switches multiple selected timeline cuts from the same Unified Angles asset to one camera in a single undoable transaction.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "timeline",
            "clips",
            "multicam",
            "angle",
            "switch",
            "selection",
        ],
        move |context, input| {
            let state = set_angles_state.clone();
            let events = set_angles_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Switch selected camera angles",
                    input.expected_revision,
                    |document| {
                        if input.item_ids.len() < 2
                            || input.item_ids.iter().collect::<HashSet<_>>().len()
                                != input.item_ids.len()
                        {
                            return Err(CapabilityError::InvalidInput(
                                "itemIds must contain at least two distinct timeline items".into(),
                            ));
                        }

                        let locations = input
                            .item_ids
                            .iter()
                            .map(|id| {
                                let (track_index, item_index) = find_item_location(document, id)?;
                                let item = &document
                                    .project
                                    .as_ref()
                                    .expect("item location requires an open project")
                                    .timeline
                                    .tracks[track_index]
                                    .items[item_index];
                                let asset_id = item.asset_id.clone().ok_or_else(|| {
                                    CapabilityError::InvalidInput(format!(
                                        "timeline item `{id}` has no media asset"
                                    ))
                                })?;
                                Ok((track_index, item_index, id.clone(), asset_id))
                            })
                            .collect::<Result<Vec<_>, CapabilityError>>()?;
                        let unified_asset_id = locations[0].3.clone();
                        if locations
                            .iter()
                            .any(|location| location.3 != unified_asset_id)
                        {
                            return Err(CapabilityError::InvalidInput(
                                "all selected items must use the same Unified Angles asset".into(),
                            ));
                        }
                        let unified = document
                            .project
                            .as_ref()
                            .expect("item location requires an open project")
                            .assets
                            .iter()
                            .find(|asset| asset.id == unified_asset_id)
                            .and_then(|asset| asset.unified_angles.as_ref())
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(format!(
                                    "asset `{unified_asset_id}` is not a Unified Angles asset"
                                ))
                            })?;
                        if !unified.angle_asset_ids.contains(&input.angle_asset_id) {
                            return Err(CapabilityError::InvalidInput(format!(
                                "asset `{}` is not an angle of `{unified_asset_id}`",
                                input.angle_asset_id
                            )));
                        }

                        let project = project_mut(document)?;
                        let mut changed_ids = Vec::with_capacity(locations.len());
                        for (track_index, item_index, item_id, _) in locations {
                            project.timeline.tracks[track_index].items[item_index]
                                .active_angle_asset_id = Some(input.angle_asset_id.clone());
                            changed_ids.push(item_id);
                        }
                        Ok(changed_ids)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Switched selected camera angles")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let set_fit_mode_state = state.clone();
    let set_fit_mode_events = events.clone();
    register::<ItemsFitModeSetInput, MutationOutput, _, _>(
        registry,
        "timeline.items.fit.set",
        "Set video framing",
        "Sets one or more video timeline items to fit the entire source inside the frame or fill the frame while cropping overflow.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["timeline", "video", "framing", "fit", "crop"],
        move |context, input| {
            let state = set_fit_mode_state.clone();
            let events = set_fit_mode_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Set video framing",
                    input.expected_revision,
                    |document| {
                        if input.item_ids.is_empty()
                            || input.item_ids.iter().collect::<HashSet<_>>().len()
                                != input.item_ids.len()
                        {
                            return Err(CapabilityError::InvalidInput(
                                "itemIds must contain distinct video timeline items".into(),
                            ));
                        }

                        let locations = input
                            .item_ids
                            .iter()
                            .map(|id| {
                                let (track_index, item_index) = find_item_location(document, id)?;
                                let item = &document
                                    .project
                                    .as_ref()
                                    .expect("item location requires an open project")
                                    .timeline
                                    .tracks[track_index]
                                    .items[item_index];
                                if item.kind != TimelineItemKind::Video {
                                    return Err(CapabilityError::InvalidInput(format!(
                                        "timeline item `{id}` is not a video"
                                    )));
                                }
                                if item.asset_id.is_none() {
                                    return Err(CapabilityError::InvalidInput(format!(
                                        "timeline item `{id}` has no media asset"
                                    )));
                                }
                                Ok((track_index, item_index, id.clone()))
                            })
                            .collect::<Result<Vec<_>, CapabilityError>>()?;

                        let project = project_mut(document)?;
                        let mut changed_ids = Vec::with_capacity(locations.len());
                        for (track_index, item_index, item_id) in locations {
                            project.timeline.tracks[track_index].items[item_index].fit_mode =
                                Some(input.fit_mode);
                            changed_ids.push(item_id);
                        }
                        Ok(changed_ids)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated video framing")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let cycle_angles_state = state.clone();
    let cycle_angles_events = events.clone();
    register::<ItemAnglesCycleInput, MutationOutput, _, _>(
        registry,
        "timeline.items.angles.cycle",
        "Alternate Unified Angles cameras",
        "Assigns selected cuts from one Unified Angles asset to its cameras in timeline order, cycling through every angle from the chosen starting camera.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "timeline",
            "clips",
            "multicam",
            "angles",
            "alternate",
            "cycle",
        ],
        move |context, input| {
            let state = cycle_angles_state.clone();
            let events = cycle_angles_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Alternate camera angles",
                    input.expected_revision,
                    |document| {
                        if input.item_ids.len() < 2
                            || input.item_ids.iter().collect::<HashSet<_>>().len()
                                != input.item_ids.len()
                        {
                            return Err(CapabilityError::InvalidInput(
                                "itemIds must contain at least two distinct timeline items".into(),
                            ));
                        }

                        let mut locations = input
                            .item_ids
                            .iter()
                            .map(|id| {
                                let (track_index, item_index) = find_item_location(document, id)?;
                                let item = &document
                                    .project
                                    .as_ref()
                                    .expect("item location requires an open project")
                                    .timeline
                                    .tracks[track_index]
                                    .items[item_index];
                                let asset_id = item.asset_id.clone().ok_or_else(|| {
                                    CapabilityError::InvalidInput(format!(
                                        "timeline item `{id}` has no media asset"
                                    ))
                                })?;
                                Ok((
                                    track_index,
                                    item_index,
                                    item.start_seconds,
                                    id.clone(),
                                    asset_id,
                                ))
                            })
                            .collect::<Result<Vec<_>, CapabilityError>>()?;
                        let unified_asset_id = locations[0].4.clone();
                        if locations
                            .iter()
                            .any(|location| location.4 != unified_asset_id)
                        {
                            return Err(CapabilityError::InvalidInput(
                                "all selected items must use the same Unified Angles asset".into(),
                            ));
                        }
                        let unified = document
                            .project
                            .as_ref()
                            .expect("item location requires an open project")
                            .assets
                            .iter()
                            .find(|asset| asset.id == unified_asset_id)
                            .and_then(|asset| asset.unified_angles.clone())
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(format!(
                                    "asset `{unified_asset_id}` is not a Unified Angles asset"
                                ))
                            })?;
                        let starting_index = unified
                            .angle_asset_ids
                            .iter()
                            .position(|id| id == &input.starting_angle_asset_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(format!(
                                    "asset `{}` is not an angle of `{unified_asset_id}`",
                                    input.starting_angle_asset_id
                                ))
                            })?;

                        locations.sort_by(|left, right| {
                            left.2
                                .total_cmp(&right.2)
                                .then_with(|| left.0.cmp(&right.0))
                                .then_with(|| left.1.cmp(&right.1))
                                .then_with(|| left.3.cmp(&right.3))
                        });
                        let project = project_mut(document)?;
                        let mut changed_ids = Vec::with_capacity(locations.len());
                        for (index, (track_index, item_index, _, item_id, _)) in
                            locations.into_iter().enumerate()
                        {
                            let angle_index =
                                (starting_index + index) % unified.angle_asset_ids.len();
                            project.timeline.tracks[track_index].items[item_index]
                                .active_angle_asset_id =
                                Some(unified.angle_asset_ids[angle_index].clone());
                            changed_ids.push(item_id);
                        }
                        Ok(changed_ids)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Alternated camera angles")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let duplicate_state = state.clone();
    let duplicate_events = events.clone();
    register::<ItemDuplicateInput, MutationOutput, _, _>(
        registry,
        "timeline.item.duplicate",
        "Duplicate timeline items",
        "Duplicates items with independent item, effect, and keyframe identifiers.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["clip", "copy", "paste", "duplicate"],
        move |context, input| {
            let state = duplicate_state.clone();
            let events = duplicate_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Duplicate timeline items",
                    input.expected_revision,
                    |document| duplicate_items(document, &input),
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Duplicated timeline items")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let text_state = state;
    let text_events = events;
    register::<TextUpdateInput, MutationOutput, _, _>(
        registry,
        "timeline.text.update",
        "Edit timeline text",
        "Updates text content, font, rich spans, alignment, color, stroke, shadow, spacing, or text box properties.",
        "text",
        AccessLevel::Write,
        false,
        false,
        &["text", "caption", "font", "title", "subtitle"],
        move |context, input| {
            let state = text_state.clone();
            let events = text_events.clone();
            async move {
                let id = input.item_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit text",
                    input.expected_revision,
                    |document| {
                        let item = find_editable_item_mut(document, &id)?;
                        let text = item.text.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput(format!(
                                "timeline item `{id}` is not text or caption content"
                            ))
                        })?;
                        merge_typed(text, input.patch)?;
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Edited text")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeakerFrameBreakoutCreateInput {
    project_id: String,
    source_item_id: String,
    name: Option<String>,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    settings: Option<SpeakerFrameBreakoutSettings>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeakerFrameBreakoutUpdatePatch {
    name: Option<String>,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    background: Option<SmartLayerBackground>,
    layout: Option<SpeakerFrameLayout>,
    fade: Option<SmartLayerFade>,
    background_removal: Option<SmartLayerBackgroundRemoval>,
}

impl SpeakerFrameBreakoutUpdatePatch {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.start_seconds.is_none()
            && self.duration_seconds.is_none()
            && self.background.is_none()
            && self.layout.is_none()
            && self.fade.is_none()
            && self.background_removal.is_none()
    }

    fn changes_configuration(&self) -> bool {
        self.start_seconds.is_some()
            || self.duration_seconds.is_some()
            || self.background.is_some()
            || self.layout.is_some()
            || self.fade.is_some()
            || self.background_removal.is_some()
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeakerFrameBreakoutUpdateInput {
    project_id: String,
    item_id: String,
    patch: SpeakerFrameBreakoutUpdatePatch,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeakerFrameBreakoutInspectInput {
    project_id: String,
    item_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum SmartLayerApplicationStatus {
    Draft,
    Applied,
    Stale,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SpeakerFrameBreakoutInspectOutput {
    project_id: String,
    item_id: String,
    configuration_revision: u64,
    application_status: SmartLayerApplicationStatus,
    settings_signature: String,
    source_signature: String,
    source_items: Vec<SmartLayerSourceItemSnapshot>,
    applied_snapshot: Option<SmartLayerAppliedSnapshot>,
    artifacts_available: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeakerFrameBreakoutApplyInput {
    project_id: String,
    item_id: String,
    configuration_revision: u64,
    settings_signature: String,
    source_signature: String,
    prepared_artifact_uris: Vec<String>,
    processing_backend: String,
    frame_rate: Rational,
    frame_count: u64,
    expected_revision: Option<u64>,
}

fn register_speaker_frame_breakout_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    let create_state = state.clone();
    let create_events = events.clone();
    register::<SpeakerFrameBreakoutCreateInput, MutationOutput, _, _>(
        registry,
        "timeline.smart_layer.speaker_frame_breakout.create",
        "Create Speaker Frame Breakout smart layer",
        "Creates one timeline-visible Speaker Frame Breakout layer directly above a source video. Its rendered base, cutout, background, and fades remain derived state rather than separate timeline items.",
        "simple advanced layers",
        AccessLevel::Write,
        false,
        false,
        &[
            "smart-layer",
            "speaker",
            "frame",
            "breakout",
            "background-removal",
        ],
        move |context, input| {
            let state = create_state.clone();
            let events = create_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Create Speaker Frame Breakout smart layer",
                    input.expected_revision,
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        let project = document.project.as_ref().ok_or_else(|| {
                            CapabilityError::Unavailable("no project is open".into())
                        })?;
                        let (source_track_index, source_track, source_item) = project
                            .timeline
                            .tracks
                            .iter()
                            .enumerate()
                            .find_map(|(track_index, track)| {
                                track
                                    .items
                                    .iter()
                                    .find(|item| item.id == input.source_item_id)
                                    .map(|item| (track_index, track, item))
                            })
                            .ok_or_else(|| {
                                unknown("source timeline item", &input.source_item_id)
                            })?;
                        if !matches!(source_item.kind, TimelineItemKind::Video)
                            || source_item.asset_id.is_none()
                        {
                            return Err(CapabilityError::InvalidInput(format!(
                                "source timeline item `{}` must be video content",
                                input.source_item_id
                            )));
                        }
                        if !source_track.enabled || source_track.hidden || !source_item.enabled {
                            return Err(CapabilityError::InvalidInput(format!(
                                "source timeline item `{}` must be on a visible enabled video track",
                                input.source_item_id
                            )));
                        }
                        let source_start = source_item.start_seconds;
                        let source_end = source_item.end_seconds();
                        let target_index = source_track_index + 1;
                        let reusable_track_id = project
                            .timeline
                            .tracks
                            .get(target_index)
                            .filter(|track| {
                                matches!(track.kind, TrackKind::Adjustment)
                                    && track.enabled
                                    && !track.hidden
                                    && !track.locked
                            })
                            .map(|track| track.id.clone());
                        let start_seconds = input.start_seconds.unwrap_or(source_start);
                        let duration_seconds =
                            input.duration_seconds.unwrap_or(source_end - start_seconds);

                        let new_track_id = reusable_track_id
                            .is_none()
                            .then(|| document.allocate_id("track"));
                        let item_id = document.allocate_id("item");
                        let project = project_mut(document)?;
                        let track_id = if let Some(track_id) = reusable_track_id {
                            track_id
                        } else {
                            let track_id = new_track_id
                                .clone()
                                .expect("new adjustment track id was allocated");
                            project.timeline.tracks.insert(
                                target_index,
                                new_track(
                                    track_id.clone(),
                                    "Simple Advanced Layers",
                                    TrackKind::Adjustment,
                                ),
                            );
                            track_id
                        };
                        let track = project
                            .timeline
                            .tracks
                            .iter_mut()
                            .find(|track| track.id == track_id)
                            .expect("target adjustment track exists");
                        track.items.push(TimelineItem {
                            id: item_id.clone(),
                            name: input
                                .name
                                .unwrap_or_else(|| "Speaker Frame Breakout".into()),
                            kind: TimelineItemKind::SmartLayer,
                            start_seconds,
                            duration_seconds,
                            start: None,
                            duration: None,
                            source_in_seconds: 0.0,
                            source_out_seconds: None,
                            source_in: None,
                            source_out: None,
                            speed: 1.0,
                            enabled: true,
                            locked: false,
                            group_id: None,
                            linked_item_ids: Default::default(),
                            asset_id: None,
                            active_angle_asset_id: None,
                            fit_mode: None,
                            transform: Transform::default(),
                            opacity: 1.0,
                            blend_mode: BlendMode::default(),
                            audio: AudioProperties::default(),
                            text: None,
                            shape: None,
                            smart_layer: Some(SmartLayer::speaker_frame_breakout(
                                input.settings.unwrap_or_default(),
                            )),
                            masks: Vec::new(),
                            effects: Vec::new(),
                            keyframes: Vec::new(),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        resolve_speaker_frame_sources(document, &item_id)?;
                        let mut changed_ids = Vec::new();
                        if let Some(track_id) = new_track_id {
                            changed_ids.push(track_id);
                        }
                        changed_ids.push(item_id);
                        Ok(changed_ids)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Created Speaker Frame Breakout smart layer")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events.clone();
    register::<SpeakerFrameBreakoutUpdateInput, MutationOutput, _, _>(
        registry,
        "timeline.smart_layer.speaker_frame_breakout.update",
        "Update Speaker Frame Breakout smart layer",
        "Updates timing, catalog background, layout, fades, or background-removal settings in one validated undoable operation. Processing is not started; an explicit Apply remains required.",
        "simple advanced layers",
        AccessLevel::Write,
        false,
        false,
        &[
            "smart-layer",
            "speaker",
            "settings",
            "background",
            "manual-apply",
        ],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                if input.patch.is_empty() {
                    return Err(CapabilityError::InvalidInput(
                        "smart layer update patch must change at least one field".into(),
                    ));
                }
                let item_id = input.item_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update Speaker Frame Breakout smart layer",
                    input.expected_revision,
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        {
                            let item = find_editable_item_mut(document, &item_id)?;
                            let changes_configuration = input.patch.changes_configuration();
                            if let Some(name) = input.patch.name {
                                item.name = name;
                            }
                            if let Some(start_seconds) = input.patch.start_seconds {
                                item.start_seconds = start_seconds;
                            }
                            if let Some(duration_seconds) = input.patch.duration_seconds {
                                item.duration_seconds = duration_seconds;
                            }
                            let smart_layer = speaker_frame_breakout_layer_mut(item, &item_id)?;
                            if let Some(background) = input.patch.background {
                                smart_layer.speaker_frame_breakout.background = background;
                            }
                            if let Some(layout) = input.patch.layout {
                                smart_layer.speaker_frame_breakout.layout = layout;
                            }
                            if let Some(fade) = input.patch.fade {
                                smart_layer.speaker_frame_breakout.fade = fade;
                            }
                            if let Some(background_removal) = input.patch.background_removal {
                                smart_layer.speaker_frame_breakout.background_removal =
                                    background_removal;
                            }
                            if changes_configuration {
                                smart_layer.mark_configuration_changed();
                            }
                        }
                        resolve_speaker_frame_sources(document, &item_id)?;
                        Ok(vec![item_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Speaker Frame Breakout smart layer")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let inspect_state = state.clone();
    let inspect_artifacts = artifacts.clone();
    register::<SpeakerFrameBreakoutInspectInput, SpeakerFrameBreakoutInspectOutput, _, _>(
        registry,
        "timeline.smart_layer.speaker_frame_breakout.inspect",
        "Inspect Speaker Frame Breakout smart layer",
        "Resolves the nearest active video track below the smart layer and returns stable settings and source signatures for a manual background-removal Apply.",
        "simple advanced layers",
        AccessLevel::Read,
        true,
        false,
        &["smart-layer", "speaker", "inspect", "source", "signature"],
        move |_, input| {
            let state = inspect_state.clone();
            let artifacts = inspect_artifacts.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store.document_for(Some(&input.project_id)).ok_or_else(|| {
                    CapabilityError::Unavailable(format!(
                        "project `{}` is not open",
                        input.project_id
                    ))
                })?;
                Ok(OperationSuccess::new(inspect_speaker_frame_breakout(
                    document,
                    &input.item_id,
                    Some(&artifacts),
                )?))
            }
        },
    )?;

    let apply_events = events;
    register::<SpeakerFrameBreakoutApplyInput, MutationOutput, _, _>(
        registry,
        "timeline.smart_layer.speaker_frame_breakout.apply",
        "Apply Speaker Frame Breakout processing",
        "Atomically attaches a prepared background-removal snapshot from the bounded ArtifactStore after verifying the current layer configuration and automatically resolved source signatures.",
        "simple advanced layers",
        AccessLevel::Write,
        false,
        false,
        &[
            "smart-layer",
            "speaker",
            "apply",
            "background-removal",
            "artifact",
        ],
        move |context, input| {
            let state = state.clone();
            let events = apply_events.clone();
            let artifacts = artifacts.clone();
            async move {
                if input.prepared_artifact_uris.is_empty() {
                    return Err(CapabilityError::InvalidInput(
                        "preparedArtifactUris must contain at least one ArtifactStore URI".into(),
                    ));
                }
                if input.processing_backend.trim().is_empty() {
                    return Err(CapabilityError::InvalidInput(
                        "processingBackend must not be empty".into(),
                    ));
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let item_id = input.item_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Apply Speaker Frame Breakout processing",
                    input.expected_revision,
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        let inspected =
                            inspect_speaker_frame_breakout(document, &item_id, Some(&artifacts))?;
                        if inspected.configuration_revision != input.configuration_revision {
                            return Err(CapabilityError::Conflict(format!(
                                "smart layer configuration changed: prepared revision {}, current revision is {}",
                                input.configuration_revision, inspected.configuration_revision
                            )));
                        }
                        if inspected.settings_signature != input.settings_signature {
                            return Err(CapabilityError::Conflict(
                                "smart layer settings changed after processing began".into(),
                            ));
                        }
                        if inspected.source_signature != input.source_signature {
                            return Err(CapabilityError::Conflict(
                                "smart layer source videos changed after processing began".into(),
                            ));
                        }
                        validate_speaker_frame_source_coverage(
                            document,
                            &item_id,
                            &inspected.source_items,
                            input.frame_rate,
                            input.frame_count,
                        )?;
                        let prepared_artifacts = validate_speaker_frame_artifacts(
                            &artifacts,
                            &input.prepared_artifact_uris,
                        )?;
                        let snapshot = SmartLayerAppliedSnapshot {
                            configuration_revision: input.configuration_revision,
                            settings_signature: inspected.settings_signature,
                            source_signature: inspected.source_signature,
                            source_items: inspected.source_items,
                            artifacts: prepared_artifacts,
                            processing_backend: input.processing_backend,
                            frame_rate: input.frame_rate,
                            frame_count: input.frame_count,
                            applied_at_ms: now_ms(),
                        };
                        let item = find_editable_item_mut(document, &item_id)?;
                        speaker_frame_breakout_layer_mut(item, &item_id)?
                            .set_applied_snapshot(snapshot);
                        Ok(vec![item_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Applied Speaker Frame Breakout processing")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn ensure_project_target(
    document: &EditorDocument,
    project_id: &str,
) -> Result<(), CapabilityError> {
    let active = document.project.as_ref().map(|project| project.id.as_str());
    if active != Some(project_id) {
        return Err(CapabilityError::Conflict(format!(
            "project target conflict: requested `{project_id}`, active project is `{}`",
            active.unwrap_or("<none>")
        )));
    }
    Ok(())
}

fn speaker_frame_breakout_layer_mut<'a>(
    item: &'a mut TimelineItem,
    item_id: &str,
) -> Result<&'a mut SmartLayer, CapabilityError> {
    if !matches!(item.kind, TimelineItemKind::SmartLayer) {
        return Err(CapabilityError::InvalidInput(format!(
            "timeline item `{item_id}` is not a smart layer"
        )));
    }
    item.smart_layer.as_mut().ok_or_else(|| {
        CapabilityError::InvalidInput(format!(
            "timeline item `{item_id}` has no smart layer settings"
        ))
    })
}

fn speaker_frame_breakout_item<'a>(
    document: &'a EditorDocument,
    item_id: &str,
) -> Result<&'a TimelineItem, CapabilityError> {
    speaker_frame_breakout_location(document, item_id).map(|(_, _, item)| item)
}

fn speaker_frame_breakout_location<'a>(
    document: &'a EditorDocument,
    item_id: &str,
) -> Result<(usize, &'a Track, &'a TimelineItem), CapabilityError> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
    let (track_index, track, item) = project
        .timeline
        .tracks
        .iter()
        .enumerate()
        .find_map(|(track_index, track)| {
            track
                .items
                .iter()
                .find(|item| item.id == item_id)
                .map(|item| (track_index, track, item))
        })
        .ok_or_else(|| unknown("smart layer item", item_id))?;
    if !matches!(item.kind, TimelineItemKind::SmartLayer)
        || item.smart_layer.as_ref().is_none_or(|layer| {
            !matches!(
                layer.layer_type,
                crate::SmartLayerType::SpeakerFrameBreakout
            )
        })
    {
        return Err(CapabilityError::InvalidInput(format!(
            "timeline item `{item_id}` is not a Speaker Frame Breakout smart layer"
        )));
    }
    if !track.enabled || track.hidden {
        return Err(CapabilityError::Unavailable(format!(
            "Speaker Frame Breakout smart layer `{item_id}` is on a hidden or disabled track"
        )));
    }
    if !item.enabled {
        return Err(CapabilityError::Unavailable(format!(
            "Speaker Frame Breakout smart layer `{item_id}` is disabled"
        )));
    }
    Ok((track_index, track, item))
}

fn resolve_speaker_frame_sources(
    document: &EditorDocument,
    item_id: &str,
) -> Result<Vec<SmartLayerSourceItemSnapshot>, CapabilityError> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
    let (smart_track_index, _, smart_item) = speaker_frame_breakout_location(document, item_id)?;
    let smart_start = smart_item.start_seconds;
    let smart_end = smart_item.end_seconds();
    let mut sources = Vec::new();
    for track in project.timeline.tracks[..smart_track_index].iter().rev() {
        if !track.enabled || track.hidden || !matches!(track.kind, TrackKind::Video) {
            continue;
        }
        let mut track_sources = track
            .items
            .iter()
            .filter(|item| {
                item.enabled
                    && matches!(item.kind, TimelineItemKind::Video)
                    && item.start_seconds < smart_end
                    && item.end_seconds() > smart_start
            })
            .map(|item| SmartLayerSourceItemSnapshot {
                track_id: track.id.clone(),
                item_id: item.id.clone(),
                asset_id: item
                    .asset_id
                    .clone()
                    .expect("validated video items have an asset id"),
                start_seconds: item.start_seconds,
                duration_seconds: item.duration_seconds,
                source_in_seconds: item.source_in_seconds,
                source_out_seconds: item.source_out_seconds,
                speed: item.speed,
            })
            .collect::<Vec<_>>();
        track_sources.sort_by(|left, right| {
            left.start_seconds
                .total_cmp(&right.start_seconds)
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
        sources.extend(track_sources);
    }
    if !sources.is_empty() {
        return Ok(sources);
    }
    Err(CapabilityError::Unavailable(format!(
        "smart layer `{item_id}` has no overlapping video on a lower track"
    )))
}

fn validate_speaker_frame_source_coverage(
    document: &EditorDocument,
    item_id: &str,
    sources: &[SmartLayerSourceItemSnapshot],
    frame_rate: Rational,
    frame_count: u64,
) -> Result<(), CapabilityError> {
    frame_rate
        .validate("frameRate")
        .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
    if !rational_values_equal(frame_rate, project.settings.frame_rate_rational) {
        return Err(CapabilityError::InvalidInput(format!(
            "frameRate must match the project frame rate {}/{}",
            project.settings.frame_rate_rational.numerator,
            project.settings.frame_rate_rational.denominator
        )));
    }
    let item = speaker_frame_breakout_item(document, item_id)?;
    let frames_per_second = frame_rate.numerator as f64 / frame_rate.denominator as f64;
    let expected_frame_count = (item.duration_seconds * frames_per_second).ceil() as u64;
    if frame_count != expected_frame_count {
        return Err(CapabilityError::InvalidInput(format!(
            "frameCount {frame_count} does not match the expected {expected_frame_count} frames for this smart layer"
        )));
    }

    let frame_duration = frame_rate.denominator as f64 / frame_rate.numerator as f64;
    let last_time = item.start_seconds + item.duration_seconds * (1.0 - f64::EPSILON);
    for frame_index in 0..frame_count {
        let time = (item.start_seconds + frame_index as f64 * frame_duration).min(last_time);
        if speaker_frame_source_at_time(sources, time).is_none() {
            return Err(CapabilityError::InvalidInput(format!(
                "smart layer source coverage is missing at frame {frame_index} ({time:.6}s)"
            )));
        }
    }
    Ok(())
}

fn speaker_frame_source_at_time(
    sources: &[SmartLayerSourceItemSnapshot],
    time_seconds: f64,
) -> Option<&SmartLayerSourceItemSnapshot> {
    sources.iter().find(|source| {
        time_seconds >= source.start_seconds
            && time_seconds < source.start_seconds + source.duration_seconds
    })
}

fn rational_values_equal(left: Rational, right: Rational) -> bool {
    left.numerator as i128 * right.denominator as i128
        == right.numerator as i128 * left.denominator as i128
}

fn validate_speaker_frame_artifacts(
    artifacts: &ArtifactStore,
    uris: &[String],
) -> Result<Vec<ArtifactRef>, CapabilityError> {
    let mut seen = std::collections::BTreeSet::new();
    uris.iter()
        .map(|uri| {
            if !uri.starts_with(ARTIFACT_URI_PREFIX) || uri == ARTIFACT_URI_PREFIX {
                return Err(CapabilityError::InvalidInput(format!(
                    "prepared artifact `{uri}` must use a canonical ArtifactStore URI"
                )));
            }
            if !seen.insert(uri.as_str()) {
                return Err(CapabilityError::InvalidInput(format!(
                    "prepared artifact URI `{uri}` is duplicated"
                )));
            }
            let stored = artifacts
                .get(uri)
                .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
            validate_speaker_frame_artifact_contents(&stored, uri)
                .map_err(CapabilityError::InvalidInput)?;
            Ok(stored.metadata)
        })
        .collect()
}

fn validate_speaker_frame_artifact_contents(
    stored: &crate::StoredArtifact,
    requested_uri: &str,
) -> Result<(), String> {
    let metadata = &stored.metadata;
    if metadata.uri != requested_uri
        || metadata.uri != format!("{ARTIFACT_URI_PREFIX}{}", metadata.id)
    {
        return Err(format!(
            "prepared artifact `{requested_uri}` is not a canonical ArtifactStore URI"
        ));
    }
    if metadata.mime_type != SMART_LAYER_MASK_ARTIFACT_MIME_TYPE {
        return Err(format!(
            "prepared artifact `{requested_uri}` has MIME type `{}`, expected `{SMART_LAYER_MASK_ARTIFACT_MIME_TYPE}`",
            metadata.mime_type
        ));
    }
    if metadata.duration_ms.is_none_or(|duration| duration == 0) {
        return Err(format!(
            "prepared artifact `{requested_uri}` has no positive duration coverage"
        ));
    }
    if metadata.byte_size != stored.bytes.len() as u64 {
        return Err(format!(
            "prepared artifact `{requested_uri}` byte-size metadata does not match its content"
        ));
    }
    let checksum = format!("{:x}", Sha256::digest(stored.bytes.as_ref()));
    if metadata.sha256 != checksum {
        return Err(format!(
            "prepared artifact `{requested_uri}` checksum does not match its content"
        ));
    }
    Ok(())
}

fn speaker_frame_artifact_is_available(artifacts: &ArtifactStore, expected: &ArtifactRef) -> bool {
    artifacts.get(&expected.uri).is_ok_and(|stored| {
        stored.metadata == *expected
            && validate_speaker_frame_artifact_contents(&stored, &expected.uri).is_ok()
    })
}

fn inspect_speaker_frame_breakout(
    document: &EditorDocument,
    item_id: &str,
    artifacts: Option<&ArtifactStore>,
) -> Result<SpeakerFrameBreakoutInspectOutput, CapabilityError> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
    let item = speaker_frame_breakout_item(document, item_id)?;
    let smart_layer = item
        .smart_layer
        .as_ref()
        .expect("speaker frame helper validated smart layer settings");
    let source_items = resolve_speaker_frame_sources(document, item_id)?;
    let source_assets = source_items
        .iter()
        .map(|source| {
            project
                .assets
                .iter()
                .find(|asset| asset.id == source.asset_id)
                .ok_or_else(|| unknown("source media asset", &source.asset_id))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let settings_signature = stable_signature(&(
        item.start_seconds,
        item.duration_seconds,
        &smart_layer.speaker_frame_breakout,
    ))?;
    let source_signature = stable_signature(&(&source_items, source_assets))?;
    let applied_snapshot = smart_layer.application.applied_snapshot.clone();
    let artifacts_available = applied_snapshot.as_ref().is_some_and(|snapshot| {
        snapshot.artifacts.iter().all(|artifact| {
            artifacts
                .map(|store| speaker_frame_artifact_is_available(store, artifact))
                .unwrap_or(true)
        })
    });
    let application_status = match &applied_snapshot {
        None => SmartLayerApplicationStatus::Draft,
        Some(snapshot)
            if snapshot.configuration_revision
                == smart_layer.application.configuration_revision
                && snapshot.settings_signature == settings_signature
                && snapshot.source_signature == source_signature
                && artifacts_available =>
        {
            SmartLayerApplicationStatus::Applied
        }
        Some(_) => SmartLayerApplicationStatus::Stale,
    };
    Ok(SpeakerFrameBreakoutInspectOutput {
        project_id: project.id.clone(),
        item_id: item_id.into(),
        configuration_revision: smart_layer.application.configuration_revision,
        application_status,
        settings_signature,
        source_signature,
        source_items,
        applied_snapshot,
        artifacts_available,
    })
}

fn stable_signature<T: Serialize>(value: &T) -> Result<String, CapabilityError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| CapabilityError::Failed(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MultiTransformInput {
    item_ids: Vec<String>,
    patch: Value,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupSetInput {
    item_ids: Vec<String>,
    group_id: Option<String>,
    #[serde(default)]
    link_items: bool,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RangeDeleteInput {
    start_seconds: f64,
    end_seconds: f64,
    track_ids: Option<Vec<String>>,
    #[serde(default)]
    ripple: bool,
    expected_revision: Option<u64>,
}

fn register_advanced_edit_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let transform_state = state.clone();
    let transform_events = events.clone();
    register::<MultiTransformInput, MutationOutput, _, _>(
        registry,
        "timeline.items.transform",
        "Transform multiple items",
        "Applies one validated transform patch to multiple selected timeline items in a single undoable operation.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "timeline",
            "multi-select",
            "transform",
            "position",
            "scale",
            "rotation",
        ],
        move |context, input| {
            let state = transform_state.clone();
            let events = transform_events.clone();
            async move {
                if input.item_ids.is_empty() {
                    return Err(CapabilityError::InvalidInput(
                        "itemIds must not be empty".into(),
                    ));
                }
                let item_ids = input.item_ids;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Transform timeline items",
                    input.expected_revision,
                    |document| {
                        for id in &item_ids {
                            let item = find_editable_item_mut(document, id)?;
                            merge_typed(&mut item.transform, input.patch.clone())?;
                        }
                        Ok(item_ids.clone())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Transformed timeline items")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let group_state = state.clone();
    let group_events = events.clone();
    register::<GroupSetInput, MutationOutput, _, _>(
        registry,
        "timeline.group.set",
        "Group or link timeline items",
        "Assigns multiple items to a group and optionally creates symmetric linked-item relationships.",
        "timeline",
        AccessLevel::Write,
        true,
        false,
        &["timeline", "group", "link", "multi-select"],
        move |context, input| {
            let state = group_state.clone();
            let events = group_events.clone();
            async move {
                if input.item_ids.len() < 2 {
                    return Err(CapabilityError::InvalidInput(
                        "at least two itemIds are required".into(),
                    ));
                }
                let item_ids = input.item_ids;
                let group_id = input.group_id.unwrap_or_else(|| {
                    let mut sorted = item_ids.clone();
                    sorted.sort();
                    format!("group-{}", sorted.join("-"))
                });
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Group timeline items",
                    input.expected_revision,
                    |document| {
                        for id in &item_ids {
                            let item = find_editable_item_mut(document, id)?;
                            item.group_id = Some(group_id.clone());
                            if input.link_items {
                                item.linked_item_ids = item_ids
                                    .iter()
                                    .filter(|other| *other != id)
                                    .cloned()
                                    .collect();
                            }
                        }
                        Ok(item_ids.clone())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Grouped timeline items")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    register::<RangeDeleteInput, MutationOutput, _, _>(
        registry,
        "timeline.range.delete",
        "Delete timeline range",
        "Deletes or trims content intersecting a time range and optionally ripple-closes the removed duration.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["timeline", "range", "gap", "ripple", "delete"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if !input.start_seconds.is_finite()
                    || !input.end_seconds.is_finite()
                    || input.start_seconds < 0.0
                    || input.end_seconds <= input.start_seconds
                {
                    return Err(CapabilityError::InvalidInput(
                        "range must contain finite non-negative startSeconds before endSeconds"
                            .into(),
                    ));
                }
                let range_duration = input.end_seconds - input.start_seconds;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete timeline range",
                    input.expected_revision,
                    |document| {
                        let project = project_mut(document)?;
                        let selected_tracks = input.track_ids.as_ref();
                        let mut changed = Vec::new();
                        for track in &mut project.timeline.tracks {
                            if selected_tracks
                                .is_some_and(|ids| !ids.iter().any(|id| id == &track.id))
                            {
                                continue;
                            }
                            if track.locked {
                                return Err(CapabilityError::Denied(format!(
                                    "track `{}` is locked",
                                    track.id
                                )));
                            }
                            let mut retained = Vec::with_capacity(track.items.len());
                            for mut item in std::mem::take(&mut track.items) {
                                let item_start = item.start_seconds;
                                let item_end = item.end_seconds();
                                if item_end <= input.start_seconds {
                                    retained.push(item);
                                } else if item_start >= input.end_seconds {
                                    if input.ripple {
                                        item.start_seconds -= range_duration;
                                        changed.push(item.id.clone());
                                    }
                                    retained.push(item);
                                } else if item_start >= input.start_seconds
                                    && item_end <= input.end_seconds
                                {
                                    changed.push(item.id);
                                } else if item_start < input.start_seconds
                                    && item_end <= input.end_seconds
                                {
                                    item.duration_seconds = input.start_seconds - item_start;
                                    changed.push(item.id.clone());
                                    retained.push(item);
                                } else if item_start >= input.start_seconds
                                    && item_end > input.end_seconds
                                {
                                    let removed_source =
                                        (input.end_seconds - item_start) * item.speed;
                                    item.source_in_seconds += removed_source;
                                    item.duration_seconds = item_end - input.end_seconds;
                                    item.start_seconds = if input.ripple {
                                        input.start_seconds
                                    } else {
                                        input.end_seconds
                                    };
                                    changed.push(item.id.clone());
                                    retained.push(item);
                                } else {
                                    item.duration_seconds -= range_duration;
                                    changed.push(item.id.clone());
                                    retained.push(item);
                                }
                            }
                            track.items = retained;
                        }
                        project.timeline.transitions.retain(|transition| {
                            transition
                                .from_item_id
                                .as_ref()
                                .is_none_or(|id| !changed.contains(id))
                                && transition
                                    .to_item_id
                                    .as_ref()
                                    .is_none_or(|id| !changed.contains(id))
                        });
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted timeline range")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectAddInput {
    item_id: String,
    effect_type: String,
    name: String,
    #[serde(default)]
    parameters: Map<String, Value>,
    index: Option<usize>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectDeleteInput {
    effect_id: String,
    expected_revision: Option<u64>,
}

fn register_effect_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let add_state = state.clone();
    let add_events = events.clone();
    register::<EffectAddInput, MutationOutput, _, _>(
        registry,
        "timeline.effect.add",
        "Add item effect",
        "Adds any effect type with arbitrary typed parameters to a timeline item.",
        "effects",
        AccessLevel::Write,
        false,
        false,
        &["effect", "filter", "color", "blur", "audio"],
        move |context, input| {
            let state = add_state.clone();
            let events = add_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Add effect",
                    input.expected_revision,
                    |document| {
                        let id = document.allocate_id("effect");
                        let item = find_editable_item_mut(document, &input.item_id)?;
                        let index = input.index.unwrap_or(item.effects.len());
                        if index > item.effects.len() {
                            return Err(CapabilityError::InvalidInput(
                                "effect index is out of range".into(),
                            ));
                        }
                        item.effects.insert(
                            index,
                            Effect {
                                id: id.clone(),
                                effect_type: input.effect_type,
                                name: input.name,
                                enabled: true,
                                parameters: input.parameters,
                                extensions: Map::new(),
                            },
                        );
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Added effect")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let update_state = state.clone();
    let update_events = events.clone();
    register::<EntityPatchInput, MutationOutput, _, _>(
        registry,
        "timeline.effect.update",
        "Update item effect",
        "Updates effect type, enabled state, parameters, metadata, or extensions.",
        "effects",
        AccessLevel::Write,
        false,
        false,
        &["effect", "filter", "parameters"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update effect",
                    input.expected_revision,
                    |document| {
                        let effect = find_effect_mut(document, &id)?;
                        merge_typed(effect, input.patch)?;
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated effect")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let delete_state = state.clone();
    let delete_events = events.clone();
    register::<EffectDeleteInput, MutationOutput, _, _>(
        registry,
        "timeline.effect.delete",
        "Delete item effect",
        "Removes an effect from a timeline item.",
        "effects",
        AccessLevel::Write,
        false,
        false,
        &["effect", "filter", "delete"],
        move |context, input| {
            let state = delete_state.clone();
            let events = delete_events.clone();
            async move {
                let id = input.effect_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete effect",
                    input.expected_revision,
                    |document| {
                        let mut found = false;
                        for track in &mut project_mut(document)?.timeline.tracks {
                            for item in &mut track.items {
                                let before = item.effects.len();
                                item.effects.retain(|effect| effect.id != id);
                                found |= before != item.effects.len();
                            }
                        }
                        if !found {
                            return Err(unknown("effect", &id));
                        }
                        document.selection.effect_ids.remove(&id);
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted effect")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let reorder_state = state;
    let reorder_events = events;
    register::<ReorderInput, MutationOutput, _, _>(
        registry,
        "timeline.effect.reorder",
        "Reorder item effect",
        "Moves an effect to a new position in its item's effect stack.",
        "effects",
        AccessLevel::Write,
        true,
        false,
        &["effect", "stack", "order"],
        move |context, input| {
            let state = reorder_state.clone();
            let events = reorder_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Reorder effect",
                    input.expected_revision,
                    |document| {
                        for track in &mut project_mut(document)?.timeline.tracks {
                            for item in &mut track.items {
                                if let Some(current) =
                                    item.effects.iter().position(|effect| effect.id == id)
                                {
                                    let effect = item.effects.remove(current);
                                    let index = input.index.min(item.effects.len());
                                    item.effects.insert(index, effect);
                                    return Ok(vec![id.clone()]);
                                }
                            }
                        }
                        Err(unknown("effect", &id))
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Reordered effect")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyframeSetInput {
    item_id: String,
    id: Option<String>,
    property: String,
    time_seconds: f64,
    value: Value,
    interpolation: KeyframeInterpolation,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyframeDeleteInput {
    item_id: String,
    keyframe_id: String,
    expected_revision: Option<u64>,
}

fn register_keyframe_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let set_state = state.clone();
    let set_events = events.clone();
    register::<KeyframeSetInput, MutationOutput, _, _>(
        registry,
        "timeline.keyframe.set",
        "Set item keyframe",
        "Creates or updates a keyframe for any addressable item/effect property.",
        "keyframes",
        AccessLevel::Write,
        true,
        false,
        &["animation", "keyframe", "property", "easing"],
        move |context, input| {
            let state = set_state.clone();
            let events = set_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Set keyframe",
                    input.expected_revision,
                    |document| {
                        let id = input
                            .id
                            .clone()
                            .unwrap_or_else(|| document.allocate_id("keyframe"));
                        let item = find_editable_item_mut(document, &input.item_id)?;
                        let keyframe = Keyframe {
                            id: id.clone(),
                            property: input.property,
                            time_seconds: input.time_seconds,
                            time: None,
                            value: input.value,
                            interpolation: input.interpolation,
                            easing: None,
                        };
                        if let Some(existing) =
                            item.keyframes.iter_mut().find(|keyframe| keyframe.id == id)
                        {
                            *existing = keyframe;
                        } else {
                            item.keyframes.push(keyframe);
                            item.keyframes.sort_by(|left, right| {
                                left.time_seconds.total_cmp(&right.time_seconds)
                            });
                        }
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Set keyframe")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let delete_state = state;
    let delete_events = events;
    register::<KeyframeDeleteInput, MutationOutput, _, _>(
        registry,
        "timeline.keyframe.delete",
        "Delete item keyframe",
        "Deletes a keyframe from an item.",
        "keyframes",
        AccessLevel::Write,
        false,
        false,
        &["animation", "keyframe", "delete"],
        move |context, input| {
            let state = delete_state.clone();
            let events = delete_events.clone();
            async move {
                let id = input.keyframe_id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete keyframe",
                    input.expected_revision,
                    |document| {
                        let item = find_editable_item_mut(document, &input.item_id)?;
                        let before = item.keyframes.len();
                        item.keyframes.retain(|keyframe| keyframe.id != id);
                        if before == item.keyframes.len() {
                            return Err(unknown("keyframe", &id));
                        }
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted keyframe")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionAddInput {
    transition_type: String,
    from_item_id: Option<String>,
    to_item_id: Option<String>,
    start_seconds: f64,
    duration_seconds: f64,
    #[serde(default)]
    parameters: Map<String, Value>,
    expected_revision: Option<u64>,
}

fn register_transition_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let add_state = state.clone();
    let add_events = events.clone();
    register::<TransitionAddInput, MutationOutput, _, _>(
        registry,
        "timeline.transition.add",
        "Add transition",
        "Adds a transition between timeline items or at a timeline boundary.",
        "transitions",
        AccessLevel::Write,
        false,
        false,
        &["transition", "crossfade", "wipe"],
        move |context, input| {
            let state = add_state.clone();
            let events = add_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Add transition",
                    input.expected_revision,
                    |document| {
                        let id = document.allocate_id("transition");
                        project_mut(document)?
                            .timeline
                            .transitions
                            .push(Transition {
                                id: id.clone(),
                                transition_type: input.transition_type,
                                from_item_id: input.from_item_id,
                                to_item_id: input.to_item_id,
                                start_seconds: input.start_seconds,
                                duration_seconds: input.duration_seconds,
                                start: None,
                                duration: None,
                                enabled: true,
                                parameters: input.parameters,
                            });
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Added transition")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;
    register_patch_and_delete(
        registry,
        state,
        events,
        EntityKind::Transition,
        "timeline.transition.update",
        "Update transition",
        "timeline.transition.delete",
        "Delete transition",
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkerAddInput {
    time_seconds: f64,
    duration_seconds: Option<f64>,
    name: String,
    #[serde(default = "default_marker_color")]
    color: String,
    note: Option<String>,
    expected_revision: Option<u64>,
}

fn default_marker_color() -> String {
    "#facc15".into()
}

fn register_marker_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let add_state = state.clone();
    let add_events = events.clone();
    register::<MarkerAddInput, MutationOutput, _, _>(
        registry,
        "timeline.marker.add",
        "Add timeline marker",
        "Adds a named, colored marker at a timeline position.",
        "markers",
        AccessLevel::Write,
        false,
        false,
        &["marker", "note", "chapter"],
        move |context, input| {
            let state = add_state.clone();
            let events = add_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Add marker",
                    input.expected_revision,
                    |document| {
                        let id = document.allocate_id("marker");
                        project_mut(document)?.timeline.markers.push(Marker {
                            id: id.clone(),
                            time_seconds: input.time_seconds,
                            time: None,
                            duration_seconds: input.duration_seconds,
                            duration: None,
                            name: input.name,
                            color: input.color,
                            note: input.note,
                        });
                        Ok(vec![id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Added marker")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;
    register_patch_and_delete(
        registry,
        state,
        events,
        EntityKind::Marker,
        "timeline.marker.update",
        "Update marker",
        "timeline.marker.delete",
        "Delete marker",
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptionImportInput {
    track_id: String,
    format: String,
    content: String,
    #[serde(default)]
    offset_seconds: f64,
    expected_revision: Option<u64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptionExportInput {
    project_id: Option<String>,
    #[serde(default = "default_caption_format")]
    format: String,
}

fn default_caption_format() -> String {
    "vtt".into()
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CaptionExportOutput {
    format: String,
    cue_count: usize,
    content: String,
    artifact: ArtifactRef,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptionTranscribeInput {
    asset_id: String,
    track_id: String,
    language: Option<String>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Clone)]
struct CaptionCue {
    start_seconds: f64,
    end_seconds: f64,
    text: String,
}

fn register_caption_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    let import_state = state.clone();
    let import_events = events.clone();
    register::<CaptionImportInput, MutationOutput, _, _>(
        registry,
        "caption.import",
        "Import captions",
        "Parses SRT or WebVTT text into editable caption timeline items.",
        "caption",
        AccessLevel::Write,
        false,
        false,
        &["caption", "subtitle", "srt", "vtt", "import", "transcript"],
        move |context, input| {
            let state = import_state.clone();
            let events = import_events.clone();
            async move {
                let cues = parse_caption_cues(&input.format, &input.content)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Import captions",
                    input.expected_revision,
                    |document| {
                        insert_caption_cues(document, &input.track_id, cues, input.offset_seconds)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Imported captions")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    let export_state = state.clone();
    let export_artifacts = artifacts.clone();
    register::<CaptionExportInput, CaptionExportOutput, _, _>(
        registry,
        "caption.export",
        "Export captions",
        "Serializes editable caption items as SRT or WebVTT and returns both text and an artifact.",
        "caption",
        AccessLevel::Read,
        true,
        false,
        &["caption", "subtitle", "srt", "vtt", "export", "transcript"],
        move |_, input| {
            let state = export_state.clone();
            let artifacts = export_artifacts.clone();
            async move {
                let format = normalized_caption_format(&input.format)?;
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store
                    .document_for(input.project_id.as_deref())
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let project = document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                let mut cues: Vec<_> = project
                    .timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.items)
                    .filter(|item| item.kind == TimelineItemKind::Caption)
                    .filter_map(|item| {
                        Some(CaptionCue {
                            start_seconds: item.start_seconds,
                            end_seconds: item.end_seconds(),
                            text: item.text.as_ref()?.content.clone(),
                        })
                    })
                    .collect();
                cues.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
                let content = serialize_caption_cues(format, &cues);
                let mime_type = if format == "vtt" {
                    "text/vtt"
                } else {
                    "application/x-subrip"
                };
                let artifact = artifacts
                    .put(content.as_bytes().to_vec(), mime_type, None, None, None)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(CaptionExportOutput {
                    format: format.into(),
                    cue_count: cues.len(),
                    content,
                    artifact: artifact.clone(),
                })
                .artifact(artifact)
                .summary("Exported captions"))
            }
        },
    )?;

    register::<CaptionTranscribeInput, MutationOutput, _, _>(
        registry,
        "caption.transcribe",
        "Transcribe media locally",
        "Runs the configured local Whisper executable, imports its WebVTT result, and never sends media to a hosted service.",
        "caption",
        AccessLevel::Write,
        false,
        true,
        &[
            "caption",
            "transcribe",
            "whisper",
            "local",
            "speech-to-text",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "caption.transcribe does not support dry-run".into(),
                    ));
                }
                let executable = std::env::var("OPENCUT_WHISPER_COMMAND").map_err(|_| {
                    CapabilityError::Unavailable(
                        "set OPENCUT_WHISPER_COMMAND to a local OpenAI Whisper CLI executable"
                            .into(),
                    )
                })?;
                {
                    let document = state
                        .read()
                        .map_err(|_| {
                            CapabilityError::Failed("editor state lock was poisoned".into())
                        })?
                        .document
                        .clone();
                    check_target(&document, &context)?;
                    check_revision(
                        &document,
                        input.expected_revision.or_else(|| {
                            context
                                .metadata
                                .get("opencut/expectedRevision")
                                .and_then(Value::as_u64)
                        }),
                    )?;
                }
                let asset = active_asset(&state, &input.asset_id)?;
                let output_directory = tempfile::tempdir()
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let mut arguments = vec![
                    asset.source,
                    "--output_format".into(),
                    "vtt".into(),
                    "--output_dir".into(),
                    output_directory.path().to_string_lossy().into_owned(),
                ];
                if let Some(language) = input.language {
                    arguments.extend(["--language".into(), language]);
                }
                run_cancellable_program(&executable, &arguments, &context)?;
                let output_path = std::fs::read_dir(output_directory.path())
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .find(|path| {
                        path.extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("vtt"))
                    })
                    .ok_or_else(|| {
                        CapabilityError::Failed(
                            "Whisper completed without producing a WebVTT file".into(),
                        )
                    })?;
                let content = std::fs::read_to_string(output_path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let cues = parse_caption_cues("vtt", &content)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Transcribe captions",
                    input.expected_revision,
                    |document| insert_caption_cues(document, &input.track_id, cues, 0.0),
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Transcribed captions locally")
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn insert_caption_cues(
    document: &mut EditorDocument,
    track_id: &str,
    cues: Vec<CaptionCue>,
    offset_seconds: f64,
) -> Result<Vec<String>, CapabilityError> {
    if !offset_seconds.is_finite() {
        return Err(CapabilityError::InvalidInput(
            "offsetSeconds must be finite".into(),
        ));
    }
    let mut ids = Vec::with_capacity(cues.len());
    for cue in cues {
        let start_seconds = cue.start_seconds + offset_seconds;
        if start_seconds < 0.0 {
            return Err(CapabilityError::InvalidInput(
                "caption offset places a cue before zero".into(),
            ));
        }
        let id = document.allocate_id("item");
        let mut text = TextProperties::default();
        text.content = cue.text;
        let item = TimelineItem {
            id: id.clone(),
            name: format!("Caption {}", ids.len() + 1),
            kind: TimelineItemKind::Caption,
            start_seconds,
            duration_seconds: cue.end_seconds - cue.start_seconds,
            start: None,
            duration: None,
            source_in_seconds: 0.0,
            source_out_seconds: None,
            source_in: None,
            source_out: None,
            speed: 1.0,
            enabled: true,
            locked: false,
            group_id: None,
            linked_item_ids: Default::default(),
            asset_id: None,
            active_angle_asset_id: None,
            fit_mode: None,
            transform: Transform::default(),
            opacity: 1.0,
            blend_mode: BlendMode::default(),
            audio: AudioProperties::default(),
            text: Some(text),
            shape: None,
            smart_layer: None,
            masks: Vec::new(),
            effects: Vec::new(),
            keyframes: Vec::new(),
            metadata: Default::default(),
            extensions: Map::new(),
        };
        find_track_mut(document, track_id)?.items.push(item);
        ids.push(id);
    }
    find_track_mut(document, track_id)?
        .items
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    Ok(ids)
}

fn parse_caption_cues(format: &str, content: &str) -> Result<Vec<CaptionCue>, CapabilityError> {
    normalized_caption_format(format)?;
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = Vec::new();
    for block in normalized.split("\n\n") {
        let lines: Vec<_> = block.lines().map(str::trim).collect();
        let Some(timing_index) = lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let mut timing = lines[timing_index].split("-->");
        let start = parse_caption_timestamp(timing.next().unwrap_or_default().trim())?;
        let end_text = timing.next().unwrap_or_default().trim();
        let end = parse_caption_timestamp(end_text.split_whitespace().next().unwrap_or_default())?;
        let text = lines
            .iter()
            .skip(timing_index + 1)
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        if end <= start || text.is_empty() {
            continue;
        }
        cues.push(CaptionCue {
            start_seconds: start,
            end_seconds: end,
            text,
        });
    }
    if cues.is_empty() {
        return Err(CapabilityError::InvalidInput(
            "caption content contains no valid cues".into(),
        ));
    }
    Ok(cues)
}

fn normalized_caption_format(format: &str) -> Result<&'static str, CapabilityError> {
    if format.eq_ignore_ascii_case("vtt") || format.eq_ignore_ascii_case("webvtt") {
        Ok("vtt")
    } else if format.eq_ignore_ascii_case("srt") || format.eq_ignore_ascii_case("subrip") {
        Ok("srt")
    } else {
        Err(CapabilityError::InvalidInput(
            "caption format must be `srt` or `vtt`".into(),
        ))
    }
}

fn parse_caption_timestamp(value: &str) -> Result<f64, CapabilityError> {
    let parts: Vec<_> = value
        .replace(',', ".")
        .split(':')
        .map(str::to_owned)
        .collect();
    let seconds = match parts.as_slice() {
        [minutes, seconds] => minutes
            .parse::<f64>()
            .ok()
            .zip(seconds.parse::<f64>().ok())
            .map(|(minutes, seconds)| minutes * 60.0 + seconds),
        [hours, minutes, seconds] => hours
            .parse::<f64>()
            .ok()
            .zip(minutes.parse::<f64>().ok())
            .zip(seconds.parse::<f64>().ok())
            .map(|((hours, minutes), seconds)| hours * 3600.0 + minutes * 60.0 + seconds),
        _ => None,
    };
    seconds.ok_or_else(|| {
        CapabilityError::InvalidInput(format!("invalid caption timestamp `{value}`"))
    })
}

fn serialize_caption_cues(format: &str, cues: &[CaptionCue]) -> String {
    let mut output = if format == "vtt" {
        "WEBVTT\n\n".to_owned()
    } else {
        String::new()
    };
    for (index, cue) in cues.iter().enumerate() {
        if format == "srt" {
            output.push_str(&format!("{}\n", index + 1));
        }
        output.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_caption_timestamp(cue.start_seconds, format == "srt"),
            format_caption_timestamp(cue.end_seconds, format == "srt"),
            cue.text
        ));
    }
    output
}

fn format_caption_timestamp(seconds: f64, comma: bool) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = total_ms / 60_000 % 60;
    let seconds = total_ms / 1_000 % 60;
    let milliseconds = total_ms % 1_000;
    format!(
        "{hours:02}:{minutes:02}:{seconds:02}{}{milliseconds:03}",
        if comma { ',' } else { '.' }
    )
}

fn run_cancellable_program(
    executable: &str,
    arguments: &[String],
    context: &InvocationContext,
) -> Result<(), CapabilityError> {
    let mut child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            CapabilityError::Failed(format!("failed to launch `{executable}`: {error}"))
        })?;
    loop {
        if context.cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CapabilityError::Failed("operation was cancelled".into()));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| CapabilityError::Failed(error.to_string()))?
        {
            return if status.success() {
                Ok(())
            } else {
                Err(CapabilityError::Failed(format!(
                    "`{executable}` exited with {status}"
                )))
            };
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn register_playback_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<MergePatchInput, MutationOutput, _, _>(
        registry,
        "playback.update",
        "Control playback",
        "Controls play/pause, playhead position, rate, loop range, preview volume, and mute state.",
        "playback",
        AccessLevel::Write,
        false,
        false,
        &["play", "pause", "seek", "playhead", "loop", "volume"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update playback",
                    input.expected_revision,
                    |document| {
                        merge_typed(&mut document.playback, input.patch)?;
                        Ok(Vec::new())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated playback")
                    .changed([STATE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionSetInput {
    selection: SelectionState,
    expected_revision: Option<u64>,
}

fn register_selection_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<SelectionSetInput, MutationOutput, _, _>(
        registry,
        "selection.set",
        "Set editor selection",
        "Selects any assets, tracks, timeline items, or effects exactly as a human editor can.",
        "selection",
        AccessLevel::Write,
        true,
        false,
        &["select", "focus", "inspector"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Set selection",
                    input.expected_revision,
                    |document| {
                        document.selection = input.selection;
                        Ok(Vec::new())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Set selection")
                    .changed([STATE_RESOURCE]))
            }
        },
    )
}

fn register_workspace_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<MergePatchInput, MutationOutput, _, _>(
        registry,
        "workspace.update",
        "Update editor workspace",
        "Controls active panel, snapping, ripple editing, preview quality, and extensible panel state.",
        "workspace",
        AccessLevel::Write,
        false,
        false,
        &["panel", "snapping", "ripple", "preview", "workspace"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update workspace",
                    input.expected_revision,
                    |document| {
                        merge_typed(&mut document.workspace, input.patch)?;
                        Ok(Vec::new())
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated workspace")
                    .changed([STATE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportRenderInput {
    output_path: String,
    preset_id: Option<String>,
    #[serde(default)]
    overwrite: bool,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewFrameInput {
    output_path: String,
    position_seconds: Option<f64>,
    #[serde(default)]
    overwrite: bool,
    expected_revision: Option<u64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewCaptureInput {
    project_id: Option<String>,
    position_seconds: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default = "default_preview_format")]
    format: String,
    expected_revision: Option<u64>,
}

fn default_preview_format() -> String {
    "png".into()
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenderOutput {
    revision: u64,
    output_path: String,
    bytes_written: u64,
    command: Vec<String>,
    warnings: Vec<String>,
    log: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PreviewCaptureOutput {
    revision: u64,
    position_seconds: f64,
    width: u32,
    height: u32,
    artifact: ArtifactRef,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenderCapabilitiesOutput {
    backend: String,
    preview_export_shared: bool,
    supported: Vec<String>,
    unsupported: Vec<String>,
    ffmpeg_available: bool,
    ffprobe_available: bool,
}

fn register_render_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    register::<EmptyInput, RenderCapabilitiesOutput, _, _>(
        registry,
        "render.capabilities.list",
        "List render capabilities",
        "Reports exactly which project features the active preview/export backend renders faithfully and which remain compatibility limitations.",
        "render",
        AccessLevel::Read,
        true,
        false,
        &[
            "render",
            "preview",
            "export",
            "effects",
            "diagnostics",
            "fidelity",
        ],
        move |_, _| async move {
            Ok(OperationSuccess::new(RenderCapabilitiesOutput {
                backend: "ffmpeg-compatibility".into(),
                preview_export_shared: true,
                supported: vec![
                    "video/image layers",
                    "source trim and speed",
                    "position/scale/rotation/crop",
                    "opacity",
                    "audio mixing/volume/tempo",
                    "base text and captions",
                    "solid shapes",
                    "color correction",
                    "blur",
                    "hue",
                    "solid canvas background",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
                unsupported: vec![
                    "animated keyframe evaluation",
                    "soft transitions",
                    "adjustment layers",
                    "rich text spans",
                    "masks",
                    "gradient backgrounds",
                    "unknown effect types",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
                ffmpeg_available: command_available(
                    &std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()),
                ),
                ffprobe_available: command_available(
                    &std::env::var("OPENCUT_FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into()),
                ),
            }))
        },
    )?;

    let export_state = state.clone();
    let export_artifacts = artifacts.clone();
    register::<ExportRenderInput, RenderOutput, _, _>(
        registry,
        "export.render",
        "Render timeline",
        "Renders the open timeline to a video file with FFmpeg using project tracks, timing, transforms, crop, opacity, audio, text, shapes, and supported effects.",
        "export",
        AccessLevel::Destructive,
        false,
        true,
        &["render", "export", "encode", "video", "ffmpeg"],
        move |context, input| {
            let state = export_state.clone();
            let artifacts = export_artifacts.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "export.render does not support dry-run".into(),
                    ));
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let document = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?
                    .document
                    .clone();
                check_revision(&document, input.expected_revision)?;
                check_target(&document, &context)?;
                let report = render(
                    &document,
                    &input.output_path,
                    input.preset_id.as_deref(),
                    RenderTarget::Video,
                    input.overwrite,
                    &context.cancellation,
                )
                .map_err(CapabilityError::Failed)?;
                let bytes_written = std::fs::metadata(&input.output_path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?
                    .len();
                let artifact = if bytes_written <= 64 * 1024 * 1024 {
                    let bytes = std::fs::read(&input.output_path)
                        .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                    let mime_type = render_mime_type(&input.output_path);
                    Some(
                        artifacts
                            .put(bytes, mime_type, None, None, None)
                            .map_err(|error| CapabilityError::Failed(error.to_string()))?,
                    )
                } else {
                    None
                };
                let mut success = OperationSuccess::new(RenderOutput {
                    revision: document.revision,
                    output_path: input.output_path,
                    bytes_written,
                    command: report.command,
                    warnings: report.warnings,
                    log: report.stderr,
                })
                .summary("Rendered timeline");
                if let Some(artifact) = artifact {
                    success = success.artifact(artifact);
                }
                Ok(success)
            }
        },
    )?;

    let render_state = state.clone();
    register::<PreviewFrameInput, RenderOutput, _, _>(
        registry,
        "preview.frame.render",
        "Render preview frame",
        "Renders a still image of the exact composited timeline at the requested position, or at the current playhead when omitted.",
        "preview",
        AccessLevel::Destructive,
        false,
        true,
        &["preview", "frame", "thumbnail", "playhead", "ffmpeg"],
        move |context, input| {
            let state = render_state.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "preview.frame.render does not support dry-run".into(),
                    ));
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let document = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?
                    .document
                    .clone();
                check_revision(&document, input.expected_revision)?;
                check_target(&document, &context)?;
                let position = input
                    .position_seconds
                    .unwrap_or(document.playback.position_seconds);
                let report = render(
                    &document,
                    &input.output_path,
                    None,
                    RenderTarget::Frame {
                        position_seconds: position,
                        width: None,
                        height: None,
                    },
                    input.overwrite,
                    &context.cancellation,
                )
                .map_err(CapabilityError::Failed)?;
                let bytes_written = std::fs::metadata(&input.output_path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?
                    .len();
                Ok(OperationSuccess::new(RenderOutput {
                    revision: document.revision,
                    output_path: input.output_path,
                    bytes_written,
                    command: report.command,
                    warnings: report.warnings,
                    log: report.stderr,
                })
                .summary("Rendered preview frame"))
            }
        },
    )?;

    register::<PreviewCaptureInput, PreviewCaptureOutput, _, _>(
        registry,
        "preview.frame.capture",
        "Capture preview frame",
        "Renders the exact composited timeline frame and returns it as an opaque MCP image artifact. No filesystem path is required.",
        "preview",
        AccessLevel::Read,
        true,
        true,
        &[
            "preview",
            "frame",
            "screenshot",
            "image",
            "playhead",
            "artifact",
        ],
        move |context, input| {
            let state = state.clone();
            let artifacts = artifacts.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                if !input.format.eq_ignore_ascii_case("png") {
                    return Err(CapabilityError::InvalidInput(
                        "preview capture currently supports `png` format".into(),
                    ));
                }
                let document = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?
                    .document_for(input.project_id.as_deref())
                    .cloned()
                    .ok_or_else(|| CapabilityError::Unavailable("project is not open".into()))?;
                check_revision(&document, input.expected_revision)?;
                let project = document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))?;
                let requested_width = input.width.unwrap_or(project.settings.width);
                let requested_height = input.height.unwrap_or(project.settings.height);
                if requested_width == 0 || requested_height == 0 {
                    return Err(CapabilityError::InvalidInput(format!(
                        "capture dimensions must be non-zero (received {requested_width}x{requested_height})"
                    )));
                }
                let position = input
                    .position_seconds
                    .unwrap_or(document.playback.position_seconds);
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let output_path = std::env::temp_dir().join(format!("opencut-preview-{nonce}.png"));
                let output_path_string = output_path.to_string_lossy().into_owned();
                let report = render(
                    &document,
                    &output_path_string,
                    None,
                    RenderTarget::Frame {
                        position_seconds: position,
                        width: Some(requested_width),
                        height: Some(requested_height),
                    },
                    false,
                    &context.cancellation,
                )
                .map_err(CapabilityError::Failed)?;
                let bytes = std::fs::read(&output_path)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                let _ = std::fs::remove_file(&output_path);
                let artifact = artifacts
                    .put(
                        bytes,
                        "image/png",
                        Some(requested_width),
                        Some(requested_height),
                        None,
                    )
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?;
                Ok(OperationSuccess::new(PreviewCaptureOutput {
                    revision: document.revision,
                    position_seconds: position,
                    width: requested_width,
                    height: requested_height,
                    artifact: artifact.clone(),
                    warnings: report.warnings,
                })
                .artifact(artifact)
                .summary("Captured preview frame"))
            }
        },
    )
}

fn render_mime_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct HistoryOutput {
    revision: u64,
    action: String,
    can_undo: bool,
    can_redo: bool,
}

fn register_history_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let undo_state = state.clone();
    let undo_events = events.clone();
    register::<EmptyInput, HistoryOutput, _, _>(
        registry,
        "history.undo",
        "Undo editor action",
        "Undoes the last committed editor operation, including agent or human edits.",
        "history",
        AccessLevel::Write,
        false,
        false,
        &["undo", "history"],
        move |context, _| {
            let state = undo_state.clone();
            let events = undo_events.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "history.undo does not support dry-run".into(),
                    ));
                }
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let entry = store
                    .undo
                    .pop()
                    .ok_or_else(|| CapabilityError::Unavailable("nothing to undo".into()))?;
                let current_revision = store.document.revision;
                let current = HistoryEntry {
                    label: entry.label.clone(),
                    document: store.document.clone(),
                };
                store.redo.push(current);
                store.document = entry.document;
                store.document.revision = current_revision + 1;
                let output = HistoryOutput {
                    revision: store.document.revision,
                    action: entry.label,
                    can_undo: !store.undo.is_empty(),
                    can_redo: !store.redo.is_empty(),
                };
                drop(store);
                let _ = events.send(output.revision);
                Ok(OperationSuccess::new(output)
                    .summary("Undid editor action")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    register::<EmptyInput, HistoryOutput, _, _>(
        registry,
        "history.redo",
        "Redo editor action",
        "Redoes the last undone editor operation.",
        "history",
        AccessLevel::Write,
        false,
        false,
        &["redo", "history"],
        move |context, _| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if context.dry_run {
                    return Err(CapabilityError::InvalidInput(
                        "history.redo does not support dry-run".into(),
                    ));
                }
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let entry = store
                    .redo
                    .pop()
                    .ok_or_else(|| CapabilityError::Unavailable("nothing to redo".into()))?;
                let current_revision = store.document.revision;
                let current = HistoryEntry {
                    label: entry.label.clone(),
                    document: store.document.clone(),
                };
                store.undo.push(current);
                store.document = entry.document;
                store.document.revision = current_revision + 1;
                let output = HistoryOutput {
                    revision: store.document.revision,
                    action: entry.label,
                    can_undo: !store.undo.is_empty(),
                    can_redo: !store.redo.is_empty(),
                };
                drop(store);
                let _ = events.send(output.revision);
                Ok(OperationSuccess::new(output)
                    .summary("Redid editor action")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

const JOBS_RESOURCE: &str = "opencut://jobs";

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobStartInput {
    capability_id: String,
    #[serde(default = "empty_object")]
    input: Value,
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobIdInput {
    job_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobListInput {
    status: Option<JobStatus>,
    #[serde(default = "default_job_limit")]
    limit: usize,
}

fn default_job_limit() -> usize {
    100
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct JobListOutput {
    jobs: Vec<JobRecord>,
}

fn register_job_operations(
    registry: &CapabilityRegistry,
    jobs: JobManager,
) -> Result<(), RegistryError> {
    let start_registry = registry.clone();
    let start_jobs = jobs.clone();
    register::<JobStartInput, JobRecord, _, _>(
        registry,
        "job.start",
        "Start background job",
        "Runs a cancellable OpenCut capability asynchronously and returns a durable job record immediately.",
        "job",
        AccessLevel::Destructive,
        false,
        true,
        &["job", "async", "render", "analysis", "progress"],
        move |context, input| {
            let registry = start_registry.clone();
            let jobs = start_jobs.clone();
            async move {
                if input.capability_id.starts_with("job.") {
                    return Err(CapabilityError::InvalidInput(
                        "job capabilities cannot recursively start jobs".into(),
                    ));
                }
                let descriptor = registry
                    .descriptor(&input.capability_id)
                    .map_err(|error| CapabilityError::Failed(error.to_string()))?
                    .ok_or_else(|| {
                        CapabilityError::Unavailable(format!(
                            "capability `{}` was not found",
                            input.capability_id
                        ))
                    })?;
                if !descriptor.cancellable && !descriptor.open_world {
                    return Err(CapabilityError::InvalidInput(format!(
                        "capability `{}` is short-running; invoke it directly",
                        input.capability_id
                    )));
                }
                let (record, cancellation) = jobs
                    .create(&input.capability_id, context.actor.clone())
                    .map_err(CapabilityError::Failed)?;
                let job_id = record.id.clone();
                let capability_id = input.capability_id;
                let capability_input = input.input;
                let registry_for_task = registry.clone();
                let jobs_for_task = jobs.clone();
                tokio::spawn(async move {
                    jobs_for_task.mark_running(&job_id);
                    let _ = registry_for_task.notify_resources_changed(vec![JOBS_RESOURCE.into()]);
                    let mut job_context = context;
                    job_context.source = "job".into();
                    job_context.request_id = Some(job_id.clone());
                    job_context.cancellation = cancellation.clone();
                    match registry_for_task
                        .invoke(&capability_id, job_context, capability_input)
                        .await
                    {
                        Ok(receipt) if cancellation.is_cancelled() => {
                            jobs_for_task.mark_cancelled(&job_id);
                            if !receipt.result.artifacts.is_empty() {
                                jobs_for_task.succeed(&job_id, receipt);
                            }
                        }
                        Ok(receipt) => jobs_for_task.succeed(&job_id, receipt),
                        Err(_error) if cancellation.is_cancelled() => {
                            jobs_for_task.mark_cancelled(&job_id)
                        }
                        Err(error) => jobs_for_task.fail(&job_id, error.to_string()),
                    }
                    let _ = registry_for_task.notify_resources_changed(vec![JOBS_RESOURCE.into()]);
                });
                Ok(OperationSuccess::new(record)
                    .summary("Started background job")
                    .changed([JOBS_RESOURCE]))
            }
        },
    )?;

    let read_jobs = jobs.clone();
    register::<JobIdInput, JobRecord, _, _>(
        registry,
        "job.read",
        "Read background job",
        "Returns current status, result receipt, errors, and artifacts for one background job.",
        "job",
        AccessLevel::Read,
        true,
        false,
        &["job", "status", "progress", "result"],
        move |_, input| {
            let jobs = read_jobs.clone();
            async move {
                let record = jobs.get(&input.job_id).ok_or_else(|| {
                    CapabilityError::Unavailable(format!("job `{}` was not found", input.job_id))
                })?;
                Ok(OperationSuccess::new(record))
            }
        },
    )?;

    let list_jobs = jobs.clone();
    register::<JobListInput, JobListOutput, _, _>(
        registry,
        "job.list",
        "List background jobs",
        "Lists recent background work filtered by status.",
        "job",
        AccessLevel::Read,
        true,
        false,
        &["job", "status", "progress", "history"],
        move |_, input| {
            let jobs = list_jobs.clone();
            async move {
                Ok(OperationSuccess::new(JobListOutput {
                    jobs: jobs.list(input.status, input.limit),
                }))
            }
        },
    )?;

    register::<JobIdInput, JobRecord, _, _>(
        registry,
        "job.cancel",
        "Cancel background job",
        "Requests cancellation of queued or running background work.",
        "job",
        AccessLevel::Write,
        true,
        false,
        &["job", "cancel", "stop"],
        move |_, input| {
            let jobs = jobs.clone();
            async move {
                let record = jobs
                    .cancel(&input.job_id)
                    .map_err(CapabilityError::Unavailable)?;
                Ok(OperationSuccess::new(record)
                    .summary("Cancelled background job")
                    .changed([JOBS_RESOURCE]))
            }
        },
    )
}

#[derive(Clone, Copy)]
enum EntityKind {
    Transition,
    Marker,
}

#[allow(clippy::too_many_arguments)]
fn register_patch_and_delete(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    kind: EntityKind,
    update_id: &'static str,
    update_title: &'static str,
    delete_id: &'static str,
    delete_title: &'static str,
) -> Result<(), RegistryError> {
    let update_state = state.clone();
    let update_events = events.clone();
    register::<EntityPatchInput, MutationOutput, _, _>(
        registry,
        update_id,
        update_title,
        "Applies a validated JSON Merge Patch to the timeline entity.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["timeline", "update"],
        move |context, input| {
            let state = update_state.clone();
            let events = update_events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    update_title,
                    input.expected_revision,
                    |document| {
                        match kind {
                            EntityKind::Transition => {
                                let entity = project_mut(document)?
                                    .timeline
                                    .transitions
                                    .iter_mut()
                                    .find(|entity| entity.id == id)
                                    .ok_or_else(|| unknown("transition", &id))?;
                                merge_typed(entity, input.patch)?;
                            }
                            EntityKind::Marker => {
                                let entity = project_mut(document)?
                                    .timeline
                                    .markers
                                    .iter_mut()
                                    .find(|entity| entity.id == id)
                                    .ok_or_else(|| unknown("marker", &id))?;
                                merge_typed(entity, input.patch)?;
                            }
                        }
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary(update_title)
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;

    register::<EntityRemoveInput, MutationOutput, _, _>(
        registry,
        delete_id,
        delete_title,
        "Deletes the timeline entity. The operation can be undone.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["timeline", "delete"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let id = input.id;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    delete_title,
                    input.expected_revision,
                    |document| {
                        let timeline = &mut project_mut(document)?.timeline;
                        let found = match kind {
                            EntityKind::Transition => {
                                let before = timeline.transitions.len();
                                timeline.transitions.retain(|entity| entity.id != id);
                                before != timeline.transitions.len()
                            }
                            EntityKind::Marker => {
                                let before = timeline.markers.len();
                                timeline.markers.retain(|entity| entity.id != id);
                                before != timeline.markers.len()
                            }
                        };
                        if !found {
                            return Err(unknown("timeline entity", &id));
                        }
                        Ok(vec![id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary(delete_title)
                    .changed([STATE_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn mutate<F>(
    state: &Arc<RwLock<EditorStore>>,
    events: &broadcast::Sender<u64>,
    context: &InvocationContext,
    label: &str,
    expected_revision: Option<u64>,
    mutation: F,
) -> Result<MutationOutput, CapabilityError>
where
    F: FnOnce(&mut EditorDocument) -> Result<Vec<String>, CapabilityError>,
{
    if context.cancellation.is_cancelled() {
        return Err(CapabilityError::Failed("operation was cancelled".into()));
    }
    let mut store = state
        .write()
        .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?;
    if let Some(target) = requested_project_id(context)
        && store.active_project_id() != Some(target)
    {
        return Err(CapabilityError::Conflict(format!(
            "project target conflict: requested `{target}`, active project is `{}`",
            store.active_project_id().unwrap_or("<none>")
        )));
    }
    let expected_revision = expected_revision.or_else(|| {
        context
            .metadata
            .get("opencut/expectedRevision")
            .and_then(Value::as_u64)
    });
    if let Some(expected) = expected_revision
        && expected != store.document.revision
    {
        return Err(CapabilityError::Conflict(format!(
            "revision conflict: expected {expected}, current revision is {}",
            store.document.revision
        )));
    }
    let before = store.document.clone();
    let mut working = before.clone();
    let changed_ids = mutation(&mut working)?;
    working
        .sync_exact_from_seconds()
        .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
    working
        .validate()
        .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
    let previous_revision = before.revision;
    let project_id = working.project.as_ref().map(|project| project.id.clone());
    let next_revision = previous_revision + 1;
    working.revision = next_revision;
    if context.dry_run {
        return Ok(MutationOutput {
            project_id,
            previous_revision,
            revision: next_revision,
            committed: false,
            undo_entry: None,
            warnings: Vec::new(),
            changed_ids,
        });
    }
    let project_identity_changed = before.project.as_ref().map(|project| &project.id)
        != working.project.as_ref().map(|project| &project.id);
    if project_identity_changed && working.project.is_some() {
        store.begin_new_active(working, false);
        drop(store);
        let _ = events.send(next_revision);
        return Ok(MutationOutput {
            project_id,
            previous_revision,
            revision: next_revision,
            committed: true,
            undo_entry: None,
            warnings: Vec::new(),
            changed_ids,
        });
    }
    let in_transaction = context
        .metadata
        .get("opencut/transaction")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !in_transaction {
        store.undo.push(HistoryEntry {
            label: label.into(),
            document: before,
        });
        store.redo.clear();
    }
    store.document = working;
    if !in_transaction {
        trim_history(&mut store.undo);
    }
    drop(store);
    if !in_transaction {
        let _ = events.send(next_revision);
    }
    Ok(MutationOutput {
        project_id,
        previous_revision,
        revision: next_revision,
        committed: true,
        undo_entry: (!in_transaction).then(|| label.to_owned()),
        warnings: Vec::new(),
        changed_ids,
    })
}

fn requested_project_id(context: &InvocationContext) -> Option<&str> {
    context
        .metadata
        .get("opencut/projectId")
        .and_then(Value::as_str)
}

fn check_revision(
    document: &EditorDocument,
    expected_revision: Option<u64>,
) -> Result<(), CapabilityError> {
    if let Some(expected) = expected_revision
        && expected != document.revision
    {
        return Err(CapabilityError::Conflict(format!(
            "revision conflict: expected {expected}, current revision is {}",
            document.revision
        )));
    }
    Ok(())
}

fn check_target(
    document: &EditorDocument,
    context: &InvocationContext,
) -> Result<(), CapabilityError> {
    let Some(target) = requested_project_id(context) else {
        return Ok(());
    };
    let active = document.project.as_ref().map(|project| project.id.as_str());
    if active != Some(target) {
        return Err(CapabilityError::Conflict(format!(
            "project target conflict: requested `{target}`, active project is `{}`",
            active.unwrap_or("<none>")
        )));
    }
    Ok(())
}

pub(crate) fn trim_history(history: &mut Vec<HistoryEntry>) {
    const MAX_HISTORY: usize = 200;
    if history.len() > MAX_HISTORY {
        history.drain(..history.len() - MAX_HISTORY);
    }
}

fn merge_typed<T>(target: &mut T, patch: Value) -> Result<(), CapabilityError>
where
    T: Serialize + DeserializeOwned,
{
    let mut serialized = serde_json::to_value(&*target)
        .map_err(|error| CapabilityError::Failed(error.to_string()))?;
    json_patch::merge(&mut serialized, &patch);
    *target = serde_json::from_value(serialized)
        .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
    Ok(())
}

fn project_mut(document: &mut EditorDocument) -> Result<&mut Project, CapabilityError> {
    document
        .project
        .as_mut()
        .ok_or_else(|| CapabilityError::Unavailable("no project is open".into()))
}

fn find_track_mut<'a>(
    document: &'a mut EditorDocument,
    id: &str,
) -> Result<&'a mut Track, CapabilityError> {
    project_mut(document)?
        .timeline
        .tracks
        .iter_mut()
        .find(|track| track.id == id)
        .ok_or_else(|| unknown("track", id))
}

fn find_item_location(
    document: &mut EditorDocument,
    id: &str,
) -> Result<(usize, usize), CapabilityError> {
    for (track_index, track) in project_mut(document)?.timeline.tracks.iter().enumerate() {
        if let Some(item_index) = track.items.iter().position(|item| item.id == id) {
            return Ok((track_index, item_index));
        }
    }
    Err(unknown("timeline item", id))
}

fn find_editable_item_mut<'a>(
    document: &'a mut EditorDocument,
    id: &str,
) -> Result<&'a mut TimelineItem, CapabilityError> {
    for track in &mut project_mut(document)?.timeline.tracks {
        if let Some(item_index) = track.items.iter().position(|item| item.id == id) {
            if track.locked {
                return Err(CapabilityError::Denied(format!(
                    "track `{}` is locked",
                    track.id
                )));
            }
            let item = &mut track.items[item_index];
            if item.locked {
                return Err(CapabilityError::Denied(format!(
                    "timeline item `{}` is locked",
                    item.id
                )));
            }
            return Ok(item);
        }
    }
    Err(unknown("timeline item", id))
}

fn find_effect_mut<'a>(
    document: &'a mut EditorDocument,
    id: &str,
) -> Result<&'a mut Effect, CapabilityError> {
    for track in &mut project_mut(document)?.timeline.tracks {
        for item in &mut track.items {
            if let Some(effect) = item.effects.iter_mut().find(|effect| effect.id == id) {
                return Ok(effect);
            }
        }
    }
    Err(unknown("effect", id))
}

fn ensure_unlocked(track: &Track, item: Option<&TimelineItem>) -> Result<(), CapabilityError> {
    if track.locked {
        return Err(CapabilityError::Denied(format!(
            "track `{}` is locked",
            track.id
        )));
    }
    if let Some(item) = item
        && item.locked
    {
        return Err(CapabilityError::Denied(format!(
            "timeline item `{}` is locked",
            item.id
        )));
    }
    Ok(())
}

fn new_track(id: String, name: &str, kind: TrackKind) -> Track {
    Track {
        id,
        name: name.into(),
        kind,
        items: Vec::new(),
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        hidden: false,
        height: 64.0,
        metadata: Default::default(),
        extensions: Map::new(),
    }
}

fn default_export_presets() -> Vec<ExportPreset> {
    vec![ExportPreset {
        id: "default-h264".into(),
        name: "H.264 MP4".into(),
        container: "mp4".into(),
        video_codec: "h264".into(),
        audio_codec: "aac".into(),
        width: None,
        height: None,
        frame_rate: None,
        video_bitrate: None,
        audio_bitrate: Some(192_000),
        options: Map::new(),
    }]
}

fn next_id_for_project(project: &Project) -> u64 {
    std::iter::once(project.id.as_str())
        .chain(project.assets.iter().map(|asset| asset.id.as_str()))
        .chain(
            project
                .export_presets
                .iter()
                .map(|preset| preset.id.as_str()),
        )
        .chain(
            project
                .timeline
                .tracks
                .iter()
                .map(|track| track.id.as_str()),
        )
        .chain(
            project
                .timeline
                .tracks
                .iter()
                .flat_map(|track| track.items.iter().map(|item| item.id.as_str())),
        )
        .chain(
            project
                .timeline
                .tracks
                .iter()
                .flat_map(|track| &track.items)
                .flat_map(|item| item.effects.iter().map(|effect| effect.id.as_str())),
        )
        .chain(
            project
                .timeline
                .tracks
                .iter()
                .flat_map(|track| &track.items)
                .flat_map(|item| item.keyframes.iter().map(|keyframe| keyframe.id.as_str())),
        )
        .chain(
            project
                .timeline
                .transitions
                .iter()
                .map(|transition| transition.id.as_str()),
        )
        .chain(
            project
                .timeline
                .markers
                .iter()
                .map(|marker| marker.id.as_str()),
        )
        .filter_map(|id| id.rsplit_once('-')?.1.parse::<u64>().ok())
        .max()
        .unwrap_or_default()
        + 1
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use serde_json::{Map, Value, json};

    use crate::{
        AccessLevel, CapabilityError, EditorDocument, InvocationContext, OpenCutRuntime, Project,
        ProjectSettings, RegistryError, Timeline, TrackKind,
    };

    async fn invoke(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
        runtime
            .registry()
            .invoke(
                id,
                InvocationContext {
                    source: "test".into(),
                    ..InvocationContext::default()
                },
                input,
            )
            .await
            .unwrap_or_else(|error| panic!("{id} failed: {error}"))
            .result
            .data
    }

    async fn invoke_error(runtime: &OpenCutRuntime, id: &str, input: Value) -> CapabilityError {
        let error = runtime
            .registry()
            .invoke(
                id,
                InvocationContext {
                    source: "test".into(),
                    ..InvocationContext::default()
                },
                input,
            )
            .await
            .expect_err("capability should reject the input");
        match error {
            RegistryError::Capability(error) => error,
            other => panic!("unexpected registry error: {other}"),
        }
    }

    struct SpeakerFrameFixture {
        runtime: OpenCutRuntime,
        project_id: String,
        asset_id: String,
        source_item_id: String,
        smart_item_id: String,
    }

    async fn speaker_frame_fixture(
        source_duration_seconds: f64,
        layer_duration_seconds: f64,
    ) -> SpeakerFrameFixture {
        let runtime = OpenCutRuntime::default();
        invoke(
            &runtime,
            "project.create",
            json!({"name": "Speaker Frame Breakout fixture"}),
        )
        .await;
        let initial = runtime.snapshot().expect("initial snapshot");
        let project = initial.project.as_ref().expect("project");
        let project_id = project.id.clone();
        let video_track_id = project
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
            .expect("video track")
            .id
            .clone();
        let imported = invoke(
            &runtime,
            "media.import",
            json!({
                "name": "Speaker",
                "source": "C:/media/speaker.mp4",
                "mediaType": "video",
                "durationSeconds": 10.0,
                "width": 1920,
                "height": 1080,
                "frameRate": 30.0
            }),
        )
        .await;
        let asset_id = imported["changedIds"][0]
            .as_str()
            .expect("asset id")
            .to_owned();
        let added_video = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": video_track_id,
                "name": "Speaker",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": source_duration_seconds,
                "assetId": asset_id
            }),
        )
        .await;
        let source_item_id = added_video["changedIds"][0]
            .as_str()
            .expect("source item id")
            .to_owned();
        let created = invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.create",
            json!({
                "projectId": project_id,
                "sourceItemId": source_item_id,
                "startSeconds": 0.0,
                "durationSeconds": layer_duration_seconds,
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;
        let smart_item_id = created["changedIds"]
            .as_array()
            .expect("changed ids")
            .last()
            .and_then(Value::as_str)
            .expect("smart item id")
            .to_owned();
        SpeakerFrameFixture {
            runtime,
            project_id,
            asset_id,
            source_item_id,
            smart_item_id,
        }
    }

    fn speaker_frame_apply_payload(
        fixture: &SpeakerFrameFixture,
        inspected: &Value,
        artifact_uri: &str,
        expected_revision: u64,
    ) -> Value {
        json!({
            "projectId": fixture.project_id,
            "itemId": fixture.smart_item_id,
            "configurationRevision": inspected["configurationRevision"],
            "settingsSignature": inspected["settingsSignature"],
            "sourceSignature": inspected["sourceSignature"],
            "preparedArtifactUris": [artifact_uri],
            "processingBackend": "webgpu-modnet",
            "frameRate": {"numerator": 30, "denominator": 1},
            "frameCount": 90,
            "expectedRevision": expected_revision
        })
    }

    #[tokio::test]
    async fn project_sessions_are_isolated_and_restorable() {
        let runtime = OpenCutRuntime::default();
        invoke(&runtime, "project.create", json!({"name": "First"})).await;
        let first_id = runtime.snapshot().unwrap().project.unwrap().id;
        invoke(&runtime, "project.create", json!({"name": "Second"})).await;
        let second_id = runtime.snapshot().unwrap().project.unwrap().id;
        assert_ne!(first_id, second_id);
        assert_eq!(runtime.sessions().unwrap().len(), 2);

        invoke(&runtime, "project.activate", json!({"projectId": first_id})).await;
        assert_eq!(runtime.snapshot().unwrap().project.unwrap().name, "First");

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        runtime.save_application_state(&path).unwrap();
        let restored = OpenCutRuntime::default();
        assert!(restored.restore_application_state(&path).unwrap());
        assert_eq!(restored.sessions().unwrap().len(), 2);
        assert_eq!(restored.snapshot().unwrap().project.unwrap().name, "First");
    }

    #[tokio::test]
    async fn idempotency_keys_return_the_original_receipt() {
        let runtime = OpenCutRuntime::default();
        let context = InvocationContext {
            source: "test".into(),
            actor: Some("agent".into()),
            metadata: Map::from_iter([(
                "opencut/idempotencyKey".into(),
                Value::String("create-once".into()),
            )]),
            ..Default::default()
        };
        let first = runtime
            .registry()
            .invoke(
                "project.create",
                context.clone(),
                json!({"name": "Only once"}),
            )
            .await
            .unwrap();
        let second = runtime
            .registry()
            .invoke("project.create", context, json!({"name": "Only once"}))
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(runtime.sessions().unwrap().len(), 1);
    }

    #[test]
    fn schema_v2_exact_time_is_preserved_when_smart_layers_bump_the_schema() {
        let time_base = crate::Rational::new(1, 1_000);
        let exact_position = crate::MediaTime::from_seconds(1.001, time_base);
        let exact_frame_rate = crate::Rational::new(30_000, 1_001);
        let mut document = EditorDocument {
            schema_version: 2,
            project: Some(Project {
                id: "project-1".into(),
                name: "Exact timing".into(),
                file_path: None,
                settings: ProjectSettings {
                    frame_rate: 29.97,
                    frame_rate_rational: exact_frame_rate,
                    time_base,
                    ..Default::default()
                },
                assets: Vec::new(),
                timeline: Timeline::default(),
                metadata: Default::default(),
                export_presets: Vec::new(),
                extensions: Map::new(),
            }),
            ..Default::default()
        };
        document.playback.position_seconds = 99.0;
        document.playback.position = Some(exact_position);
        assert!(document.migrate_to_current().unwrap());
        assert_eq!(document.schema_version, crate::CURRENT_SCHEMA_VERSION);
        assert_eq!(
            document
                .project
                .as_ref()
                .expect("project")
                .settings
                .frame_rate_rational,
            exact_frame_rate
        );
        assert_eq!(
            document.playback.position_seconds,
            exact_position.as_seconds()
        );
    }

    #[test]
    fn schema_v1_time_migrates_to_exact_ticks() {
        let mut document = EditorDocument {
            schema_version: 1,
            project: Some(Project {
                id: "project-1".into(),
                name: "Timing".into(),
                file_path: None,
                settings: ProjectSettings {
                    frame_rate: 29.97,
                    ..Default::default()
                },
                assets: Vec::new(),
                timeline: Timeline::default(),
                metadata: Default::default(),
                export_presets: Vec::new(),
                extensions: Map::new(),
            }),
            ..Default::default()
        };
        document.playback.position_seconds = 1.001;
        assert!(document.migrate_to_current().unwrap());
        assert_eq!(document.schema_version, crate::CURRENT_SCHEMA_VERSION);
        assert_eq!(
            document.playback.position.unwrap().as_seconds(),
            document.playback.position_seconds
        );
        assert_eq!(
            document.project.unwrap().settings.frame_rate_rational,
            crate::Rational::new(2997, 100)
        );
    }

    #[tokio::test]
    async fn complete_editing_flow_is_visible_and_undoable() {
        let runtime = OpenCutRuntime::default();
        invoke(&runtime, "project.create", json!({"name": "Agent edit"})).await;

        let snapshot = runtime.snapshot().expect("snapshot");
        let project = snapshot.project.as_ref().expect("project");
        let video_track = project
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
            .expect("video track")
            .id
            .clone();
        let text_track = project
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Text)
            .expect("text track")
            .id
            .clone();

        let imported = invoke(
            &runtime,
            "media.import",
            json!({
                "name": "Source",
                "source": "C:/media/source.mp4",
                "mediaType": "video",
                "durationSeconds": 12.0,
                "width": 1920,
                "height": 1080,
                "frameRate": 30.0
            }),
        )
        .await;
        let asset_id = imported["changedIds"][0].as_str().expect("asset id");

        let added_video = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": video_track,
                "name": "Source",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": 8.0,
                "assetId": asset_id
            }),
        )
        .await;
        let video_item_id = added_video["changedIds"][0]
            .as_str()
            .expect("video item id")
            .to_owned();

        let added_text = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": text_track,
                "name": "Title",
                "kind": "text",
                "startSeconds": 1.0,
                "durationSeconds": 4.0
            }),
        )
        .await;
        let text_item_id = added_text["changedIds"][0]
            .as_str()
            .expect("text item id")
            .to_owned();

        invoke(
            &runtime,
            "timeline.text.update",
            json!({
                "itemId": text_item_id,
                "patch": {
                    "content": "Edited by the agent",
                    "fontSize": 92.0,
                    "color": "#ffcc00"
                }
            }),
        )
        .await;
        invoke(
            &runtime,
            "timeline.effect.add",
            json!({
                "itemId": video_item_id,
                "effectType": "color",
                "name": "Contrast",
                "parameters": {"contrast": 1.15}
            }),
        )
        .await;
        invoke(
            &runtime,
            "timeline.keyframe.set",
            json!({
                "itemId": video_item_id,
                "property": "transform.scaleX",
                "timeSeconds": 0.0,
                "value": 1.0,
                "interpolation": "linear"
            }),
        )
        .await;
        invoke(
            &runtime,
            "playback.update",
            json!({"patch": {"positionSeconds": 2.5, "playing": false}}),
        )
        .await;
        invoke(
            &runtime,
            "selection.set",
            json!({
                "selection": {
                    "assetIds": [],
                    "trackIds": [],
                    "itemIds": [text_item_id],
                    "effectIds": []
                }
            }),
        )
        .await;

        let snapshot = runtime.snapshot().expect("snapshot");
        let project = snapshot.project.as_ref().expect("project");
        let text_item = project
            .timeline
            .tracks
            .iter()
            .flat_map(|track| &track.items)
            .find(|item| item.id == text_item_id)
            .expect("text item");
        assert_eq!(
            text_item.text.as_ref().expect("text").content,
            "Edited by the agent"
        );
        let video_item = project
            .timeline
            .tracks
            .iter()
            .flat_map(|track| &track.items)
            .find(|item| item.id == video_item_id)
            .expect("video item");
        assert_eq!(video_item.effects.len(), 1);
        assert_eq!(video_item.keyframes.len(), 1);
        assert_eq!(snapshot.playback.position_seconds, 2.5);
        assert!(snapshot.selection.item_ids.contains(&text_item_id));

        invoke(&runtime, "history.undo", json!({})).await;
        assert!(
            runtime
                .snapshot()
                .expect("snapshot")
                .selection
                .item_ids
                .is_empty()
        );
        invoke(&runtime, "history.redo", json!({})).await;
        assert!(
            runtime
                .snapshot()
                .expect("snapshot")
                .selection
                .item_ids
                .contains(&text_item_id)
        );
    }

    #[tokio::test]
    async fn speaker_frame_breakout_is_typed_visible_manual_and_undoable() {
        let runtime = OpenCutRuntime::default();
        invoke(
            &runtime,
            "project.create",
            json!({"name": "Smart layer contract"}),
        )
        .await;
        let initial = runtime.snapshot().expect("initial snapshot");
        let project = initial.project.as_ref().expect("project");
        let project_id = project.id.clone();
        let video_track_id = project
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
            .expect("video track")
            .id
            .clone();
        let imported = invoke(
            &runtime,
            "media.import",
            json!({
                "name": "Speaker",
                "source": "C:/media/speaker.mp4",
                "mediaType": "video",
                "durationSeconds": 8.0,
                "width": 1920,
                "height": 1080,
                "frameRate": 30.0
            }),
        )
        .await;
        let asset_id = imported["changedIds"][0]
            .as_str()
            .expect("asset id")
            .to_owned();
        let added_video = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": video_track_id,
                "name": "Speaker",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": 8.0,
                "assetId": asset_id
            }),
        )
        .await;
        let source_item_id = added_video["changedIds"][0]
            .as_str()
            .expect("video item id")
            .to_owned();

        let create_revision = runtime.snapshot().expect("snapshot").revision;
        let created = invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.create",
            json!({
                "projectId": project_id,
                "sourceItemId": source_item_id,
                "startSeconds": 1.0,
                "durationSeconds": 3.0,
                "expectedRevision": create_revision
            }),
        )
        .await;
        let smart_item_id = created["changedIds"]
            .as_array()
            .expect("changed ids")
            .last()
            .and_then(Value::as_str)
            .expect("smart item id")
            .to_owned();

        let read_after_create = invoke(
            &runtime,
            "app.state.read",
            json!({"projectId": project_id, "pointer": ""}),
        )
        .await;
        let created_item = read_after_create["value"]["project"]["timeline"]["tracks"]
            .as_array()
            .expect("tracks")
            .iter()
            .flat_map(|track| track["items"].as_array().expect("track items").iter())
            .find(|item| item["id"] == smart_item_id)
            .expect("smart layer visible through app.state.read");
        assert_eq!(created_item["kind"], "smartLayer");
        assert_eq!(
            created_item["smartLayer"]["layerType"],
            "speakerFrameBreakout"
        );
        assert_eq!(
            created_item["smartLayer"]["speakerFrameBreakout"]["background"]["backgroundId"],
            "paper-grid"
        );
        assert_eq!(
            created_item["smartLayer"]["application"]["configurationRevision"],
            1
        );
        assert!(
            created_item["smartLayer"]["application"]["appliedSnapshot"].is_null(),
            "dropping the smart layer must not start or fake background removal"
        );

        let update_descriptor = runtime
            .registry()
            .descriptor("timeline.smart_layer.speaker_frame_breakout.update")
            .expect("registry")
            .expect("update descriptor");
        assert_eq!(update_descriptor.access, AccessLevel::Write);
        assert!(update_descriptor.transactional);
        assert!(update_descriptor.supports_dry_run);
        let apply_descriptor = runtime
            .registry()
            .descriptor("timeline.smart_layer.speaker_frame_breakout.apply")
            .expect("registry")
            .expect("apply descriptor");
        assert!(apply_descriptor.cancellable);

        let revision_before_dry_run = runtime.snapshot().expect("snapshot").revision;
        let dry_run = runtime
            .registry()
            .invoke(
                "timeline.smart_layer.speaker_frame_breakout.update",
                InvocationContext {
                    source: "test".into(),
                    dry_run: true,
                    ..InvocationContext::default()
                },
                json!({
                    "projectId": project_id,
                    "itemId": smart_item_id,
                    "patch": {
                        "background": {
                            "backgroundId": "dry-run-only",
                            "definitionId": "preset-background",
                            "parameters": {}
                        }
                    },
                    "expectedRevision": revision_before_dry_run
                }),
            )
            .await
            .expect("dry-run update");
        assert_eq!(dry_run.result.data["committed"], false);
        assert_eq!(
            runtime.snapshot().expect("snapshot").revision,
            revision_before_dry_run
        );

        let updated = invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.update",
            json!({
                "projectId": project_id,
                "itemId": smart_item_id,
                "patch": {
                    "background": {
                        "backgroundId": "soft-waves",
                        "definitionId": "preset-background",
                        "parameters": {
                            "preset": "waves",
                            "colorA": "#ffffff",
                            "colorB": "#e5e7eb"
                        }
                    },
                    "layout": {
                        "speakerScale": 0.72,
                        "positionX": 0.5,
                        "positionY": 0.7,
                        "cropTop": 0.2,
                        "cornerRadius": 0.1
                    },
                    "fade": {
                        "inSeconds": 0.4,
                        "outSeconds": 0.4
                    },
                    "backgroundRemoval": {
                        "quality": "precise",
                        "maskThreshold": 0.58,
                        "edgeFeather": 0.1,
                        "refineEdges": true
                    }
                },
                "expectedRevision": revision_before_dry_run
            }),
        )
        .await;
        assert_eq!(updated["committed"], true);

        let inspected = invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.inspect",
            json!({"projectId": project_id, "itemId": smart_item_id}),
        )
        .await;
        assert_eq!(inspected["applicationStatus"], "draft");
        assert_eq!(inspected["configurationRevision"], 2);
        assert_eq!(inspected["sourceItems"][0]["itemId"], source_item_id);
        let artifact = runtime
            .artifacts()
            .put(
                vec![1, 3, 3, 7],
                "application/vnd.opencut.background-mask-cache",
                None,
                None,
                Some(3_000),
            )
            .expect("bounded mask artifact");
        let apply_revision = runtime.snapshot().expect("snapshot").revision;
        invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            json!({
                "projectId": project_id,
                "itemId": smart_item_id,
                "configurationRevision": inspected["configurationRevision"],
                "settingsSignature": inspected["settingsSignature"],
                "sourceSignature": inspected["sourceSignature"],
                "preparedArtifactUris": [artifact.uri],
                "processingBackend": "webgpu-modnet",
                "frameRate": {"numerator": 30, "denominator": 1},
                "frameCount": 90,
                "expectedRevision": apply_revision
            }),
        )
        .await;

        let read_after_apply = invoke(
            &runtime,
            "app.state.read",
            json!({"projectId": project_id, "pointer": ""}),
        )
        .await;
        let applied_item = read_after_apply["value"]["project"]["timeline"]["tracks"]
            .as_array()
            .expect("tracks")
            .iter()
            .flat_map(|track| track["items"].as_array().expect("track items").iter())
            .find(|item| item["id"] == smart_item_id)
            .expect("applied smart layer");
        let applied = &applied_item["smartLayer"]["application"]["appliedSnapshot"];
        assert_eq!(applied["configurationRevision"], 2);
        assert_eq!(applied["processingBackend"], "webgpu-modnet");
        assert_eq!(applied["frameCount"], 90);
        assert_eq!(applied["artifacts"][0]["uri"], artifact.uri);

        invoke(&runtime, "history.undo", json!({})).await;
        let after_undo = invoke(
            &runtime,
            "timeline.smart_layer.speaker_frame_breakout.inspect",
            json!({"projectId": project_id, "itemId": smart_item_id}),
        )
        .await;
        assert_eq!(after_undo["applicationStatus"], "draft");
        assert!(after_undo["appliedSnapshot"].is_null());
    }

    #[tokio::test]
    async fn speaker_frame_sources_follow_nearest_visible_track_per_frame_across_cuts() {
        let fixture = speaker_frame_fixture(3.0, 3.0).await;
        let added_track = invoke(
            &fixture.runtime,
            "timeline.track.add",
            json!({"name": "Near cut track", "kind": "video", "index": 1}),
        )
        .await;
        let near_track_id = added_track["changedIds"][0]
            .as_str()
            .expect("near track id")
            .to_owned();
        let added_near = invoke(
            &fixture.runtime,
            "timeline.item.add",
            json!({
                "trackId": near_track_id,
                "name": "Near cut",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": 1.0,
                "assetId": fixture.asset_id
            }),
        )
        .await;
        let near_item_id = added_near["changedIds"][0]
            .as_str()
            .expect("near item id")
            .to_owned();

        let snapshot = fixture.runtime.snapshot().expect("snapshot");
        let sources = super::resolve_speaker_frame_sources(&snapshot, &fixture.smart_item_id)
            .expect("sources");
        assert_eq!(
            sources
                .iter()
                .map(|source| source.item_id.as_str())
                .collect::<Vec<_>>(),
            vec![near_item_id.as_str(), fixture.source_item_id.as_str()]
        );
        assert_eq!(
            super::speaker_frame_source_at_time(&sources, 0.5)
                .expect("nearest source")
                .item_id,
            near_item_id
        );
        assert_eq!(
            super::speaker_frame_source_at_time(&sources, 1.5)
                .expect("fallthrough source")
                .item_id,
            fixture.source_item_id
        );

        let mut hidden_source_snapshot = snapshot.clone();
        hidden_source_snapshot
            .project
            .as_mut()
            .expect("project")
            .timeline
            .tracks
            .iter_mut()
            .find(|track| track.id == near_track_id)
            .expect("near track")
            .hidden = true;
        let visible_sources =
            super::resolve_speaker_frame_sources(&hidden_source_snapshot, &fixture.smart_item_id)
                .expect("visible sources");
        assert_eq!(visible_sources.len(), 1);
        assert_eq!(visible_sources[0].item_id, fixture.source_item_id);

        for disable_track in [false, true] {
            let mut inactive_smart_snapshot = snapshot.clone();
            let smart_track = inactive_smart_snapshot
                .project
                .as_mut()
                .expect("project")
                .timeline
                .tracks
                .iter_mut()
                .find(|track| {
                    track
                        .items
                        .iter()
                        .any(|item| item.id == fixture.smart_item_id)
                })
                .expect("smart track");
            if disable_track {
                smart_track.enabled = false;
            } else {
                smart_track.hidden = true;
            }
            let error = super::speaker_frame_breakout_item(
                &inactive_smart_snapshot,
                &fixture.smart_item_id,
            )
            .expect_err("inactive smart track must be rejected");
            assert!(
                matches!(error, CapabilityError::Unavailable(message) if message.contains("hidden or disabled"))
            );
        }
    }

    #[tokio::test]
    async fn speaker_frame_apply_rejects_stale_state_and_untrusted_artifacts() {
        let fixture = speaker_frame_fixture(3.0, 3.0).await;
        let inspected = invoke(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.inspect",
            json!({
                "projectId": fixture.project_id,
                "itemId": fixture.smart_item_id
            }),
        )
        .await;
        let artifact = fixture
            .runtime
            .artifacts()
            .put(
                vec![1, 2, 3, 4],
                crate::SMART_LAYER_MASK_ARTIFACT_MIME_TYPE,
                None,
                None,
                Some(3_000),
            )
            .expect("valid mask artifact");
        let revision = fixture.runtime.snapshot().expect("snapshot").revision;

        let stale_document_revision = speaker_frame_apply_payload(
            &fixture,
            &inspected,
            &artifact.uri,
            revision.saturating_sub(1),
        );
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            stale_document_revision,
        )
        .await;
        assert!(
            matches!(error, CapabilityError::Conflict(message) if message.contains("revision conflict"))
        );

        let mut stale_configuration =
            speaker_frame_apply_payload(&fixture, &inspected, &artifact.uri, revision);
        stale_configuration["configurationRevision"] = json!(999);
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            stale_configuration,
        )
        .await;
        assert!(
            matches!(error, CapabilityError::Conflict(message) if message.contains("configuration changed"))
        );

        for signature_field in ["settingsSignature", "sourceSignature"] {
            let mut stale_signature =
                speaker_frame_apply_payload(&fixture, &inspected, &artifact.uri, revision);
            stale_signature[signature_field] = json!("stale-signature");
            let error = invoke_error(
                &fixture.runtime,
                "timeline.smart_layer.speaker_frame_breakout.apply",
                stale_signature,
            )
            .await;
            assert!(
                matches!(error, CapabilityError::Conflict(message) if message.contains("changed after processing began"))
            );
        }

        let missing_artifact_uri = format!(
            "{}/missing",
            crate::ARTIFACT_URI_PREFIX.trim_end_matches('/')
        );
        let missing_artifact =
            speaker_frame_apply_payload(&fixture, &inspected, &missing_artifact_uri, revision);
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            missing_artifact,
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("not found"))
        );

        let noncanonical_uri =
            speaker_frame_apply_payload(&fixture, &inspected, &artifact.id, revision);
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            noncanonical_uri,
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("canonical"))
        );

        let wrong_mime = fixture
            .runtime
            .artifacts()
            .put(vec![5, 6], "image/png", None, None, Some(3_000))
            .expect("wrong MIME artifact");
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            speaker_frame_apply_payload(&fixture, &inspected, &wrong_mime.uri, revision),
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("MIME type"))
        );

        let short_artifact = fixture
            .runtime
            .artifacts()
            .put(
                vec![7, 8],
                crate::SMART_LAYER_MASK_ARTIFACT_MIME_TYPE,
                None,
                None,
                Some(2_999),
            )
            .expect("short mask artifact");
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            speaker_frame_apply_payload(&fixture, &inspected, &short_artifact.uri, revision),
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("cover"))
        );

        let mut wrong_frame_count =
            speaker_frame_apply_payload(&fixture, &inspected, &artifact.uri, revision);
        wrong_frame_count["frameCount"] = json!(89);
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            wrong_frame_count,
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("frameCount"))
        );

        invoke(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            speaker_frame_apply_payload(&fixture, &inspected, &artifact.uri, revision),
        )
        .await;
        assert!(
            fixture
                .runtime
                .artifacts()
                .remove(&artifact.uri)
                .expect("remove artifact")
        );
        let missing_after_apply = invoke(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.inspect",
            json!({
                "projectId": fixture.project_id,
                "itemId": fixture.smart_item_id
            }),
        )
        .await;
        assert_eq!(missing_after_apply["artifactsAvailable"], false);
        assert_eq!(missing_after_apply["applicationStatus"], "stale");
    }

    #[tokio::test]
    async fn speaker_frame_apply_requires_video_source_coverage_for_every_frame() {
        let fixture = speaker_frame_fixture(1.0, 3.0).await;
        let inspected = invoke(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.inspect",
            json!({
                "projectId": fixture.project_id,
                "itemId": fixture.smart_item_id
            }),
        )
        .await;
        let artifact = fixture
            .runtime
            .artifacts()
            .put(
                vec![1, 2, 3],
                crate::SMART_LAYER_MASK_ARTIFACT_MIME_TYPE,
                None,
                None,
                Some(3_000),
            )
            .expect("mask artifact");
        let revision = fixture.runtime.snapshot().expect("snapshot").revision;
        let error = invoke_error(
            &fixture.runtime,
            "timeline.smart_layer.speaker_frame_breakout.apply",
            speaker_frame_apply_payload(&fixture, &inspected, &artifact.uri, revision),
        )
        .await;
        assert!(
            matches!(error, CapabilityError::InvalidInput(message) if message.contains("coverage is missing at frame 30"))
        );
    }

    #[test]
    fn speaker_frame_artifact_checksum_is_recomputed_from_stored_bytes() {
        let bytes = std::sync::Arc::<[u8]>::from(vec![1, 2, 3]);
        let stored = crate::StoredArtifact {
            metadata: crate::ArtifactRef {
                id: "artifact-test".into(),
                uri: format!("{}artifact-test", crate::ARTIFACT_URI_PREFIX),
                mime_type: crate::SMART_LAYER_MASK_ARTIFACT_MIME_TYPE.into(),
                byte_size: bytes.len() as u64,
                sha256: "0".repeat(64),
                created_at_ms: 1,
                expires_at_ms: 2,
                width: None,
                height: None,
                duration_ms: Some(1_000),
            },
            bytes,
        };
        let error = super::validate_speaker_frame_artifact_contents(&stored, &stored.metadata.uri)
            .expect_err("forged checksum must be rejected");
        assert!(error.contains("checksum"));
    }

    #[tokio::test]
    async fn generic_patch_exposes_future_extension_fields_and_supports_dry_run() {
        let runtime = OpenCutRuntime::default();
        let before = runtime.snapshot().expect("snapshot");
        invoke(
            &runtime,
            "app.state.patch",
            json!({
                "patch": [{
                    "op": "add",
                    "path": "/extensions/newFeature",
                    "value": {"enabled": true}
                }],
                "expectedRevision": before.revision
            }),
        )
        .await;
        assert_eq!(
            runtime.snapshot().expect("snapshot").extensions["newFeature"],
            json!({"enabled": true})
        );

        runtime
            .registry()
            .invoke(
                "app.state.patch",
                InvocationContext {
                    source: "test".into(),
                    dry_run: true,
                    ..InvocationContext::default()
                },
                json!({
                    "patch": [{
                        "op": "replace",
                        "path": "/extensions/newFeature/enabled",
                        "value": false
                    }]
                }),
            )
            .await
            .expect("dry run");
        assert_eq!(
            runtime.snapshot().expect("snapshot").extensions["newFeature"],
            json!({"enabled": true})
        );
    }

    #[tokio::test]
    async fn full_document_save_and_open_preserve_state_and_safe_id_allocation() {
        let runtime = OpenCutRuntime::default();
        invoke(&runtime, "project.create", json!({"name": "Persistence"})).await;
        let text_track = runtime
            .snapshot()
            .expect("snapshot")
            .project
            .as_ref()
            .expect("project")
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Text)
            .expect("text track")
            .id
            .clone();
        let item = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": text_track,
                "name": "Saved title",
                "kind": "text",
                "startSeconds": 0.0,
                "durationSeconds": 2.0
            }),
        )
        .await;
        let original_item = item["changedIds"][0].as_str().expect("item id").to_owned();
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(format!("opencut-project-{unique}.opencut"));
        invoke(
            &runtime,
            "project.save",
            json!({"path": path.to_string_lossy()}),
        )
        .await;
        let saved: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("saved document")).expect("json");
        assert!(saved.get("schemaVersion").is_some());
        assert_eq!(saved["project"]["name"], "Persistence");

        let reopened = OpenCutRuntime::default();
        invoke(
            &reopened,
            "project.open",
            json!({"path": path.to_string_lossy()}),
        )
        .await;
        let snapshot = reopened.snapshot().expect("snapshot");
        assert!(
            snapshot
                .project
                .as_ref()
                .expect("project")
                .timeline
                .tracks
                .iter()
                .flat_map(|track| &track.items)
                .any(|item| item.id == original_item)
        );
        let new_item = invoke(
            &reopened,
            "timeline.item.add",
            json!({
                "trackId": text_track,
                "name": "New title",
                "kind": "text",
                "startSeconds": 2.0,
                "durationSeconds": 1.0
            }),
        )
        .await;
        assert_ne!(
            new_item["changedIds"][0].as_str().expect("new item id"),
            original_item
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn unified_angles_are_created_split_switched_and_visible_through_state_read() {
        let runtime = OpenCutRuntime::default();
        invoke(
            &runtime,
            "project.create",
            json!({"name": "Unified Angles"}),
        )
        .await;
        let snapshot = runtime.snapshot().expect("snapshot");
        let project = snapshot.project.as_ref().expect("project");
        let project_id = project.id.clone();
        let video_track_id = project
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
            .expect("video track")
            .id
            .clone();
        let mut source_ids = Vec::new();
        for (name, source) in [
            ("Angle 1", "C:/media/a.mp4"),
            ("Angle 2", "C:/media/b.mp4"),
            ("Angle 3", "C:/media/c.mp4"),
        ] {
            let imported = invoke(
                &runtime,
                "media.import",
                json!({
                    "name": name,
                    "source": source,
                    "mediaType": "video",
                    "durationSeconds": 12.0,
                    "width": 1920,
                    "height": 1080,
                    "frameRate": 30.0,
                    "sampleRate": 48000,
                    "channels": 2
                }),
            )
            .await;
            source_ids.push(
                imported["changedIds"][0]
                    .as_str()
                    .expect("asset id")
                    .to_owned(),
            );
        }
        let unified = invoke(
            &runtime,
            "media.angles.unify",
            json!({
                "assetIds": source_ids,
                "name": "Interview — Unified Angles",
                "audioAssetId": source_ids[0],
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;
        let unified_id = unified["changedIds"][0]
            .as_str()
            .expect("unified id")
            .to_owned();
        let added = invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": video_track_id,
                "name": "Interview — Unified Angles",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": 10.0,
                "assetId": unified_id
            }),
        )
        .await;
        let item_id = added["changedIds"][0].as_str().expect("item id").to_owned();
        let split = invoke(
            &runtime,
            "timeline.item.split",
            json!({"itemId": item_id, "atSeconds": 5.0}),
        )
        .await;
        let right_item_id = split["changedIds"][1]
            .as_str()
            .expect("right item id")
            .to_owned();
        let second_split = invoke(
            &runtime,
            "timeline.item.split",
            json!({"itemId": right_item_id, "atSeconds": 8.0}),
        )
        .await;
        let third_item_id = second_split["changedIds"][1]
            .as_str()
            .expect("third item id")
            .to_owned();
        invoke(
            &runtime,
            "timeline.item.angle.set",
            json!({
                "itemId": right_item_id,
                "angleAssetId": source_ids[1],
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;
        invoke(
            &runtime,
            "timeline.items.angle.set",
            json!({
                "itemIds": [third_item_id, item_id, right_item_id],
                "angleAssetId": source_ids[2],
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;
        invoke(
            &runtime,
            "timeline.items.fit.set",
            json!({
                "itemIds": [third_item_id, item_id, right_item_id],
                "fitMode": "cover",
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;
        let uniform_state = invoke(
            &runtime,
            "app.state.read",
            json!({"projectId": project_id, "pointer": "/project/timeline/tracks"}),
        )
        .await;
        let uniform_items: Vec<_> = uniform_state["value"]
            .as_array()
            .expect("tracks")
            .iter()
            .flat_map(|track| track["items"].as_array().expect("items"))
            .filter(|item| {
                [
                    item_id.as_str(),
                    right_item_id.as_str(),
                    third_item_id.as_str(),
                ]
                .contains(&item["id"].as_str().expect("item id"))
            })
            .collect();
        assert_eq!(uniform_items.len(), 3);
        assert!(
            uniform_items
                .iter()
                .all(|item| item["activeAngleAssetId"] == source_ids[2])
        );
        assert!(uniform_items.iter().all(|item| item["fitMode"] == "cover"));
        invoke(
            &runtime,
            "timeline.items.angles.cycle",
            json!({
                "itemIds": [third_item_id, item_id, right_item_id],
                "startingAngleAssetId": source_ids[1],
                "expectedRevision": runtime.snapshot().expect("snapshot").revision
            }),
        )
        .await;

        let state = invoke(
            &runtime,
            "app.state.read",
            json!({"projectId": project_id, "pointer": ""}),
        )
        .await;
        let value = &state["value"];
        let stored_unified = value["project"]["assets"]
            .as_array()
            .expect("assets")
            .iter()
            .find(|asset| asset["id"] == unified_id)
            .expect("unified asset");
        assert_eq!(
            stored_unified["unifiedAngles"]["audioAssetId"],
            source_ids[0]
        );
        assert_eq!(
            stored_unified["unifiedAngles"]["angleAssetIds"]
                .as_array()
                .expect("angle ids")
                .len(),
            3
        );
        let items: Vec<_> = value["project"]["timeline"]["tracks"]
            .as_array()
            .expect("tracks")
            .iter()
            .flat_map(|track| track["items"].as_array().expect("items"))
            .collect();
        for (item_id, angle_id) in [
            (&item_id, &source_ids[1]),
            (&right_item_id, &source_ids[2]),
            (&third_item_id, &source_ids[0]),
        ] {
            assert!(
                items.iter().any(|item| {
                    item["id"] == *item_id && item["activeAngleAssetId"] == *angle_id
                })
            );
        }
    }

    #[tokio::test]
    async fn ffmpeg_preview_and_export_render_real_files_when_available() {
        if std::process::Command::new(
            std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()),
        )
        .arg("-version")
        .output()
        .is_err()
        {
            return;
        }

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let source = std::env::temp_dir().join(format!("opencut-source-{unique}.mp4"));
        let preview = std::env::temp_dir().join(format!("opencut-preview-{unique}.png"));
        let export = std::env::temp_dir().join(format!("opencut-export-{unique}.mp4"));
        let ffmpeg = std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
        let generated = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=160x90:r=5:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                &source.to_string_lossy(),
            ])
            .status()
            .expect("generate source");
        assert!(generated.success());

        let runtime = OpenCutRuntime::default();
        invoke(
            &runtime,
            "project.create",
            json!({
                "name": "Render test",
                "settings": {
                    "width": 160,
                    "height": 90,
                    "frameRate": 5.0,
                    "sampleRate": 48000,
                    "channels": 2,
                    "backgroundColor": "#112233",
                    "colorSpace": "rec709"
                }
            }),
        )
        .await;
        let snapshot = runtime.snapshot().expect("snapshot");
        let tracks = &snapshot.project.as_ref().expect("project").timeline.tracks;
        let overlay_track = tracks
            .iter()
            .find(|track| track.kind == TrackKind::Overlay)
            .expect("overlay track")
            .id
            .clone();
        let video_track = tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video)
            .expect("video track")
            .id
            .clone();
        let imported = invoke(
            &runtime,
            "media.import",
            json!({
                "name": "Generated source",
                "source": source.to_string_lossy(),
                "mediaType": "video",
                "durationSeconds": 1.0,
                "width": 160,
                "height": 90,
                "frameRate": 5.0,
                "sampleRate": 48000,
                "channels": 1
            }),
        )
        .await;
        let asset_id = imported["changedIds"][0].as_str().expect("asset id");
        invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": video_track,
                "name": "Generated source",
                "kind": "video",
                "startSeconds": 0.0,
                "durationSeconds": 1.0,
                "assetId": asset_id
            }),
        )
        .await;
        invoke(
            &runtime,
            "timeline.item.add",
            json!({
                "trackId": overlay_track,
                "name": "Shape",
                "kind": "shape",
                "startSeconds": 0.0,
                "durationSeconds": 1.0,
                "shape": {
                    "shapeType": "rectangle",
                    "fillColor": "#ff0066",
                    "strokeColor": null,
                    "strokeWidth": 0.0,
                    "cornerRadius": 0.0,
                    "parameters": {"width": 80.0, "height": 45.0}
                }
            }),
        )
        .await;

        invoke(
            &runtime,
            "preview.frame.render",
            json!({
                "outputPath": preview.to_string_lossy(),
                "positionSeconds": 0.5,
                "overwrite": true
            }),
        )
        .await;
        invoke(
            &runtime,
            "export.render",
            json!({
                "outputPath": export.to_string_lossy(),
                "overwrite": true
            }),
        )
        .await;
        assert!(std::fs::metadata(&preview).expect("preview").len() > 0);
        assert!(std::fs::metadata(&export).expect("export").len() > 0);
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(preview);
        let _ = std::fs::remove_file(export);
    }
}

fn unknown(kind: &str, id: &str) -> CapabilityError {
    CapabilityError::Unavailable(format!("{kind} `{id}` was not found"))
}

fn move_items(
    document: &mut EditorDocument,
    ids: &[String],
    input: &ItemMoveInput,
) -> Result<(), CapabilityError> {
    if ids.is_empty() {
        return Err(CapabilityError::InvalidInput(
            "itemIds must not be empty".into(),
        ));
    }
    let project = project_mut(document)?;
    let mut extracted = Vec::new();
    for track in &mut project.timeline.tracks {
        if track.locked {
            continue;
        }
        let mut index = 0;
        while index < track.items.len() {
            if ids.contains(&track.items[index].id) {
                if track.items[index].locked {
                    return Err(CapabilityError::Denied(format!(
                        "timeline item `{}` is locked",
                        track.items[index].id
                    )));
                }
                extracted.push((track.id.clone(), track.items.remove(index)));
            } else {
                index += 1;
            }
        }
    }
    if extracted.len() != ids.len() {
        return Err(CapabilityError::Unavailable(
            "one or more timeline items were not found on unlocked tracks".into(),
        ));
    }
    let minimum_start = extracted
        .iter()
        .map(|(_, item)| item.start_seconds)
        .fold(f64::INFINITY, f64::min);
    let delta = input
        .start_seconds
        .map(|start| start - minimum_start)
        .unwrap_or(input.delta_seconds.unwrap_or(0.0));
    for (_, item) in &mut extracted {
        item.start_seconds += delta;
    }
    let mut insert_offsets = std::collections::HashMap::<String, (usize, usize)>::new();
    for (source_track_id, item) in extracted {
        let target_id = input.target_track_id.as_deref().unwrap_or(&source_track_id);
        let target = project
            .timeline
            .tracks
            .iter_mut()
            .find(|track| track.id == target_id)
            .ok_or_else(|| unknown("target track", target_id))?;
        ensure_unlocked(target, None)?;
        let (base_index, offset) =
            insert_offsets
                .entry(target_id.to_owned())
                .or_insert_with(|| {
                    (
                        input
                            .index
                            .unwrap_or(target.items.len())
                            .min(target.items.len()),
                        0,
                    )
                });
        target.items.insert(*base_index + *offset, item);
        *offset += 1;
    }
    Ok(())
}

fn duplicate_items(
    document: &mut EditorDocument,
    input: &ItemDuplicateInput,
) -> Result<Vec<String>, CapabilityError> {
    if input.item_ids.is_empty() {
        return Err(CapabilityError::InvalidInput(
            "itemIds must not be empty".into(),
        ));
    }
    let originals: Vec<(String, TimelineItem)> = {
        let project = project_mut(document)?;
        input
            .item_ids
            .iter()
            .map(|id| {
                project
                    .timeline
                    .tracks
                    .iter()
                    .find_map(|track| {
                        track
                            .items
                            .iter()
                            .find(|item| item.id == *id)
                            .map(|item| (track.id.clone(), item.clone()))
                    })
                    .ok_or_else(|| unknown("timeline item", id))
            })
            .collect::<Result<_, _>>()?
    };
    let mut copies = Vec::new();
    for (source_track, mut item) in originals {
        item.id = document.allocate_id("item");
        let new_id = item.id.clone();
        item.name = format!("{} copy", item.name);
        item.start_seconds += input.offset_seconds;
        for effect in &mut item.effects {
            effect.id = document.allocate_id("effect");
        }
        for keyframe in &mut item.keyframes {
            keyframe.id = document.allocate_id("keyframe");
        }
        copies.push((
            input.target_track_id.clone().unwrap_or(source_track),
            item,
            new_id,
        ));
    }
    let project = project_mut(document)?;
    let mut ids = Vec::new();
    for (track_id, item, id) in copies {
        let track = project
            .timeline
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| unknown("target track", &track_id))?;
        ensure_unlocked(track, None)?;
        track.items.push(item);
        ids.push(id);
    }
    Ok(ids)
}

impl From<ModelError> for CapabilityError {
    fn from(error: ModelError) -> Self {
        CapabilityError::InvalidInput(error.to_string())
    }
}
