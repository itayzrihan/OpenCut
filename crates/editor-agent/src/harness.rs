use opencut_editor_api::{AccessLevel, DocumentKind, RegistrySnapshot};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AgentError, AgentScope, LoadedContracts, PreparedInvocation, ReceiptReference};

/// Serializable orchestration only. The authenticated host supplies the scope,
/// editor observations and receipts; model output cannot supply those events.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRun {
    scope: AgentScope,
    kind: DocumentKind,
    request: String,
    steering: Vec<String>,
    plan: Vec<PlanStep>,
    contracts: LoadedContracts,
    phase: RunPhase,
    epoch: u64,
    revision: Option<u64>,
    verified_revision: Option<u64>,
    pending: Option<PendingInvocation>,
    receipts: Vec<ReceiptReference>,
    used_call_ids: Vec<String>,
    max_access: AccessLevel,
    allow_open_world: bool,
    final_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunPhase {
    NeedsObservation,
    Ready,
    AwaitingTool,
    NeedsVerification,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub title: String,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingInvocation {
    pub call_id: String,
    pub invocation: PreparedInvocation,
    pub expected_revision: u64,
}

/// A host-validated result, not a provider tool argument. Unknown means the
/// transport lost the response and must reconcile the SAME idempotency key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ToolOutcome {
    ExternalApplied {
        revision: u64,
        artifact_ids: Vec<String>,
    },
    Applied {
        revision: u64,
        artifact_ids: Vec<String>,
    },
    Read {
        revision: u64,
        artifact_ids: Vec<String>,
    },
    Rejected {
        revision: u64,
        message: String,
    },
    Unknown,
}

impl AgentRun {
    pub(crate) fn restore_pending_contracts(&mut self, contracts: LoadedContracts) {
        self.contracts = contracts;
    }
    pub(crate) fn restore_checkpoint_authority(
        &mut self,
        scope: &AgentScope,
        max_access: AccessLevel,
        allow_host: bool,
    ) -> Result<(), AgentError> {
        scope.validate()?;
        if &self.scope != scope {
            return Err(AgentError::Denied(
                "checkpoint belongs to another account, project or run".into(),
            ));
        }
        validate_text(&self.request, 100_000, "request")?;
        if matches!(self.phase, RunPhase::Completed | RunPhase::Failed) && self.pending.is_some() {
            return Err(AgentError::Conflict(
                "a terminal checkpoint cannot discard an unsettled tool".into(),
            ));
        }
        if self.plan.len() > 30
            || self.steering.len() > 1000
            || self.receipts.len() > 10_000
            || self.used_call_ids.len() > 20_000
            || self.epoch >= 9_007_199_254_740_990
        {
            return Err(AgentError::ContextLimit(
                "checkpoint exceeds the run's bounds".into(),
            ));
        }
        for text in &self.steering {
            validate_text(text, 100_000, "steering")?;
        }
        for step in &self.plan {
            validate_text(&step.title, 1000, "plan step")?;
        }
        self.max_access = max_access;
        self.allow_open_world = allow_host;
        self.contracts = LoadedContracts::default();
        self.verified_revision = None;
        if !matches!(self.phase, RunPhase::Completed | RunPhase::Failed) {
            self.phase = RunPhase::Paused;
        }
        self.epoch += 1;
        Ok(())
    }
    pub(crate) fn allow_host_effects(&mut self) {
        self.allow_open_world = true;
    }
    pub(crate) fn invalidate_verification(&mut self) {
        self.verified_revision = None;
        self.epoch += 1;
        if matches!(self.phase, RunPhase::Ready | RunPhase::NeedsVerification) {
            self.phase = RunPhase::NeedsObservation;
        }
    }
    pub fn new(
        scope: AgentScope,
        kind: DocumentKind,
        request: String,
        max_access: AccessLevel,
        allow_open_world: bool,
    ) -> Result<Self, AgentError> {
        scope.validate()?;
        validate_text(&request, 100_000, "request")?;
        Ok(Self {
            scope,
            kind,
            request,
            steering: vec![],
            plan: vec![],
            contracts: LoadedContracts::default(),
            phase: RunPhase::NeedsObservation,
            epoch: 0,
            revision: None,
            verified_revision: None,
            pending: None,
            receipts: vec![],
            used_call_ids: vec![],
            max_access,
            allow_open_world,
            final_message: None,
        })
    }

    pub fn scope(&self) -> &AgentScope {
        &self.scope
    }

    pub fn request(&self) -> &str {
        &self.request
    }
    pub fn steering(&self) -> &[String] {
        &self.steering
    }
    pub fn plan(&self) -> &[PlanStep] {
        &self.plan
    }
    pub fn phase(&self) -> RunPhase {
        self.phase
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }

    pub fn max_access(&self) -> AccessLevel {
        self.max_access
    }
    pub fn pending(&self) -> Option<&PendingInvocation> {
        self.pending.as_ref()
    }
    pub fn receipts(&self) -> &[ReceiptReference] {
        &self.receipts
    }
    pub fn contracts(&self) -> &LoadedContracts {
        &self.contracts
    }
    pub fn final_message(&self) -> Option<&str> {
        self.final_message.as_deref()
    }

    fn check_ready(&self, epoch: u64) -> Result<(), AgentError> {
        if epoch != self.epoch {
            return Err(AgentError::Conflict(
                "provider turn was superseded by steering or editor lifecycle".into(),
            ));
        }
        if !matches!(self.phase, RunPhase::Ready | RunPhase::NeedsVerification)
            || self.pending.is_some()
        {
            return Err(AgentError::Conflict(
                "observe or reconcile the editor before continuing this run".into(),
            ));
        }
        Ok(())
    }

    /// A state read is not visual verification. An external edit invalidates any
    /// previous verification and bumps the epoch so buffered calls cannot run.
    pub fn observe(&mut self, revision: u64) -> Result<(), AgentError> {
        if matches!(
            self.phase,
            RunPhase::Paused | RunPhase::Completed | RunPhase::Failed
        ) || self.pending.is_some()
        {
            return Err(AgentError::Conflict(
                "run cannot accept an observation in this phase".into(),
            ));
        }
        if self.revision.is_some_and(|previous| revision < previous) {
            return Err(AgentError::Conflict(
                "editor observation went backwards".into(),
            ));
        }
        if self.revision != Some(revision) {
            self.verified_revision = None;
            self.epoch += 1;
        }
        self.revision = Some(revision);
        self.phase = if self
            .receipts
            .iter()
            .any(|r| r.committed && !r.external_only)
            && self.verified_revision != Some(revision)
        {
            RunPhase::NeedsVerification
        } else {
            RunPhase::Ready
        };
        Ok(())
    }

    pub fn describe(
        &mut self,
        epoch: u64,
        catalog: &RegistrySnapshot,
        id: &str,
    ) -> Result<opencut_editor_api::CapabilityDescriptor, AgentError> {
        self.check_ready(epoch)?;
        self.contracts.describe(catalog, self.kind, id)
    }

    pub fn set_plan(&mut self, epoch: u64, steps: Vec<PlanStep>) -> Result<(), AgentError> {
        self.check_ready(epoch)?;
        if steps.is_empty() || steps.len() > 30 {
            return Err(AgentError::Invalid("plan must have 1–30 steps".into()));
        }
        for step in &steps {
            validate_text(&step.title, 1000, "plan step")?;
        }
        if steps
            .iter()
            .filter(|s| s.status == PlanStatus::InProgress)
            .count()
            > 1
        {
            return Err(AgentError::Invalid(
                "only one plan step can be in progress".into(),
            ));
        }
        self.plan = steps;
        Ok(())
    }

    pub fn prepare_tool(
        &mut self,
        epoch: u64,
        catalog: &RegistrySnapshot,
        call_id: &str,
        capability_id: &str,
        input: Value,
    ) -> Result<PendingInvocation, AgentError> {
        self.check_ready(epoch)?;
        if self.used_call_ids.iter().any(|id| id == call_id) {
            return Err(AgentError::Conflict(
                "call ID was already used; reconcile pending work or use a new call ID".into(),
            ));
        }
        let revision = self.revision.ok_or_else(|| {
            AgentError::Conflict("read editor state before invoking tools".into())
        })?;
        let invocation = self.contracts.prepare(
            catalog,
            &self.scope,
            self.kind,
            revision,
            call_id,
            capability_id,
            input,
            self.max_access,
        )?;
        let descriptor = catalog
            .capabilities
            .iter()
            .find(|d| d.id == capability_id)
            .expect("prepare checked descriptor");
        if descriptor.open_world && !self.allow_open_world {
            return Err(AgentError::Denied(
                "this run has no authority for external effects".into(),
            ));
        }
        if invocation.mutating && self.plan.is_empty() {
            return Err(AgentError::Invalid(
                "prepare an editing plan before writing".into(),
            ));
        }
        let pending = PendingInvocation {
            call_id: call_id.into(),
            invocation,
            expected_revision: revision,
        };
        self.used_call_ids.push(call_id.into());
        self.pending = Some(pending.clone());
        self.phase = RunPhase::AwaitingTool;
        Ok(pending)
    }

    /// May arrive while paused: an already committed write must retain its
    /// receipt, but must never restart the provider or authorize a second write.
    pub fn settle_tool(&mut self, call_id: &str, outcome: ToolOutcome) -> Result<(), AgentError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| AgentError::Conflict("no tool is awaiting a receipt".into()))?;
        if pending.call_id != call_id {
            return Err(AgentError::Conflict(
                "receipt belongs to another call".into(),
            ));
        }
        if matches!(outcome, ToolOutcome::Unknown) {
            self.phase = RunPhase::Paused;
            self.epoch += 1;
            return Ok(());
        }
        let external_only = matches!(outcome, ToolOutcome::ExternalApplied { .. });
        let (revision, committed, artifacts) = match outcome {
            ToolOutcome::ExternalApplied {
                revision,
                artifact_ids,
            } if pending.invocation.mutating => (revision, true, artifact_ids),
            ToolOutcome::Applied {
                revision,
                artifact_ids,
            } if pending.invocation.mutating => (revision, true, artifact_ids),
            ToolOutcome::Read {
                revision,
                artifact_ids,
            } if !pending.invocation.mutating => (revision, false, artifact_ids),
            ToolOutcome::Rejected { revision, .. } => (revision, false, vec![]),
            _ => {
                return Err(AgentError::Conflict(
                    "tool receipt does not match the prepared operation".into(),
                ));
            }
        };
        if revision < pending.expected_revision {
            return Err(AgentError::Conflict(
                "tool receipt has an older editor revision".into(),
            ));
        }
        self.receipts.push(ReceiptReference {
            call_id: call_id.into(),
            capability_id: pending.invocation.capability_id.clone(),
            revision: Some(revision),
            committed,
            external_only,
            artifact_ids: artifacts,
        });
        self.pending = None;
        if (committed && !external_only) || self.revision != Some(revision) {
            self.verified_revision = None;
        }
        self.revision = Some(revision);
        if self.phase != RunPhase::Paused {
            self.phase = RunPhase::NeedsObservation;
        }
        // Every result starts a new provider turn; a second buffered tool from
        // the old response cannot run on assumptions made before the first.
        self.epoch += 1;
        Ok(())
    }

    pub fn steer(&mut self, message: String) -> Result<(), AgentError> {
        if matches!(self.phase, RunPhase::Completed | RunPhase::Failed) {
            return Err(AgentError::Conflict(
                "start a new run after its terminal result".into(),
            ));
        }
        validate_text(&message, 100_000, "steering")?;
        self.steering.push(message);
        self.verified_revision = None;
        self.epoch += 1;
        if self.phase != RunPhase::Paused && self.pending.is_none() {
            self.phase = RunPhase::NeedsObservation;
        }
        Ok(())
    }

    pub fn pause(&mut self) {
        if !matches!(self.phase, RunPhase::Completed | RunPhase::Failed) {
            self.phase = RunPhase::Paused;
            self.epoch += 1;
        }
    }

    /// Pending operations must first be reconciled by receipt/idempotency key.
    /// Never guess that a network disconnect means a mutation did not commit.
    pub fn resume(&mut self, authenticated_scope: &AgentScope) -> Result<(), AgentError> {
        if &self.scope != authenticated_scope {
            return Err(AgentError::Denied(
                "checkpoint belongs to another account, project or run".into(),
            ));
        }
        if self.phase != RunPhase::Paused || self.pending.is_some() {
            return Err(AgentError::Conflict(
                "reconcile any pending tool before resuming a paused run".into(),
            ));
        }
        self.phase = RunPhase::NeedsObservation;
        self.verified_revision = None;
        self.epoch += 1;
        Ok(())
    }

    /// Host verification must read the canonical state at this exact revision
    /// and, when visual changes occurred, inspect renderer artifacts as well.
    pub fn verify(
        &mut self,
        epoch: u64,
        revision: u64,
        issues: &[String],
    ) -> Result<(), AgentError> {
        self.check_ready(epoch)?;
        if self.revision != Some(revision) {
            return Err(AgentError::Conflict("verification is stale".into()));
        }
        if issues.is_empty() {
            self.verified_revision = Some(revision);
            self.phase = RunPhase::Ready;
        } else {
            self.verified_revision = None;
            self.phase = RunPhase::NeedsVerification;
        }
        Ok(())
    }

    pub fn finish(&mut self, epoch: u64, message: String) -> Result<(), AgentError> {
        self.check_ready(epoch)?;
        validate_text(&message, 100_000, "final response")?;
        if self
            .receipts
            .iter()
            .any(|r| r.committed && !r.external_only)
            && self.verified_revision != self.revision
        {
            return Err(AgentError::Conflict(
                "verify the edited result before declaring completion".into(),
            ));
        }
        if self.plan.iter().any(|s| s.status != PlanStatus::Complete) {
            return Err(AgentError::Conflict(
                "editing plan still has unfinished steps".into(),
            ));
        }
        self.final_message = Some(message);
        self.phase = RunPhase::Completed;
        self.epoch += 1;
        Ok(())
    }

    /// Ends an unsuccessful task without asserting verification or undoing edits.
    /// An unresolved host operation must be reconciled first, never discarded.
    pub fn fail(&mut self, epoch: u64, message: String) -> Result<(), AgentError> {
        self.check_ready(epoch)?;
        validate_text(&message, 100_000, "failure report")?;
        self.verified_revision = None;
        self.final_message = Some(message);
        self.phase = RunPhase::Failed;
        self.epoch += 1;
        Ok(())
    }
}

fn validate_text(text: &str, max: usize, field: &str) -> Result<(), AgentError> {
    if text.trim().is_empty() || text.len() > max {
        return Err(AgentError::Invalid(format!("{field} is empty or too long")));
    }
    Ok(())
}
