use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
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
    pub document: EditorDocument,
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
}

#[derive(Clone)]
pub struct RuntimeCheckpoint {
    store: EditorStore,
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
        };
        operations::register_all(
            &runtime.registry,
            runtime.state.clone(),
            runtime.state_events.clone(),
            artifacts,
            jobs,
        )?;
        Ok(runtime)
    }

    pub fn full_access() -> Result<Self, RuntimeError> {
        Self::new(AccessPolicy::full_local_access())
    }

    pub fn registry(&self) -> &CapabilityRegistry {
        &self.registry
    }

    pub fn artifacts(&self) -> &ArtifactStore {
        &self.artifacts
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
        let store = self.state.read().map_err(|_| RuntimeError::LockPoisoned)?;
        let persisted = PersistedApplicationState {
            version: 1,
            active: PersistedSession {
                document: store.document.clone(),
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
                    last_saved_revision: session.last_saved_revision,
                    opened_at_ms: session.opened_at_ms,
                    last_opened_at_ms: session.last_opened_at_ms,
                    thumbnail_uri: session.thumbnail_uri.clone(),
                })
                .collect(),
            recent_projects: store.recent_projects.clone(),
        };
        drop(store);
        let bytes = serde_json::to_vec_pretty(&persisted)?;
        atomic_write(path.as_ref(), &bytes)?;
        Ok(())
    }

    pub fn restore_application_state(&self, path: impl AsRef<Path>) -> Result<bool, RuntimeError> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(false);
        }
        let bytes = std::fs::read(path)?;
        let mut persisted: PersistedApplicationState = serde_json::from_slice(&bytes)?;
        if persisted.version != 1 {
            return Err(RuntimeError::UnsupportedSessionVersion(persisted.version));
        }
        persisted.active.document.migrate_to_current()?;
        persisted.active.document.validate()?;
        for session in &mut persisted.inactive {
            session.document.migrate_to_current()?;
            session.document.validate()?;
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
                    undo: Vec::new(),
                    redo: Vec::new(),
                    last_saved_revision: session.last_saved_revision,
                    opened_at_ms: session.opened_at_ms,
                    last_opened_at_ms: session.last_opened_at_ms,
                    thumbnail_uri: session.thumbnail_uri,
                },
            );
        }
        let mut store = self.state.write().map_err(|_| RuntimeError::LockPoisoned)?;
        store.document = persisted.active.document;
        store.undo.clear();
        store.redo.clear();
        store.last_saved_revision = persisted.active.last_saved_revision;
        store.active_opened_at_ms = persisted.active.opened_at_ms;
        store.active_thumbnail_uri = persisted.active.thumbnail_uri;
        store.inactive_sessions = inactive_sessions;
        store.recent_projects = persisted.recent_projects;
        let revision = store.document.revision;
        drop(store);
        let _ = self.state_events.send(revision);
        Ok(true)
    }

    pub fn begin_atomic(&self) -> Result<RuntimeCheckpoint, RuntimeError> {
        Ok(RuntimeCheckpoint {
            store: self
                .state
                .read()
                .map_err(|_| RuntimeError::LockPoisoned)?
                .clone(),
        })
    }

    pub fn rollback_atomic(&self, checkpoint: RuntimeCheckpoint) -> Result<(), RuntimeError> {
        *self.state.write().map_err(|_| RuntimeError::LockPoisoned)? = checkpoint.store;
        Ok(())
    }

    pub fn commit_atomic(
        &self,
        checkpoint: RuntimeCheckpoint,
        label: impl Into<String>,
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
            document: checkpoint.store.document,
        });
        super::operations::trim_history(&mut store.undo);
        store.redo.clear();
        let revision = store.document.revision;
        drop(store);
        let _ = self.state_events.send(revision);
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
