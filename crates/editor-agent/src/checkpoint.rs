//! Durable run records bind to the canonical project, never carry a second
//! editable project. Hosts must atomically persist this record with the matching
//! canonical archive and restore that archive before calling restore_checkpoint.
use crate::{
    AgentError, AgentRun, AgentScope, ContextInput, LoadedContracts, RuntimeAgent, compile_context,
};
use opencut_editor_api::{
    AccessLevel, CapabilityDescriptor, HostBridge, HostEffect, OpenCutRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

const MAX_CHECKPOINT_BYTES: usize = 8_000_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunCheckpoint {
    schema_version: u32,
    project_revision: u64,
    project_fingerprint: String,
    run: AgentRun,
    provider: crate::provider::ProviderState,
    pending_host: Option<PendingHost>,
    #[serde(default)]
    learned_contracts: Vec<CapabilityDescriptor>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingHost {
    effect: HostEffect,
    descriptor: CapabilityDescriptor,
}

impl RuntimeAgent {
    /// This is a serialization, not a save acknowledgement. Host persistence
    /// must include the canonical archive at projectRevision in the same commit.
    pub fn checkpoint(&self) -> Result<String, AgentError> {
        let state = self.runtime.snapshot().map_err(error)?;
        let project = state
            .project
            .as_ref()
            .ok_or_else(|| error("editor was closed"))?;
        if project.id != self.run.scope().project_id {
            return Err(error("checkpoint target changed"));
        }
        let pending_host = match (self.run.pending(), self.pending_host_effect()?) {
            (None, None) => None,
            (Some(pending), Some(effect)) => {
                let descriptor = self
                    .run
                    .contracts()
                    .descriptors()
                    .into_iter()
                    .find(|d| d.id == pending.invocation.capability_id)
                    .cloned()
                    .ok_or_else(|| error("pending capability contract was lost"))?;
                Some(PendingHost { effect, descriptor })
            }
            _ => return Err(error("checkpoint cannot omit an unsettled host operation")),
        };
        let mut provider = self.provider.clone();
        let context = compile_context(ContextInput {
            request: self.run.request().into(),
            steering: self.run.steering().to_vec(),
            plan: serde_json::to_value(self.run.plan()).map_err(error)?,
            contracts: vec![],
            knowledge: vec![],
            conversation: provider.conversation.clone(),
            groups: provider.groups.clone(),
            max_bytes: 2_000_000,
        })?;
        if let Some((group_id, _)) = &provider.pending_activity {
            if !context.groups.iter().any(|g| &g.id == group_id) {
                return Err(error(
                    "pending provider round exceeds checkpoint context quota",
                ));
            }
        }
        provider.groups = context.groups;
        provider.conversation = context.conversation;
        provider.archived_receipts.extend(context.earlier_receipts);
        // Render handles expire. A reopened run must render and verify again.
        provider.review = None;
        provider.reviewed = None;
        provider.knowledge = None;
        let checkpoint = RunCheckpoint {
            schema_version: 1,
            project_revision: state.revision,
            project_fingerprint: fingerprint(&serde_json::to_value(project).map_err(error)?),
            run: self.run.clone(),
            provider,
            pending_host,
            learned_contracts: self
                .run
                .contracts()
                .descriptors()
                .into_iter()
                .cloned()
                .collect(),
        };
        let json = serde_json::to_string(&checkpoint).map_err(error)?;
        if json.len() > MAX_CHECKPOINT_BYTES {
            return Err(AgentError::ContextLimit(
                "editing checkpoint exceeds its storage quota".into(),
            ));
        }
        Ok(json)
    }

    /// Restores into a host-selected canonical runtime. A checkpoint cannot
    /// replace editor contents, supply identity, grant privileges or attest QA.
    /// A pending effect is re-prepared but no host IO is started automatically.
    pub fn restore_checkpoint(
        runtime: OpenCutRuntime,
        account_id: &str,
        project_id: &str,
        max_access: AccessLevel,
        bridge: Option<HostBridge>,
        json: &str,
    ) -> Result<Self, AgentError> {
        if json.len() > MAX_CHECKPOINT_BYTES {
            return Err(AgentError::ContextLimit(
                "editing checkpoint exceeds its storage quota".into(),
            ));
        }
        let checkpoint: RunCheckpoint = serde_json::from_str(json).map_err(error)?;
        if checkpoint.schema_version != 1 {
            return Err(error("unsupported editing checkpoint version"));
        }
        let scope = AgentScope {
            account_id: account_id.into(),
            project_id: project_id.into(),
            run_id: checkpoint.run.scope().run_id.clone(),
        };
        let state = runtime.snapshot().map_err(error)?;
        let project = state
            .project
            .as_ref()
            .ok_or_else(|| error("restore the saved canonical project first"))?;
        if project.id != project_id || checkpoint.run.scope() != &scope {
            return Err(AgentError::Denied(
                "checkpoint belongs to another account or project".into(),
            ));
        }
        let project_value = serde_json::to_value(project).map_err(error)?;
        if state.revision != checkpoint.project_revision
            || (fingerprint(&project_value) != checkpoint.project_fingerprint
                && legacy_fingerprint(&project_value) != checkpoint.project_fingerprint)
        {
            return Err(error(
                "checkpoint and canonical project were not saved together; refusing stale recovery",
            ));
        }
        if checkpoint
            .run
            .revision()
            .is_some_and(|r| r > state.revision)
        {
            return Err(error("checkpoint run is newer than its project"));
        }
        let mut run = checkpoint.run;
        run.restore_checkpoint_authority(&scope, max_access, bridge.is_some())?;
        let mut agent = Self {
            runtime,
            run,
            provider: checkpoint.provider,
            host: bridge,
            suspended: None,
        };
        // A saved description is not authority. Retain only the bounded recent
        // contracts that still match the host-selected live catalog exactly.
        // Changed/removed/denied contracts require another describe; no IO runs.
        if checkpoint.learned_contracts.len() > 8 {
            return Err(error("checkpoint learned contract cache exceeds its quota"));
        }
        let catalog = agent.catalog()?;
        let kind = if project.classic.is_some() {
            opencut_editor_api::DocumentKind::Classic
        } else {
            opencut_editor_api::DocumentKind::Rewrite
        };
        let mut contracts = LoadedContracts::default();
        for saved in &checkpoint.learned_contracts {
            if catalog.capabilities.iter().any(|current| {
                current == saved && current.available && current.document_support.supports(kind)
            }) {
                contracts.describe(&catalog, kind, &saved.id)?;
            }
        }
        agent.run.restore_pending_contracts(contracts);
        match (agent.run.pending().cloned(), checkpoint.pending_host) {
            (None, None) => {
                if agent.provider.pending_activity.is_some() {
                    return Err(error("checkpoint has an orphaned provider action"));
                }
            }
            (Some(pending), Some(saved)) => {
                let catalog = agent.catalog()?;
                let current = catalog
                    .capabilities
                    .iter()
                    .find(|d| d.id == pending.invocation.capability_id)
                    .ok_or_else(|| error("pending capability was removed"))?;
                if current != &saved.descriptor
                    || !current.available
                    || !agent.host.as_ref().is_some_and(|h| h.supports(current))
                {
                    return Err(error(
                        "pending host contract changed; preserve the checkpoint for reconciliation",
                    ));
                }
                let mut contracts = agent.run.contracts().clone();
                let kind = if project.classic.is_some() {
                    opencut_editor_api::DocumentKind::Classic
                } else {
                    opencut_editor_api::DocumentKind::Rewrite
                };
                contracts.describe(&catalog, kind, &current.id)?;
                let rebound = contracts.prepare(
                    &catalog,
                    &scope,
                    kind,
                    pending.expected_revision,
                    &pending.call_id,
                    &current.id,
                    pending.invocation.input.clone(),
                    max_access,
                )?;
                if serde_json::to_value(&rebound.context).map_err(error)?
                    != serde_json::to_value(&pending.invocation.context).map_err(error)?
                    || rebound.input != pending.invocation.input
                    || rebound.mutating != pending.invocation.mutating
                {
                    return Err(AgentError::Denied(
                        "checkpoint pending action has invalid scope or retry identity".into(),
                    ));
                }
                if let Some((group, activity)) = &agent.provider.pending_activity {
                    if activity.call_id != pending.call_id
                        || !agent.provider.groups.iter().any(|g| &g.id == group)
                    {
                        return Err(error(
                            "checkpoint provider action does not match the pending request",
                        ));
                    }
                }
                agent.run.restore_pending_contracts(contracts);
                let registry = agent.runtime.registry().clone();
                let id = current.id.clone();
                let mut future =
                    Box::pin(
                        async move { registry.invoke(&id, rebound.context, rebound.input).await },
                    );
                if let Poll::Ready(_) = future
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                {
                    return Err(error(
                        "pending recovery must use a fresh canonical runtime and installed host adapter",
                    ));
                }
                let effect = agent
                    .pending_host_effect()?
                    .ok_or_else(|| error("pending recovery produced no host effect"))?;
                if effect.adapter != saved.effect.adapter
                    || effect.project_id != saved.effect.project_id
                    || effect.request != saved.effect.request
                {
                    agent
                        .host
                        .as_ref()
                        .expect("validated host")
                        .discard_unstarted(effect.id)
                        .map_err(error)?;
                    return Err(error(
                        "host adapter changed the pending request; preserve checkpoint for reconciliation",
                    ));
                }
                agent.suspended = Some(future);
            }
            _ => return Err(error("checkpoint lost a pending operation")),
        }
        Ok(agent)
    }
}

fn fingerprint(value: &Value) -> String {
    // Browser archives carry JSON numbers, not Rust's integer/float distinction.
    // Normalize exactly representable integral doubles only (including -0).
    // Fractional numbers and large integers must retain their actual value.
    fn normalized(value: &Value) -> Value {
        match value {
            Value::Number(number) if number.is_f64() => {
                let number = number.as_f64().expect("JSON float");
                if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                    Value::from(number as i64)
                } else {
                    value.clone()
                }
            }
            Value::Array(items) => Value::Array(items.iter().map(normalized).collect()),
            Value::Object(items) => Value::Object(
                items
                    .iter()
                    .map(|(k, v)| (k.clone(), normalized(v)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    legacy_fingerprint(&normalized(value))
}
fn legacy_fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn browser_number_normalization_preserves_meaningful_changes() {
        assert_eq!(
            fingerprint(&json!({"fps":30.0,"start":-0.0})),
            fingerprint(&json!({"fps":30,"start":0}))
        );
        for value in [
            json!({"fps":31,"start":0}),
            json!({"fps":30.1,"start":0}),
            json!({"fps":"30","start":0}),
        ] {
            assert_ne!(
                fingerprint(&json!({"fps":30,"start":0})),
                fingerprint(&value)
            );
        }
        assert_ne!(
            fingerprint(&json!(9007199254740992_u64)),
            fingerprint(&json!(9007199254740993_u64))
        );
    }
}
fn error(error: impl std::fmt::Display) -> AgentError {
    AgentError::Conflict(error.to_string())
}
