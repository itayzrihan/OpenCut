//! Transfers an existing host session, including its undo/redo boundaries, into
//! the same editor history used by capabilities. No live host document is kept.

use super::*;
use crate::ClassicProject;
use crate::classic_archive::{
    ArchivedClassicProject, ArchivedHistorySnapshot, SourcePool, validate_sources,
};

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

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveInput {
    project_id: String,
    #[serde(default)]
    persistable_only: bool,
    #[serde(default)]
    compact: bool,
    #[serde(default)]
    chained: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    project_id: String,
    revision: u64,
    can_undo: bool,
    can_redo: bool,
    undo_context: Option<Map<String, Value>>,
    redo_context: Option<Map<String, Value>>,
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

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchivedBoundary {
    label: String,
    classic: ArchivedHistorySnapshot,
    #[serde(default)]
    host_context: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionArchive {
    schema_version: u32,
    project_id: String,
    revision: u64,
    classic: ArchivedClassicProject,
    undo_stack: Vec<ArchivedBoundary>,
    redo_stack: Vec<ArchivedBoundary>,
    sources: SourcePool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreInput {
    project_id: String,
    expected_revision: u64,
    archive: SessionArchive,
}

pub(super) fn register_classic_session_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register_archive_operations(registry, state.clone(), events.clone())?;
    let status_state = state.clone();
    register::<ReadInput, SessionStatus, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.session.status",
        "Read Classic history status",
        "Returns the active Classic project revision and undo/redo availability without serializing the project or source packages.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["classic", "history"],
        move |_, input| {
            let state = status_state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if store.active_project_id() != Some(&input.project_id)
                    || classic_ref(&store.document).is_err()
                {
                    return Err(CapabilityError::Conflict(
                        "Classic target project is not active".into(),
                    ));
                }
                Ok(OperationSuccess::new(SessionStatus {
                    project_id: input.project_id,
                    revision: store.document.revision,
                    can_undo: !store.undo.is_empty(),
                    can_redo: !store.redo.is_empty(),
                    undo_context: store.undo.last().map(|entry| entry.host_context.clone()),
                    redo_context: store.redo.last().map(|entry| entry.host_context.clone()),
                }))
            }
        },
    )?;
    let attach_state = state.clone();
    register::<AttachInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
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
            async move { attach_session(&state, &events, context, input, None) }
        },
    )?;
    register::<ReadInput, SessionOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
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
    // document.validate below validates the Classic payload once, including every take.
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

fn attach_session(
    state: &Arc<RwLock<EditorStore>>,
    events: &broadcast::Sender<u64>,
    context: InvocationContext,
    input: AttachInput,
    restored_revision: Option<u64>,
) -> Result<OperationSuccess<MutationOutput>, CapabilityError> {
    if context.cancellation.is_cancelled() {
        return Err(CapabilityError::Failed("operation was cancelled".into()));
    }
    if requested_project_id(&context).is_some_and(|id| id != input.project_id) {
        return Err(CapabilityError::Conflict(
            "Classic target project mismatch".into(),
        ));
    }
    let mut store = state
        .write()
        .map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?;
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
    let mut sources = SourcePool::new();
    let mut current = input.classic;
    current.intern_sources(&mut sources);
    let mut document = with_classic(template, &input.project_id, current)?;
    let mut share = |mut entries: Vec<ClassicHistoryBoundary>| {
        for entry in &mut entries {
            entry.classic.intern_sources(&mut sources);
        }
        import_stack(template, &input.project_id, entries)
    };
    let undo = share(input.undo_stack)?;
    let redo = share(input.redo_stack)?;
    let previous_revision = template.revision;
    document.revision = restored_revision.unwrap_or(previous_revision + 1);
    if document.revision <= previous_revision || document.revision >= 9_007_199_254_740_991 {
        return Err(CapabilityError::InvalidInput("restored revision must be positive, newer than the empty runtime, and safely incrementable by browser hosts".into()));
    }
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

fn register_archive_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let archive_state = state.clone();
    register::<ArchiveInput, SessionArchive, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.session.archive",
        "Archive Classic session",
        "Serializes Classic history with each immutable HyperFrames source stored once. compact:true emits version 2 lossless history deltas against the current snapshot; chained:true with compact emits version 3 deltas against the preceding boundary in each stack; version 1 remains readable and is the default. Composition source strings refer to SHA-256 keys in sources. persistableOnly keeps the last 100 entries after the last host action marked persistable:false in each stack, matching Classic's existing durable history boundary for media side effects. Restore validates sources and every boundary before changing state.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["classic", "history", "storage"],
        move |_, input| {
            let state = archive_state.clone();
            async move {
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                if store.active_project_id() != Some(&input.project_id) {
                    return Err(CapabilityError::Conflict(
                        "Classic target project is not active".into(),
                    ));
                }
                let mut sources = SourcePool::new();
                let classic = classic_ref(&store.document)?.to_archive(&mut sources);
                let base = input
                    .compact
                    .then(|| serde_json::to_value(&classic))
                    .transpose()
                    .map_err(|e| CapabilityError::Failed(e.to_string()))?;
                let mut archive_stack = |entries: &[HistoryEntry]| {
                    let mut previous = base.clone();
                    entries
                        .iter()
                        .map(|entry| {
                            let archived = classic_ref(&entry.document)?.to_archive(&mut sources);
                            let next_base = if input.compact && input.chained {
                                Some(serde_json::to_value(&archived)
                                    .map_err(|e| CapabilityError::Failed(e.to_string()))?)
                            } else {
                                None
                            };
                            let snapshot = ArchivedHistorySnapshot::encode(archived, previous.as_ref())
                                .map_err(|e| CapabilityError::Failed(e.to_string()))?;
                            if let Some(next_base) = next_base {
                                previous = Some(next_base);
                            }
                            Ok(ArchivedBoundary {
                                label: entry.label.clone(),
                                host_context: entry.host_context.clone(),
                                classic: snapshot,
                            })
                        })
                        .collect::<Result<Vec<_>, CapabilityError>>()
                };
                let undo_stack = archive_stack(if input.persistable_only {
                    persistable_entries(&store.undo)
                } else {
                    &store.undo
                })?;
                let redo_stack = archive_stack(if input.persistable_only {
                    persistable_entries(&store.redo)
                } else {
                    &store.redo
                })?;
                Ok(OperationSuccess::new(SessionArchive {
                    schema_version: if input.compact && input.chained {
                        3
                    } else if input.compact {
                        2
                    } else {
                        1
                    },
                    project_id: input.project_id,
                    revision: store.document.revision,
                    classic,
                    undo_stack,
                    redo_stack,
                    sources,
                }))
            }
        },
    )?;
    register::<RestoreInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.classic.session.restore",
        "Restore Classic session archive",
        "Atomically adopts a versioned compact Classic archive into an empty runtime. Validates source hashes, project identity, every undo/redo boundary and the expected revision. Supports dry run and registry retry keys.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["classic", "history", "storage"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let archive = input.archive;
                if !matches!(archive.schema_version, 1 | 2 | 3) {
                    return Err(CapabilityError::InvalidInput(
                        "Unsupported Classic archive schema".into(),
                    ));
                }
                if archive.project_id != input.project_id {
                    return Err(CapabilityError::Conflict(
                        "Classic archive belongs to another project".into(),
                    ));
                }
                validate_sources(&archive.sources)
                    .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                let base = (archive.schema_version >= 2)
                    .then(|| serde_json::to_value(&archive.classic))
                    .transpose()
                    .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                let mut expanded_budget = 512_000_000usize;
                let mut restore = |entries: Vec<ArchivedBoundary>| {
                    let mut previous = base.clone();
                    let mut sources = archive.sources.clone();
                    entries
                        .into_iter()
                        .map(|entry| {
                            let classic = entry.classic
                                .restore(previous.as_ref(), &archive.sources, &mut expanded_budget)
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                            if archive.schema_version == 3 {
                                previous = Some(serde_json::to_value(classic.to_archive(&mut sources))
                                    .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?);
                            }
                            Ok(ClassicHistoryBoundary {
                                label: entry.label,
                                host_context: entry.host_context,
                                classic,
                            })
                        })
                        .collect::<Result<Vec<_>, CapabilityError>>()
                };
                let restored = AttachInput {
                    project_id: input.project_id,
                    expected_revision: input.expected_revision,
                    classic: archive
                        .classic
                        .restore(&archive.sources)
                        .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?,
                    undo_stack: restore(archive.undo_stack)?,
                    redo_stack: restore(archive.redo_stack)?,
                };
                attach_session(&state, &events, context, restored, Some(archive.revision))
            }
        },
    )
}

fn classic_ref(document: &EditorDocument) -> Result<&ClassicProject, CapabilityError> {
    document
        .project
        .as_ref()
        .and_then(|project| project.classic.as_ref())
        .ok_or_else(|| {
            CapabilityError::Unavailable("session does not contain a Classic document".into())
        })
}

fn persistable_entries(entries: &[HistoryEntry]) -> &[HistoryEntry] {
    let start = entries
        .iter()
        .rposition(|entry| entry.host_context.get("persistable") == Some(&Value::Bool(false)))
        .map_or(0, |index| index + 1);
    &entries[start.max(entries.len().saturating_sub(100))..]
}
