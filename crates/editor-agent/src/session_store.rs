//! Host-independent ownership and atomic save policy. Hosts lock one project
//! record, apply a transition, then replace that record atomically. The record
//! contains the canonical archive and run checkpoint in one commit.
use crate::{AgentError, RuntimeAgent, register_knowledge_capabilities};
use opencut_editor_api::{AccessLevel, HostBridge, InvocationContext, OpenCutRuntime};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

const MAX_BYTES: usize = 120_000_000;
const LEASE_MS: u64 = 90_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBundle {
    pub archive: Value,
    pub agent_checkpoint: Option<String>,
    /// Derived library artwork; excluded from canonical editing and run hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub conversation: Option<crate::ConversationArchive>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub artifacts: Option<crate::ScopedArtifactArchive>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLease {
    pub session_id: String,
    pub generation: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedSession {
    pub editor_revision: u64,
    /// Materialized from the validated canonical archive, never accepted as an
    /// independently mutable UI document.
    pub project: Value,
    pub bundle: SessionBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReceipt {
    pub storage_revision: u64,
    pub editor_revision: u64,
    pub request_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retry {
    fingerprint: String,
    receipt: SessionReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRecord {
    schema_version: u32,
    account_id: String,
    project_id: String,
    pub storage_revision: u64,
    pub generation: u64,
    pub lease: Option<SessionLease>,
    last_host_time_ms: u64,
    pub saved: Option<SavedSession>,
    retries: Vec<Retry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionRequest {
    Read,
    /// Host-only authorization for publishing project assets. The host holds
    /// the same project lock until the side effect has finished.
    AssertWrite {
        session_id: Option<String>,
        generation: Option<u64>,
    },
    Acquire {
        session_id: String,
        expected_generation: u64,
        take_over: bool,
    },
    Renew {
        session_id: String,
        generation: u64,
    },
    Release {
        session_id: String,
        generation: u64,
    },
    Commit {
        session_id: String,
        generation: u64,
        expected_storage_revision: u64,
        request_id: String,
        bundle: SessionBundle,
    },
}

impl SessionRecord {
    pub fn new(account_id: String, project_id: String) -> Result<Self, AgentError> {
        id(&account_id)?;
        id(&project_id)?;
        Ok(Self {
            schema_version: 1,
            account_id,
            project_id,
            storage_revision: 0,
            generation: 0,
            lease: None,
            last_host_time_ms: 0,
            saved: None,
            retries: vec![],
        })
    }
    pub fn from_json(account_id: &str, project_id: &str, json: &str) -> Result<Self, AgentError> {
        if json.len() > MAX_BYTES {
            return Err(error("session storage quota exceeded"));
        }
        let record: Self = serde_json::from_str(json).map_err(error)?;
        record.authorize(account_id, project_id)?;
        if record.schema_version != 1
            || record.retries.len() > 128
            || record
                .lease
                .as_ref()
                .is_some_and(|l| l.generation != record.generation)
        {
            return Err(error("invalid saved session record"));
        }
        Ok(record)
    }
    pub fn to_json(&self) -> Result<String, AgentError> {
        let json = serde_json::to_string(self).map_err(error)?;
        if json.len() > MAX_BYTES {
            return Err(error("session storage quota exceeded"));
        }
        Ok(json)
    }
    fn authorize(&self, account_id: &str, project_id: &str) -> Result<(), AgentError> {
        if self.account_id != account_id || self.project_id != project_id {
            return Err(AgentError::Denied(
                "session belongs to another account or project".into(),
            ));
        }
        Ok(())
    }
    fn require_lease(&self, session_id: &str, generation: u64, now: u64) -> Result<(), AgentError> {
        id(session_id)?;
        if !self.lease.as_ref().is_some_and(|l| {
            l.session_id == session_id && l.generation == generation && l.expires_at_ms > now
        }) {
            return Err(error(
                "editor ownership expired or was transferred; reopen the latest project before writing",
            ));
        }
        Ok(())
    }
    pub fn apply(
        &mut self,
        account_id: &str,
        project_id: &str,
        request: SessionRequest,
        now_ms: u64,
    ) -> Result<Value, AgentError> {
        self.authorize(account_id, project_id)?;
        let mut next = self.clone();
        let result = next.transition(request, now_ms)?;
        next.to_json()?;
        *self = next;
        Ok(result)
    }
    fn transition(&mut self, request: SessionRequest, now_ms: u64) -> Result<Value, AgentError> {
        if now_ms > 9_007_199_254_000_000 {
            return Err(error("invalid host clock"));
        }
        // Wall-clock rollback cannot extend a lease that was already observed
        // expired. Time and identity always originate at the authenticated host.
        let now = now_ms.max(self.last_host_time_ms);
        let result = match request {
            SessionRequest::Read => {
                json!({"storageRevision":self.storage_revision,"generation":self.generation,"lease":self.lease.as_ref().filter(|l|l.expires_at_ms>now),"saved":self.saved})
            }
            SessionRequest::AssertWrite {
                session_id,
                generation,
            } => {
                match (self.generation, session_id, generation) {
                    (0, None, None) => {} // Legacy project, not yet adopted.
                    (_, Some(session), Some(generation)) => {
                        self.require_lease(&session, generation, now)?;
                    }
                    _ => {
                        return Err(error(
                            "editor ownership is required for project asset writes",
                        ));
                    }
                }
                json!({"writable":true,"generation":self.generation})
            }
            SessionRequest::Acquire {
                session_id,
                expected_generation,
                take_over,
            } => {
                id(&session_id)?;
                if expected_generation != self.generation {
                    return Err(error(
                        "ownership generation changed; read the current owner first",
                    ));
                }
                if self
                    .lease
                    .as_ref()
                    .is_some_and(|l| l.expires_at_ms > now && l.session_id != session_id)
                    && !take_over
                {
                    return Err(error("another editor owns this project"));
                }
                // Every explicit acquisition creates a new fence, even for the
                // same tab after expiry. Old requests never regain authority.
                self.generation = self
                    .generation
                    .checked_add(1)
                    .filter(|v| *v < 9_007_199_254_740_991)
                    .ok_or_else(|| error("ownership generation exhausted"))?;
                self.lease = Some(SessionLease {
                    session_id,
                    generation: self.generation,
                    expires_at_ms: now + LEASE_MS,
                });
                json!({"storageRevision":self.storage_revision,"generation":self.generation,"lease":self.lease,"saved":self.saved})
            }
            SessionRequest::Renew {
                session_id,
                generation,
            } => {
                self.require_lease(&session_id, generation, now)?;
                self.lease.as_mut().expect("validated lease").expires_at_ms = now + LEASE_MS;
                json!({"storageRevision":self.storage_revision,"lease":self.lease})
            }
            SessionRequest::Release {
                session_id,
                generation,
            } => {
                self.require_lease(&session_id, generation, now)?;
                self.lease = None;
                json!({"storageRevision":self.storage_revision,"released":true})
            }
            SessionRequest::Commit {
                session_id,
                generation,
                expected_storage_revision,
                request_id,
                bundle,
            } => {
                self.require_lease(&session_id, generation, now)?;
                id(&request_id)?;
                let fingerprint = format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&json!([
                            session_id,
                            generation,
                            expected_storage_revision,
                            bundle
                        ]))
                        .map_err(error)?
                    )
                );
                if let Some(retry) = self
                    .retries
                    .iter()
                    .find(|r| r.receipt.request_id == request_id)
                {
                    if retry.fingerprint != fingerprint {
                        return Err(error(
                            "save request identity was reused with different data",
                        ));
                    }
                    // Successful owner activity must not expire behind queued saves.
                    self.lease.as_mut().expect("validated lease").expires_at_ms = now + LEASE_MS;
                    self.last_host_time_ms = now;
                    return serde_json::to_value(&retry.receipt).map_err(error);
                }
                if expected_storage_revision != self.storage_revision {
                    return Err(error("saved project changed; reload before committing"));
                }
                let saved = validate_bundle(&self.account_id, &self.project_id, bundle)?;
                if let Some(previous) = &self.saved {
                    if saved.editor_revision < previous.editor_revision
                        || (saved.editor_revision == previous.editor_revision
                            && saved.bundle.archive != previous.bundle.archive)
                    {
                        return Err(error(
                            "canonical revision cannot move backward or describe different contents",
                        ));
                    }
                }
                self.storage_revision = self
                    .storage_revision
                    .checked_add(1)
                    .filter(|v| *v < 9_007_199_254_740_991)
                    .ok_or_else(|| error("storage revision exhausted"))?;
                let receipt = SessionReceipt {
                    storage_revision: self.storage_revision,
                    editor_revision: saved.editor_revision,
                    request_id,
                };
                self.saved = Some(saved);
                self.retries.push(Retry {
                    fingerprint,
                    receipt: receipt.clone(),
                });
                if self.retries.len() > 128 {
                    self.retries.remove(0);
                }
                self.lease.as_mut().expect("validated lease").expires_at_ms = now + LEASE_MS;
                serde_json::to_value(receipt).map_err(error)?
            }
        };
        self.last_host_time_ms = now;
        Ok(result)
    }
}

fn validate_bundle(
    account_id: &str,
    project_id: &str,
    bundle: SessionBundle,
) -> Result<SavedSession, AgentError> {
    if bundle
        .thumbnail
        .as_ref()
        .is_some_and(|value| value.len() > 2_000_000)
    {
        return Err(error("project thumbnail exceeds its storage limit"));
    }
    let runtime = OpenCutRuntime::default();
    let mut future = std::pin::pin!(runtime.registry().invoke(
        "project.classic.session.restore",
        InvocationContext::default(),
        json!({"projectId":project_id,"expectedRevision":0,"archive":bundle.archive})
    ));
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => {
            result.map_err(error)?;
        }
        Poll::Pending => {
            return Err(error(
                "canonical archive restoration unexpectedly suspended",
            ));
        }
    };
    let state = runtime.snapshot().map_err(error)?;
    if let Some(conversation)=&bundle.conversation {conversation.validate(account_id,project_id)?;}
    if let Some(artifacts)=&bundle.artifacts {artifacts.restore(account_id,project_id,runtime.artifacts())?;}
    if let Some(checkpoint) = &bundle.agent_checkpoint {
        let bridge = HostBridge::default();
        register_knowledge_capabilities(runtime.registry(), &bridge).map_err(error)?;
        // Install the same editor contracts, without dispatching any host IO.
        opencut_editor_api::register_editor_host_capabilities(&runtime, &bridge).map_err(error)?;
        opencut_editor_api::register_editor_screenshot_capability(&runtime, &bridge).map_err(error)?;
        RuntimeAgent::restore_checkpoint(
            runtime.clone(),
            account_id,
            project_id,
            AccessLevel::Write,
            Some(bridge),
            checkpoint,
        )?;
    }
    let classic = state
        .project
        .and_then(|p| p.classic)
        .ok_or_else(|| error("saved session is not a Classic project"))?;
    let mut project = serde_json::to_value(classic.document).map_err(error)?;
    if let Some(thumbnail) = &bundle.thumbnail {
        project["metadata"]["thumbnail"] = json!(thumbnail);
    }
    Ok(SavedSession {
        editor_revision: state.revision,
        project,
        bundle,
    })
}
fn id(value: &str) -> Result<(), AgentError> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(error("invalid session identity"))
    } else {
        Ok(())
    }
}
fn error(message: impl std::fmt::Display) -> AgentError {
    AgentError::Conflict(message.to_string())
}
