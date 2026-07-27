use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const ARTIFACT_URI_PREFIX: &str = "opencut://artifacts/";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub id: String,
    pub uri: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct StoredArtifact {
    pub metadata: ArtifactRef,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, Clone, Copy)]
pub struct ArtifactLimits {
    pub ttl: Duration,
    pub max_artifact_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for ArtifactLimits {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(15 * 60),
            max_artifact_bytes: 64 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct ArtifactStore {
    inner: Arc<Mutex<ArtifactState>>,
    limits: ArtifactLimits,
}

struct ArtifactState {
    next_id: u64,
    access_clock: u64,
    total_bytes: u64,
    entries: BTreeMap<String, ArtifactEntry>,
}

struct ArtifactEntry {
    artifact: StoredArtifact,
    last_access: u64,
}

impl Default for ArtifactStore {
    fn default() -> Self {
        Self::new(ArtifactLimits::default())
    }
}

impl ArtifactStore {
    pub fn new(limits: ArtifactLimits) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ArtifactState {
                next_id: 1,
                access_clock: 1,
                total_bytes: 0,
                entries: BTreeMap::new(),
            })),
            limits,
        }
    }

    pub fn put(
        &self,
        bytes: Vec<u8>,
        mime_type: impl Into<String>,
        width: Option<u32>,
        height: Option<u32>,
        duration_ms: Option<u64>,
    ) -> Result<ArtifactRef, ArtifactError> {
        if bytes.len() as u64 > self.limits.max_artifact_bytes {
            return Err(ArtifactError::TooLarge {
                size: bytes.len() as u64,
                limit: self.limits.max_artifact_bytes,
            });
        }
        let now = now_ms();
        let mut state = self.inner.lock().map_err(|_| ArtifactError::LockPoisoned)?;
        prune_expired(&mut state, now);
        while state.total_bytes + bytes.len() as u64 > self.limits.max_total_bytes {
            let Some(oldest_id) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            remove_entry(&mut state, &oldest_id);
        }
        let id = format!("artifact-{}-{:#x}", now, state.next_id).replace("0x", "");
        state.next_id += 1;
        state.access_clock += 1;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let metadata = ArtifactRef {
            uri: format!("{ARTIFACT_URI_PREFIX}{id}"),
            id: id.clone(),
            mime_type: mime_type.into(),
            byte_size: bytes.len() as u64,
            sha256,
            created_at_ms: now,
            expires_at_ms: now.saturating_add(self.limits.ttl.as_millis() as u64),
            width,
            height,
            duration_ms,
        };
        state.total_bytes += metadata.byte_size;
        let last_access = state.access_clock;
        state.entries.insert(
            id,
            ArtifactEntry {
                artifact: StoredArtifact {
                    metadata: metadata.clone(),
                    bytes: bytes.into(),
                },
                last_access,
            },
        );
        Ok(metadata)
    }

    pub fn get(&self, id_or_uri: &str) -> Result<StoredArtifact, ArtifactError> {
        let id = id_or_uri
            .strip_prefix(ARTIFACT_URI_PREFIX)
            .unwrap_or(id_or_uri);
        let now = now_ms();
        let mut state = self.inner.lock().map_err(|_| ArtifactError::LockPoisoned)?;
        prune_expired(&mut state, now);
        state.access_clock += 1;
        let access_clock = state.access_clock;
        let entry = state
            .entries
            .get_mut(id)
            .ok_or_else(|| ArtifactError::NotFound(id.to_owned()))?;
        entry.last_access = access_clock;
        Ok(entry.artifact.clone())
    }

    pub fn list(&self) -> Result<Vec<ArtifactRef>, ArtifactError> {
        let now = now_ms();
        let mut state = self.inner.lock().map_err(|_| ArtifactError::LockPoisoned)?;
        prune_expired(&mut state, now);
        Ok(state
            .entries
            .values()
            .map(|entry| entry.artifact.metadata.clone())
            .collect())
    }

    pub fn remove(&self, id_or_uri: &str) -> Result<bool, ArtifactError> {
        let id = id_or_uri
            .strip_prefix(ARTIFACT_URI_PREFIX)
            .unwrap_or(id_or_uri);
        let mut state = self.inner.lock().map_err(|_| ArtifactError::LockPoisoned)?;
        Ok(remove_entry(&mut state, id))
    }

    pub fn contains(&self, uri: &str) -> bool {
        self.get(uri).is_ok()
    }
}

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("artifact `{0}` was not found or has expired")]
    NotFound(String),
    #[error("artifact contains {size} bytes, exceeding the {limit}-byte limit")]
    TooLarge { size: u64, limit: u64 },
    #[error("artifact store lock was poisoned")]
    LockPoisoned,
}

fn prune_expired(state: &mut ArtifactState, now: u64) {
    let expired: Vec<_> = state
        .entries
        .iter()
        .filter(|(_, entry)| entry.artifact.metadata.expires_at_ms <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        remove_entry(state, &id);
    }
}

fn remove_entry(state: &mut ArtifactState, id: &str) -> bool {
    let Some(entry) = state.entries.remove(id) else {
        return false;
    };
    state.total_bytes = state
        .total_bytes
        .saturating_sub(entry.artifact.metadata.byte_size);
    true
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifacts_are_addressable_and_bounded() {
        let store = ArtifactStore::new(ArtifactLimits {
            ttl: Duration::from_secs(60),
            max_artifact_bytes: 4,
            max_total_bytes: 6,
        });
        let first = store
            .put(vec![1, 2, 3], "image/png", Some(1), Some(1), None)
            .unwrap();
        let second = store
            .put(vec![4, 5, 6], "image/png", Some(1), Some(1), None)
            .unwrap();
        assert!(store.get(&first.uri).is_ok());
        store
            .put(vec![7, 8, 9], "image/png", Some(1), Some(1), None)
            .unwrap();
        assert!(store.get(&second.uri).is_err());
        assert!(matches!(
            store.put(vec![0; 5], "image/png", None, None, None),
            Err(ArtifactError::TooLarge { .. })
        ));
    }
}
