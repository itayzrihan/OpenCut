use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{Arc, RwLock},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;

use crate::{
    AccessPolicy, ArtifactStore, Capability, CapabilityRegistry, EditorDocument, JobManager,
    RegistryError, operations,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryEntry {
    pub label: String,
    #[schemars(with = "EditorDocument")]
    pub document: HistoryDocument,
    /// Host presentation state (selection, side-effect callback ID), never a
    /// second copy of the editor document or executable code.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub host_context: serde_json::Map<String, serde_json::Value>,
}

/// History snapshots stay lossless, but Classic's JSON tree is materialized only
/// for the boundary being read. Thousands of captions across 100 undo steps must
/// not expand into hundreds of thousands of separately allocated JSON objects.
#[derive(Debug, Clone)]
pub(crate) enum HistoryDocument {
    Native(Box<EditorDocument>),
    Classic { json: Arc<str>, revision: u64, archive_bytes: usize },
}
impl From<EditorDocument> for HistoryDocument {
    fn from(document: EditorDocument) -> Self {
        if let Some(classic) = document.project.as_ref().and_then(|p| p.classic.as_ref()) {
            let archive_bytes = classic.to_archive(&mut crate::classic_archive::SourcePool::new())
                .encoded_len().expect("validated Classic archive serializes");
            Self::Classic { revision: document.revision,
                archive_bytes,
                json: serde_json::to_string(&document).expect("validated editor document serializes").into() }
        } else { Self::Native(Box::new(document)) }
    }
}
impl HistoryDocument {
    pub(crate) fn materialize(&self) -> EditorDocument {
        match self {
            Self::Native(document) => (**document).clone(),
            Self::Classic { json, .. } => serde_json::from_str(json).expect("internally serialized history"),
        }
    }
    pub(crate) fn revision(&self) -> u64 {
        match self { Self::Native(d) => d.revision, Self::Classic { revision, .. } => *revision }
    }
    pub(crate) fn is_classic(&self) -> bool { matches!(self, Self::Classic { .. }) }
    pub(crate) fn classic_archive_bytes(&self) -> usize {
        match self { Self::Classic { archive_bytes, .. } => *archive_bytes, Self::Native(_) => 0 }
    }
}
impl Serialize for HistoryDocument {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.materialize().serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for HistoryDocument {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        EditorDocument::deserialize(deserializer).map(Self::from)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StoredProjectSession {
    pub document: EditorDocument,
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
    pub last_saved_revision: Option<u64>,
    pub opened_at_ms: u64,
    pub last_opened_at_ms: u64,
    pub thumbnail_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionInfo {
    pub project_id: String,
    pub name: String,
    pub path: Option<String>,
    pub revision: u64,
    pub dirty: bool,
    pub active: bool,
    pub opened_at_ms: u64,
    pub last_opened_at_ms: u64,
    pub thumbnail_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectInfo {
    pub project_id: String,
    pub name: String,
    pub path: Option<String>,
    pub last_opened_at_ms: u64,
    pub thumbnail_uri: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    document: EditorDocument,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    undo: Vec<HistoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    redo: Vec<HistoryEntry>,
    last_saved_revision: Option<u64>,
    opened_at_ms: u64,
    last_opened_at_ms: u64,
    thumbnail_uri: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedApplicationState {
    version: u32,
    active: PersistedSession,
    inactive: Vec<PersistedSession>,
    recent_projects: Vec<RecentProjectInfo>,
}

#[derive(Debug, Clone)]
pub(crate) struct EditorStore {
    pub document: EditorDocument,
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
    pub last_saved_revision: Option<u64>,
    pub inactive_sessions: BTreeMap<String, StoredProjectSession>,
    pub recent_projects: Vec<RecentProjectInfo>,
    pub active_opened_at_ms: u64,
    pub active_thumbnail_uri: Option<String>,
}

impl Default for EditorStore {
    fn default() -> Self {
        Self {
            document: EditorDocument::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            last_saved_revision: None,
            inactive_sessions: BTreeMap::new(),
            recent_projects: Vec::new(),
            active_opened_at_ms: now_ms(),
            active_thumbnail_uri: None,
        }
    }
}

impl EditorStore {
    pub fn active_project_id(&self) -> Option<&str> {
        self.document
            .project
            .as_ref()
            .map(|project| project.id.as_str())
    }

    pub fn document_for(&self, project_id: Option<&str>) -> Option<&EditorDocument> {
        match project_id {
            None => Some(&self.document),
            Some(id) if self.active_project_id() == Some(id) => Some(&self.document),
            Some(id) => self
                .inactive_sessions
                .get(id)
                .map(|session| &session.document),
        }
    }

    pub fn session_infos(&self) -> Vec<ProjectSessionInfo> {
        let mut sessions = Vec::new();
        if let Some(project) = &self.document.project {
            sessions.push(ProjectSessionInfo {
                project_id: project.id.clone(),
                name: project.name.clone(),
                path: project.file_path.clone(),
                revision: self.document.revision,
                dirty: self.last_saved_revision != Some(self.document.revision),
                active: true,
                opened_at_ms: self.active_opened_at_ms,
                last_opened_at_ms: now_ms(),
                thumbnail_uri: self.active_thumbnail_uri.clone(),
            });
        }
        sessions.extend(self.inactive_sessions.values().filter_map(|session| {
            let project = session.document.project.as_ref()?;
            Some(ProjectSessionInfo {
                project_id: project.id.clone(),
                name: project.name.clone(),
                path: project.file_path.clone(),
                revision: session.document.revision,
                dirty: session.last_saved_revision != Some(session.document.revision),
                active: false,
                opened_at_ms: session.opened_at_ms,
                last_opened_at_ms: session.last_opened_at_ms,
                thumbnail_uri: session.thumbnail_uri.clone(),
            })
        }));
        sessions.sort_by_key(|session| {
            (
                !session.active,
                std::cmp::Reverse(session.last_opened_at_ms),
            )
        });
        sessions
    }

    pub fn activate(&mut self, project_id: &str) -> Result<bool, RuntimeError> {
        if self.active_project_id() == Some(project_id) {
            return Ok(false);
        }
        let target = self
            .inactive_sessions
            .remove(project_id)
            .ok_or_else(|| RuntimeError::UnknownProject(project_id.to_owned()))?;
        self.stash_active();
        self.document = target.document;
        self.undo = target.undo;
        self.redo = target.redo;
        self.last_saved_revision = target.last_saved_revision;
        self.active_opened_at_ms = target.opened_at_ms;
        self.active_thumbnail_uri = target.thumbnail_uri;
        self.touch_recent();
        Ok(true)
    }

    pub fn stash_active(&mut self) {
        let Some(project) = self.document.project.as_ref() else {
            return;
        };
        let id = project.id.clone();
        let session = StoredProjectSession {
            document: std::mem::take(&mut self.document),
            undo: std::mem::take(&mut self.undo),
            redo: std::mem::take(&mut self.redo),
            last_saved_revision: self.last_saved_revision.take(),
            opened_at_ms: self.active_opened_at_ms,
            last_opened_at_ms: now_ms(),
            thumbnail_uri: self.active_thumbnail_uri.take(),
        };
        self.inactive_sessions.insert(id, session);
    }

    pub fn begin_new_active(&mut self, document: EditorDocument, saved: bool) {
        self.stash_active();
        self.document = document;
        self.undo.clear();
        self.redo.clear();
        self.last_saved_revision = saved.then_some(self.document.revision);
        self.active_opened_at_ms = now_ms();
        self.active_thumbnail_uri = None;
        self.touch_recent();
    }

    pub fn close_project(&mut self, project_id: &str) -> Result<bool, RuntimeError> {
        if self.active_project_id() == Some(project_id) {
            self.add_active_to_recent();
            self.document = EditorDocument::default();
            self.undo.clear();
            self.redo.clear();
            self.last_saved_revision = None;
            self.active_thumbnail_uri = None;
            if let Some(next_id) = self
                .inactive_sessions
                .iter()
                .max_by_key(|(_, session)| session.last_opened_at_ms)
                .map(|(id, _)| id.clone())
            {
                self.activate(&next_id)?;
            }
            return Ok(true);
        }
        let Some(closed) = self.inactive_sessions.remove(project_id) else {
            return Err(RuntimeError::UnknownProject(project_id.to_owned()));
        };
        if let Some(project) = closed.document.project {
            self.upsert_recent(RecentProjectInfo {
                project_id: project.id,
                name: project.name,
                path: project.file_path,
                last_opened_at_ms: now_ms(),
                thumbnail_uri: closed.thumbnail_uri,
            });
        }
        Ok(false)
    }

    fn touch_recent(&mut self) {
        self.add_active_to_recent();
    }

    fn add_active_to_recent(&mut self) {
        if let Some(project) = &self.document.project {
            self.upsert_recent(RecentProjectInfo {
                project_id: project.id.clone(),
                name: project.name.clone(),
                path: project.file_path.clone(),
                last_opened_at_ms: now_ms(),
                thumbnail_uri: self.active_thumbnail_uri.clone(),
            });
        }
    }

    fn upsert_recent(&mut self, recent: RecentProjectInfo) {
        self.recent_projects
            .retain(|entry| entry.project_id != recent.project_id);
        self.recent_projects.insert(0, recent);
        self.recent_projects.truncate(50);
    }
}

/// Shared OpenCut runtime used by UI, headless mode, plugins, scripting, and MCP.
#[derive(Clone)]
pub struct OpenCutRuntime {
    registry: CapabilityRegistry,
    pub(crate) state: Arc<RwLock<EditorStore>>,
    state_events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
    jobs: JobManager,
    classic_effects: crate::ClassicEffectCatalog,
    classic_masks: crate::ClassicMaskCatalog,
    classic_animation: crate::ClassicAnimationCatalog,
}

impl OpenCutRuntime {
    /// Host observation time for public activity; never supplied by a model.
    pub fn host_time_ms() -> u64 { now_ms() }
    pub(crate) fn mutation_events(&self) -> broadcast::Sender<u64> { self.state_events.clone() }
    pub(crate) fn downgrade(&self) -> impl Fn() -> Option<Self> + Clone + Send + Sync + 'static {
        let registry = self.registry.downgrade();
        let state = self.state.clone();
        let state_events = self.state_events.clone();
        let artifacts = self.artifacts.clone();
        let jobs = self.jobs.clone();
        let classic_effects = self.classic_effects.clone();
        let classic_masks = self.classic_masks.clone();
        let classic_animation = self.classic_animation.clone();
        move || Some(Self { registry: registry()?, state: state.clone(), state_events: state_events.clone(), artifacts: artifacts.clone(), jobs: jobs.clone(), classic_effects: classic_effects.clone(), classic_masks: classic_masks.clone(), classic_animation: classic_animation.clone() })
    }
}

#[derive(Clone)]
pub struct RuntimeCheckpoint {
    store: EditorStore,
    idempotency: crate::registry::IdempotencyState,
}

impl OpenCutRuntime {
    pub fn new(policy: AccessPolicy) -> Result<Self, RuntimeError> {
        let (state_events, _) = broadcast::channel(256);
        let artifacts = ArtifactStore::default();
        let jobs = JobManager::default();
        let runtime = Self {
            registry: CapabilityRegistry::new(policy),
            state: Arc::new(RwLock::new(EditorStore::default())),
            state_events,
            artifacts: artifacts.clone(),
            jobs: jobs.clone(),
            classic_effects: crate::ClassicEffectCatalog::default(),
            classic_masks: crate::ClassicMaskCatalog::default(),
            classic_animation: crate::ClassicAnimationCatalog::default(),
        };
        let state = Arc::downgrade(&runtime.state);
        runtime
            .registry
            .set_document_resolver(Arc::new(move |input, context| {
                let state = state.upgrade().ok_or(RegistryError::LockPoisoned)?;
                let store = state.read().map_err(|_| RegistryError::LockPoisoned)?;
                let project_id = input
                    .get("projectId")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| {
                        context
                            .metadata
                            .get("opencut/projectId")
                            .and_then(serde_json::Value::as_str)
                    });
                Ok(store
                    .document_for(project_id)
                    .and_then(|doc| doc.project.as_ref())
                    .map(|project| {
                        if project.classic.is_some() {
                            crate::DocumentKind::Classic
                        } else {
                            crate::DocumentKind::Rewrite
                        }
                    }))
            }))?;
        operations::register_all(
            &runtime.registry,
            runtime.state.clone(),
            runtime.state_events.clone(),
            artifacts,
            jobs,
            runtime.classic_effects.clone(),
            runtime.classic_masks.clone(),
            runtime.classic_animation.clone(),
        )?;
        Ok(runtime)
    }

    pub fn full_access() -> Result<Self, RuntimeError> {
        Self::new(AccessPolicy::full_local_access())
    }

    pub fn registry(&self) -> &CapabilityRegistry {
        &self.registry
    }

    pub fn classic_effect_catalog(&self) -> &crate::ClassicEffectCatalog {
        &self.classic_effects
    }

    pub fn classic_mask_catalog(&self) -> &crate::ClassicMaskCatalog { &self.classic_masks }
    pub fn classic_animation_catalog(&self) -> &crate::ClassicAnimationCatalog { &self.classic_animation }

    pub fn artifacts(&self) -> &ArtifactStore {
        &self.artifacts
    }

    /// Binary references in the active project's document/history are durable
    /// dependencies even when the chat does not display them. Recognize the
    /// common ArtifactRef shape plus the established artifactId/SHA binding.
    pub fn referenced_artifact_ids(&self, project_id: &str) -> Result<Vec<String>, RuntimeError> {
        fn collect(value: &serde_json::Value, pairs: &mut BTreeMap<String, std::collections::BTreeSet<String>>) {
            match value {
                serde_json::Value::Object(fields) => {
                    let id = fields.get("artifactId").and_then(serde_json::Value::as_str)
                        .or_else(|| fields.get("id").and_then(serde_json::Value::as_str)
                            .filter(|id| fields.get("uri").and_then(serde_json::Value::as_str)
                                == Some(format!("{}{}", crate::ARTIFACT_URI_PREFIX, id).as_str())));
                    if let (Some(id), Some(sha)) = (id, fields.get("sha256").and_then(serde_json::Value::as_str)) {
                        if id.starts_with("artifact-") && id.len() <= 160 && sha.len() == 64 {
                            pairs.entry(id.into()).or_default().insert(sha.into());
                        }
                    }
                    for value in fields.values() { collect(value, pairs); }
                }
                serde_json::Value::Array(items) => { for item in items { collect(item, pairs); } }
                _ => {}
            }
        }
        let store = self.state.read().map_err(|_| RuntimeError::LockPoisoned)?;
        if store.active_project_id() != Some(project_id) { return Err(RuntimeError::UnknownProject(project_id.into())); }
        let mut pairs = BTreeMap::new();
        for document in std::iter::once(store.document.clone()).chain(store.undo.iter().map(|entry| entry.document.materialize())).chain(store.redo.iter().map(|entry| entry.document.materialize())) {
            if document.project.as_ref().is_none_or(|project| project.id != project_id) { continue; }
            collect(&serde_json::to_value(&document.project)?, &mut pairs);
            collect(&serde_json::to_value(&document.extensions)?, &mut pairs);
            collect(&serde_json::to_value(&document.workspace)?, &mut pairs);
        }
        for (id, hashes) in &pairs {
            match self.artifacts.get(id) {
                Ok(artifact) if hashes.iter().any(|sha| artifact.metadata.sha256 != *sha) => return Err(crate::ArtifactError::InvalidArchive("Document/history artifact checksum differs from stored bytes".into()).into()),
                Ok(_) | Err(crate::ArtifactError::NotFound(_)) => {},
                Err(error) => return Err(error.into()),
            }
        }
        Ok(pairs.into_keys().collect())
    }

    pub fn jobs(&self) -> &JobManager {
        &self.jobs
    }

    pub fn register(&self, capability: Arc<dyn Capability>) -> Result<(), RuntimeError> {
        self.registry.register(capability)?;
        Ok(())
    }

    /// Read-only typed snapshot for the desktop UI and other in-process views.
    pub fn snapshot(&self) -> Result<EditorDocument, RuntimeError> {
        Ok(self
            .state
            .read()
            .map_err(|_| RuntimeError::LockPoisoned)?
            .document
            .clone())
    }

    pub fn snapshot_project(&self, project_id: &str) -> Result<EditorDocument, RuntimeError> {
        self.state
            .read()
            .map_err(|_| RuntimeError::LockPoisoned)?
            .document_for(Some(project_id))
            .cloned()
            .ok_or_else(|| RuntimeError::UnknownProject(project_id.to_owned()))
    }

    pub fn sessions(&self) -> Result<Vec<ProjectSessionInfo>, RuntimeError> {
        Ok(self
            .state
            .read()
            .map_err(|_| RuntimeError::LockPoisoned)?
            .session_infos())
    }

    pub fn save_application_state(&self, path: impl AsRef<Path>) -> Result<(), RuntimeError> {
        atomic_write(path.as_ref(), &self.serialize_application_state()?)?;
        Ok(())
    }

    /// Portable session bytes for host-owned storage (IndexedDB, files, etc.).
    /// Storage handles and implementation stay outside the editor runtime.
    pub fn serialize_application_state(&self) -> Result<Vec<u8>, RuntimeError> {
        self.serialize_session(false)
    }

    /// Opt-in bounded history persistence for hosts which need durable Undo.
    /// The existing default serializer remains document-only.
    pub fn serialize_application_state_with_history(&self) -> Result<Vec<u8>, RuntimeError> {
        self.serialize_session(true)
    }

    fn serialize_session(&self, history: bool) -> Result<Vec<u8>, RuntimeError> {
        let store = self.state.read().map_err(|_| RuntimeError::LockPoisoned)?;
        let persisted = PersistedApplicationState {
            version: 1,
            active: PersistedSession {
                document: store.document.clone(),
                undo: if history { store.undo.clone() } else { Vec::new() },
                redo: if history { store.redo.clone() } else { Vec::new() },
                last_saved_revision: store.last_saved_revision,
                opened_at_ms: store.active_opened_at_ms,
                last_opened_at_ms: now_ms(),
                thumbnail_uri: store.active_thumbnail_uri.clone(),
            },
            inactive: store
                .inactive_sessions
                .values()
                .map(|session| PersistedSession {
                    document: session.document.clone(),
                    undo: if history { session.undo.clone() } else { Vec::new() },
                    redo: if history { session.redo.clone() } else { Vec::new() },
                    last_saved_revision: session.last_saved_revision,
                    opened_at_ms: session.opened_at_ms,
                    last_opened_at_ms: session.last_opened_at_ms,
                    thumbnail_uri: session.thumbnail_uri.clone(),
                })
                .collect(),
            recent_projects: store.recent_projects.clone(),
        };
        drop(store);
        let bytes = if history { serde_json::to_vec(&persisted)? } else { serde_json::to_vec_pretty(&persisted)? };
        if history && bytes.len() > 128 * 1024 * 1024 {
            return Err(crate::ModelError::Invalid("Session history exceeds 128 MiB".into()).into());
        }
        Ok(bytes)
    }

    pub fn restore_application_state(&self, path: impl AsRef<Path>) -> Result<bool, RuntimeError> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(false);
        }
        let bytes = std::fs::read(path)?;
        self.restore_application_state_from_bytes(&bytes)?;
        Ok(true)
    }

    /// Validate and migrate the entire session before replacing live state.
    pub fn restore_application_state_from_bytes(&self, bytes: &[u8]) -> Result<(), RuntimeError> {
        let mut persisted: PersistedApplicationState = serde_json::from_slice(bytes)?;
        if persisted.version != 1 {
            return Err(RuntimeError::UnsupportedSessionVersion(persisted.version));
        }
        persisted.active.document.migrate_to_current()?;
        persisted.active.document.validate()?;
        for session in &mut persisted.inactive {
            session.document.migrate_to_current()?;
            session.document.validate()?;
        }
        for session in std::iter::once(&mut persisted.active).chain(persisted.inactive.iter_mut()) {
            session.document.agent_policy.computer_access = false;
            if session.undo.len() + session.redo.len() > 1000 {
                return Err(crate::ModelError::Invalid("Too many persisted history entries".into()).into());
            }
            let project_id = session.document.project.as_ref().map(|p| &p.id);
            for entry in session.undo.iter_mut().chain(session.redo.iter_mut()) {
                let mut document = entry.document.materialize();
                document.migrate_to_current()?;
                document.validate()?;
                if document.project.as_ref().map(|p| &p.id) != project_id {
                    return Err(crate::ModelError::Invalid("History belongs to another project".into()).into());
                }
                entry.document = document.into();
            }
        }
        let mut inactive_sessions = BTreeMap::new();
        for session in persisted.inactive {
            let Some(project_id) = session
                .document
                .project
                .as_ref()
                .map(|project| project.id.clone())
            else {
                continue;
            };
            inactive_sessions.insert(
                project_id,
                StoredProjectSession {
                    document: session.document,
                    undo: session.undo,
                    redo: session.redo,
                    last_saved_revision: session.last_saved_revision,
                    opened_at_ms: session.opened_at_ms,
                    last_opened_at_ms: session.last_opened_at_ms,
                    thumbnail_uri: session.thumbnail_uri,
                },
            );
        }
        let mut store = self.state.write().map_err(|_| RuntimeError::LockPoisoned)?;
        // A receipt from the previous live session must not swallow a write
        // after restoring an older saved revision into this same runtime.
        self.registry.clear_idempotency()?;
        store.document = persisted.active.document;
        store.undo = persisted.active.undo;
        store.redo = persisted.active.redo;
        store.last_saved_revision = persisted.active.last_saved_revision;
        store.active_opened_at_ms = persisted.active.opened_at_ms;
        store.active_thumbnail_uri = persisted.active.thumbnail_uri;
        store.inactive_sessions = inactive_sessions;
        store.recent_projects = persisted.recent_projects;
        let revision = store.document.revision;
        drop(store);
        let _ = self.state_events.send(revision);
        Ok(())
    }

    pub fn begin_atomic(&self) -> Result<RuntimeCheckpoint, RuntimeError> {
        Ok(RuntimeCheckpoint {
            store: self
                .state
                .read()
                .map_err(|_| RuntimeError::LockPoisoned)?
                .clone(),
            idempotency: self.registry.checkpoint_idempotency()?,
        })
    }

    pub fn rollback_atomic(&self, checkpoint: RuntimeCheckpoint) -> Result<(), RuntimeError> {
        let mut store = self.state.write().map_err(|_| RuntimeError::LockPoisoned)?;
        self.registry.restore_idempotency(checkpoint.idempotency)?;
        *store = checkpoint.store;
        Ok(())
    }

    pub fn commit_atomic(
        &self,
        checkpoint: RuntimeCheckpoint,
        label: impl Into<String>,
    ) -> Result<u64, RuntimeError> {
        self.commit_atomic_with_context(checkpoint, label, Default::default())
    }

    /// Presentation context follows the same canonical undo entry as the edit.
    pub fn commit_atomic_with_context(
        &self,
        checkpoint: RuntimeCheckpoint,
        label: impl Into<String>,
        host_context: serde_json::Map<String, serde_json::Value>,
    ) -> Result<u64, RuntimeError> {
        let mut store = self.state.write().map_err(|_| RuntimeError::LockPoisoned)?;
        if store.active_project_id() != checkpoint.store.active_project_id() {
            return Err(RuntimeError::TransactionProjectChanged);
        }
        if store.document == checkpoint.store.document {
            return Ok(store.document.revision);
        }
        store.undo = checkpoint.store.undo;
        store.undo.push(HistoryEntry {
            label: label.into(),
            document: checkpoint.store.document.into(),
            host_context,
        });
        super::operations::trim_history(&mut store.undo);
        store.redo.clear();
        let revision = store.document.revision;
        drop(store);
        let _ = self.state_events.send(revision);
        self.registry.notify_resources_changed(vec![
            "opencut://state".into(),
            "opencut://project".into(),
            "opencut://timeline".into(),
        ])?;
        Ok(revision)
    }

    /// Receive the new document revision after each committed edit.
    pub fn subscribe_state(&self) -> broadcast::Receiver<u64> {
        self.state_events.subscribe()
    }
}

impl Default for OpenCutRuntime {
    fn default() -> Self {
        Self::full_access().expect("built-in OpenCut capabilities must be valid")
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Artifact(#[from] crate::ArtifactError),
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error("editor state lock was poisoned")]
    LockPoisoned,
    #[error("project `{0}` is not open")]
    UnknownProject(String),
    #[error("an atomic transaction cannot change the active project")]
    TransactionProjectChanged,
    #[error("unsupported OpenCut application-session version {0}")]
    UnsupportedSessionVersion(u32),
    #[error("session persistence failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("session serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Model(#[from] crate::ModelError),
}

pub(crate) fn now_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        std::fs::create_dir_all(parent)?;
    }
    let directory = parent.unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod compact_history_tests {
    use super::*;

    #[test]
    fn classic_history_is_lossless_shared_text_and_keeps_persistence_shape() {
        let mut document = EditorDocument::default();
        // Deserialize a valid project via the same canonical boundary used by hosts.
        let classic: crate::ClassicProject = serde_json::from_str(include_str!("../tests/fixtures/classic-project.json")).unwrap();
        let project = crate::Project {
            id: classic.id().unwrap().to_owned(), name: classic.name().unwrap().to_owned(),
            file_path: None, settings: classic.settings().unwrap(), assets: vec![],
            timeline: crate::Timeline::default(), classic: Some(classic),
            metadata: BTreeMap::new(), export_presets: vec![], extensions: serde_json::Map::new(),
        };
        document.project = Some(project);
        document.revision = 42;
        let expected = serde_json::to_value(&document).unwrap();
        let stored = HistoryDocument::from(document);
        assert!(stored.is_classic());
        assert_eq!(stored.revision(), 42);
        let cloned = stored.clone();
        match (&stored, &cloned) {
            (HistoryDocument::Classic { json: a, .. }, HistoryDocument::Classic { json: b, .. }) => assert!(Arc::ptr_eq(a, b)),
            _ => panic!("Classic history must not retain expanded document trees"),
        }
        assert_eq!(serde_json::to_value(&stored).unwrap(), expected);
        let reopened: HistoryDocument = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(reopened.materialize()).unwrap(), expected);
    }
}
