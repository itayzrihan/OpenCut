use std::{
    collections::BTreeMap,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{ArtifactRef, InvocationReceipt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub capability_id: String,
    pub actor: Option<String>,
    pub status: JobStatus,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub progress: Option<f64>,
    pub message: Option<String>,
    pub receipt: Option<InvocationReceipt>,
    pub error: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRef>,
}

#[derive(Clone, Default)]
pub struct JobManager {
    inner: Arc<RwLock<JobState>>,
}

#[derive(Default)]
struct JobState {
    next_id: u64,
    jobs: BTreeMap<String, ManagedJob>,
}

struct ManagedJob {
    record: JobRecord,
    cancellation: CancellationToken,
}

impl JobManager {
    pub fn create(
        &self,
        capability_id: impl Into<String>,
        actor: Option<String>,
    ) -> Result<(JobRecord, CancellationToken), String> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| "job manager lock was poisoned".to_owned())?;
        state.next_id += 1;
        let id = format!("job-{}-{}", now_ms(), state.next_id);
        let cancellation = CancellationToken::new();
        let record = JobRecord {
            id: id.clone(),
            capability_id: capability_id.into(),
            actor,
            status: JobStatus::Queued,
            created_at_ms: now_ms(),
            started_at_ms: None,
            finished_at_ms: None,
            progress: Some(0.0),
            message: Some("Queued".into()),
            receipt: None,
            error: None,
            artifacts: Vec::new(),
        };
        state.jobs.insert(
            id,
            ManagedJob {
                record: record.clone(),
                cancellation: cancellation.clone(),
            },
        );
        Ok((record, cancellation))
    }

    pub fn mark_running(&self, id: &str) {
        self.update(id, |job| {
            job.status = JobStatus::Running;
            job.started_at_ms = Some(now_ms());
            job.progress = None;
            job.message = Some("Running".into());
        });
    }

    pub fn succeed(&self, id: &str, receipt: InvocationReceipt) {
        self.update(id, |job| {
            job.status = JobStatus::Succeeded;
            job.finished_at_ms = Some(now_ms());
            job.progress = Some(1.0);
            job.message = receipt
                .result
                .summary
                .clone()
                .or_else(|| Some("Completed".into()));
            job.artifacts = receipt.result.artifacts.clone();
            job.receipt = Some(receipt);
            job.error = None;
        });
    }

    pub fn fail(&self, id: &str, error: String) {
        self.update(id, |job| {
            job.status = JobStatus::Failed;
            job.finished_at_ms = Some(now_ms());
            job.message = Some("Failed".into());
            job.error = Some(error);
        });
    }

    pub fn mark_cancelled(&self, id: &str) {
        self.update(id, |job| {
            job.status = JobStatus::Cancelled;
            job.finished_at_ms = Some(now_ms());
            job.message = Some("Cancelled".into());
            job.error = None;
        });
    }

    pub fn cancel(&self, id: &str) -> Result<JobRecord, String> {
        let state = self
            .inner
            .read()
            .map_err(|_| "job manager lock was poisoned".to_owned())?;
        let job = state
            .jobs
            .get(id)
            .ok_or_else(|| format!("job `{id}` was not found"))?;
        job.cancellation.cancel();
        let record = job.record.clone();
        drop(state);
        if matches!(record.status, JobStatus::Queued | JobStatus::Running) {
            self.mark_cancelled(id);
        }
        self.get(id)
            .ok_or_else(|| format!("job `{id}` was not found"))
    }

    pub fn get(&self, id: &str) -> Option<JobRecord> {
        self.inner
            .read()
            .ok()?
            .jobs
            .get(id)
            .map(|job| job.record.clone())
    }

    pub fn list(&self, status: Option<JobStatus>, limit: usize) -> Vec<JobRecord> {
        let Ok(state) = self.inner.read() else {
            return Vec::new();
        };
        state
            .jobs
            .values()
            .rev()
            .filter(|job| status.is_none_or(|status| job.record.status == status))
            .take(limit.min(500))
            .map(|job| job.record.clone())
            .collect()
    }

    fn update(&self, id: &str, update: impl FnOnce(&mut JobRecord)) {
        if let Ok(mut state) = self.inner.write()
            && let Some(job) = state.jobs.get_mut(id)
        {
            update(&mut job.record);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
