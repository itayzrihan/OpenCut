//! Transfers an existing host session, including its undo/redo boundaries, into
//! the same editor history used by capabilities. No live host document is kept.

use super::*;
use crate::ClassicProject;
use crate::classic_archive::{
    ArchivedClassicProject, ArchivedHistorySnapshot, SourcePool, validate_sources, HISTORY_EXPANDED_BUDGET,
};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClassicHistoryBoundary {
    label: String,
    #[schemars(with = "ClassicProject")]
    classic: CompactClassic,
    #[serde(default)]
    host_context: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    viewer_scene_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(try_from = "ClassicProject", into = "ClassicProject")]
struct CompactClassic(Arc<str>);
impl Clone for CompactClassic { fn clone(&self) -> Self { Self(self.0.clone()) } }
impl From<ClassicProject> for CompactClassic {
    fn from(value: ClassicProject) -> Self { Self(serde_json::to_string(&value).expect("Classic serializes").into()) }
}
impl From<CompactClassic> for ClassicProject {
    fn from(value: CompactClassic) -> Self { serde_json::from_str(&value.0).expect("internally serialized Classic") }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    viewer_scene_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    viewer_scene_id: Option<String>,
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
            async move { attach_session(&state, &events, context, input, None, None) }
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
    sources: &mut SourcePool,
) -> Result<Vec<HistoryEntry>, CapabilityError> {
    entries
        .into_iter()
        .map(|entry| {
            if entry.label.trim().is_empty() {
                return Err(CapabilityError::InvalidInput(
                    "Classic history label must not be empty".into(),
                ));
            }
            let mut classic: ClassicProject = entry.classic.into();
            classic.intern_sources(sources);
            let mut document = with_classic(template, project_id, classic)?;
            if let Some(scene_id) = entry.viewer_scene_id {
                restore_viewer(&mut document, project_id, scene_id)?;
            }
            Ok(HistoryEntry {
                label: entry.label,
                document: document.into(),
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
            let document = entry.document.materialize();
            Ok(ClassicHistoryBoundary {
                label: entry.label.clone(),
                classic: read_classic(&document)?.into(),
                host_context: entry.host_context.clone(),
                viewer_scene_id: viewer_hint(&document),
            })
        })
        .collect()
}

fn viewer_hint(document: &EditorDocument) -> Option<String> {
    let classic = document.project.as_ref()?.classic.as_ref()?;
    let view = document.classic_view_scene_id()?;
    (classic.document["currentSceneId"].as_str() != Some(view)).then(|| view.to_owned())
}

fn restore_viewer(document: &mut EditorDocument, project_id: &str, scene_id: String) -> Result<(), CapabilityError> {
    if [project_id, scene_id.as_str()].iter().any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)) {
        return Err(CapabilityError::InvalidInput("invalid archived viewer identity".into()));
    }
    let classic = document.project.as_ref().and_then(|p| p.classic.as_ref()).unwrap();
    if !classic.document["scenes"].as_array().unwrap().iter().any(|s| s["id"] == scene_id) {
        return Err(CapabilityError::InvalidInput("archived viewer scene not found".into()));
    }
    document.workspace.classic_scene = Some(crate::ClassicSceneNavigation { project_id: project_id.into(), scene_id });
    Ok(())
}

fn attach_session(
    state: &Arc<RwLock<EditorStore>>,
    events: &broadcast::Sender<u64>,
    context: InvocationContext,
    input: AttachInput,
    restored_revision: Option<u64>,
    viewer_scene_id: Option<String>,
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
    if let Some(scene_id) = viewer_scene_id { restore_viewer(&mut document, &input.project_id, scene_id)?; }
    // Materialize each compact boundary once, validate it and store it once.
    // Interning must not serialize/reparse the entire episode in an extra loop.
    let undo = import_stack(template, &input.project_id, input.undo_stack, &mut sources)?;
    let redo = import_stack(template, &input.project_id, input.redo_stack, &mut sources)?;
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
        "Serializes Classic history with each immutable HyperFrames source stored once. compact:true emits version 2 lossless history deltas against the current snapshot; chained:true with compact emits version 3 deltas against the preceding boundary in each stack; version 1 remains readable and is the default. Composition source strings refer to SHA-256 keys in sources. persistableOnly keeps up to the last 100 entries after the last host action marked persistable:false in each stack, within the shared expanded-history storage budget. The live history remains intact; recent undo and redo boundaries are retained first. Restore validates sources and every boundary before changing state.",
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
                            let document = entry.document.materialize();
                            let viewer_scene_id = viewer_hint(&document);
                            let archived = classic_ref(&document)?.to_archive(&mut sources);
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
                                viewer_scene_id,
                            })
                        })
                        .collect::<Result<Vec<_>, CapabilityError>>()
                };
                let (undo, redo) = if input.persistable_only {
                    bounded_persistable_entries(&store.undo, &store.redo, HISTORY_EXPANDED_BUDGET)
                } else {
                    (store.undo.as_slice(), store.redo.as_slice())
                };
                let undo_stack = archive_stack(undo)?;
                let redo_stack = archive_stack(redo)?;
                let viewer_scene_id = viewer_hint(&store.document);
                let has_viewer = viewer_scene_id.is_some() || undo_stack.iter().chain(&redo_stack).any(|entry| entry.viewer_scene_id.is_some());
                Ok(OperationSuccess::new(SessionArchive {
                    schema_version: if has_viewer && input.compact && !input.chained { 5 } else if has_viewer { 4 } else if input.compact && input.chained {
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
                    viewer_scene_id,
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
                if !matches!(archive.schema_version, 1 | 2 | 3 | 4 | 5) {
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
                let mut expanded_budget = HISTORY_EXPANDED_BUDGET;
                let mut restore = |entries: Vec<ArchivedBoundary>| {
                    let mut previous = base.clone();
                    entries
                        .into_iter()
                        .map(|entry| {
                            let classic = entry.classic
                                .restore(&mut previous, matches!(archive.schema_version, 3 | 4), &archive.sources, &mut expanded_budget)
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                            Ok(ClassicHistoryBoundary {
                                label: entry.label,
                                host_context: entry.host_context,
                                classic: classic.into(),
                                viewer_scene_id: entry.viewer_scene_id,
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
                attach_session(&state, &events, context, restored, Some(archive.revision), archive.viewer_scene_id)
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

// Share the restore budget between both stacks, retaining contiguous recent
// suffixes. Never truncate the live history or the current project/transcript.
fn bounded_persistable_entries<'a>(
    undo: &'a [HistoryEntry], redo: &'a [HistoryEntry], mut budget: usize,
) -> (&'a [HistoryEntry], &'a [HistoryEntry]) {
    let undo = persistable_entries(undo);
    let redo = persistable_entries(redo);
    let (mut u, mut r) = (undo.len(), redo.len());
    loop {
        let before = (u, r);
        if u > 0 {
            let bytes = undo[u - 1].document.classic_archive_bytes();
            if bytes <= budget { budget -= bytes; u -= 1; }
        }
        if r > 0 {
            let bytes = redo[r - 1].document.classic_archive_bytes();
            if bytes <= budget { budget -= bytes; r -= 1; }
        }
        if before == (u, r) { break; }
    }
    (&undo[u..], &redo[r..])
}

#[cfg(test)]
mod archive_budget_tests {
    use super::*;
    use crate::runtime::HistoryDocument;

    #[test]
    fn durable_history_fits_restore_budget_without_truncating_live_stacks() {
        let entry = |label: &str, bytes| HistoryEntry {
            label: label.into(),
            document: HistoryDocument::Classic {
                json: "{}".into(), revision: 1, archive_bytes: bytes,
            },
            host_context: Map::new(),
        };
        let undo = vec![entry("old", 6), entry("middle", 6), entry("latest", 6)];
        let redo = vec![entry("far", 6), entry("next", 6)];
        let (u, r) = bounded_persistable_entries(&undo, &redo, 19);
        assert_eq!(u.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["middle", "latest"]);
        assert_eq!(r.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["next"]);
        assert_eq!(undo.len(), 3);
        assert_eq!(redo.len(), 2);
        let (u, r) = bounded_persistable_entries(&undo, &redo, 5);
        assert!(u.is_empty() && r.is_empty());
    }
}
