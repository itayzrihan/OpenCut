//! Transfers an existing host session, including its undo/redo boundaries, into
//! the same editor history used by capabilities. No live host document is kept.

use super::*;
use crate::ClassicProject;

const MAX_IMPORTED_HISTORY: usize = 200;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClassicHistoryBoundary {
    label: String,
    classic: ClassicProject,
    #[serde(default)]
    host_context: Map<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachInput {
    project_id: String,
    expected_revision: u64,
    classic: ClassicProject,
    #[serde(default)]
    undo_stack: Vec<ClassicHistoryBoundary>,
    #[serde(default)]
    redo_stack: Vec<ClassicHistoryBoundary>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    project_id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SessionOutput {
    project_id: String,
    revision: u64,
    classic: ClassicProject,
    undo_stack: Vec<ClassicHistoryBoundary>,
    redo_stack: Vec<ClassicHistoryBoundary>,
}

pub(super) fn register_classic_session_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let attach_state = state.clone();
    register::<AttachInput, MutationOutput, _, _>(
        registry,
        "project.classic.session.attach",
        "Attach Classic session and history",
        "Atomically adopts a complete Classic document and its existing undo/redo target snapshots into an empty runtime. Stacks are ordered oldest first, next action last. Every boundary must belong to the same project. Host context carries selection or callback identifiers; it is inert JSON. Supports dry run, explicit revision and registry retry keys.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["classic", "history", "bridge"],
        move |context, input| {
            let state = attach_state.clone();
            let events = events.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                if requested_project_id(&context).is_some_and(|id| id != input.project_id) {
                    return Err(CapabilityError::Conflict(
                        "Classic target project mismatch".into(),
                    ));
                }
                if input.undo_stack.len() > MAX_IMPORTED_HISTORY
                    || input.redo_stack.len() > MAX_IMPORTED_HISTORY
                {
                    return Err(CapabilityError::InvalidInput(
                        "Classic history exceeds 200 entries per stack".into(),
                    ));
                }
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if store.document.project.is_some() {
                    return Err(CapabilityError::Conflict(
                        "Classic session adoption requires an empty runtime".into(),
                    ));
                }
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(format!(
                        "revision conflict: expected {}, current revision is {}",
                        input.expected_revision, store.document.revision
                    )));
                }
                let template = &store.document;
                let mut document = with_classic(template, &input.project_id, input.classic)?;
                let undo = import_stack(template, &input.project_id, input.undo_stack)?;
                let redo = import_stack(template, &input.project_id, input.redo_stack)?;
                let previous_revision = template.revision;
                document.revision = previous_revision + 1;
                let revision = document.revision;
                if !context.dry_run {
                    store.begin_new_active(document, false);
                    store.undo = undo;
                    store.redo = redo;
                }
                drop(store);
                if !context.dry_run {
                    let _ = events.send(revision);
                }
                Ok(OperationSuccess::new(MutationOutput {
                    project_id: Some(input.project_id.clone()),
                    previous_revision,
                    revision,
                    committed: !context.dry_run,
                    undo_entry: None,
                    warnings: Vec::new(),
                    changed_ids: vec![input.project_id],
                })
                .summary("Attached Classic project and existing history")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;
    register::<ReadInput, SessionOutput, _, _>(
        registry,
        "project.classic.session.read",
        "Read Classic session and history",
        "Returns the canonical Classic document and its complete undo/redo boundaries for host persistence. Does not execute any host callbacks or expose transient media handles.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["classic", "history", "storage"],
        move |_, input| {
            let state = state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if store.active_project_id() != Some(&input.project_id) {
                    return Err(CapabilityError::Conflict(
                        "Classic target project is not active".into(),
                    ));
                }
                Ok(OperationSuccess::new(SessionOutput {
                    project_id: input.project_id,
                    revision: store.document.revision,
                    classic: read_classic(&store.document)?,
                    undo_stack: export_stack(&store.undo)?,
                    redo_stack: export_stack(&store.redo)?,
                }))
            }
        },
    )
}

fn with_classic(
    template: &EditorDocument,
    project_id: &str,
    classic: ClassicProject,
) -> Result<EditorDocument, CapabilityError> {
    let invalid = |error: ModelError| CapabilityError::InvalidInput(error.to_string());
    classic.validate().map_err(invalid)?;
    if classic.id().map_err(invalid)? != project_id {
        return Err(CapabilityError::Conflict(
            "Classic history belongs to another project".into(),
        ));
    }
    let mut document = template.clone();
    document.project = Some(Project {
        id: project_id.into(),
        name: classic.name().map_err(invalid)?.into(),
        settings: classic.settings().map_err(invalid)?,
        file_path: None,
        assets: Vec::new(),
        timeline: Timeline::default(),
        classic: Some(classic),
        metadata: Default::default(),
        export_presets: Vec::new(),
        extensions: Map::new(),
    });
    document.sync_exact_from_seconds().map_err(invalid)?;
    document.validate().map_err(invalid)?;
    Ok(document)
}

fn import_stack(
    template: &EditorDocument,
    project_id: &str,
    entries: Vec<ClassicHistoryBoundary>,
) -> Result<Vec<HistoryEntry>, CapabilityError> {
    entries
        .into_iter()
        .map(|entry| {
            if entry.label.trim().is_empty() {
                return Err(CapabilityError::InvalidInput(
                    "Classic history label must not be empty".into(),
                ));
            }
            Ok(HistoryEntry {
                label: entry.label,
                document: with_classic(template, project_id, entry.classic)?,
                host_context: entry.host_context,
            })
        })
        .collect()
}

fn read_classic(document: &EditorDocument) -> Result<ClassicProject, CapabilityError> {
    document
        .project
        .as_ref()
        .and_then(|project| project.classic.clone())
        .ok_or_else(|| {
            CapabilityError::Unavailable("session does not contain a Classic document".into())
        })
}

fn export_stack(entries: &[HistoryEntry]) -> Result<Vec<ClassicHistoryBoundary>, CapabilityError> {
    entries
        .iter()
        .map(|entry| {
            Ok(ClassicHistoryBoundary {
                label: entry.label.clone(),
                classic: read_classic(&entry.document)?,
                host_context: entry.host_context.clone(),
            })
        })
        .collect()
}
