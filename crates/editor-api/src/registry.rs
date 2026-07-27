use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use jsonschema::Validator;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::{
    AccessPolicy, Capability, CapabilityDescriptor, CapabilityError, InvocationContext,
    InvocationReceipt, PolicyDecision,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RegistryEvent {
    CapabilityRegistered { id: String, revision: u64 },
    CapabilityRemoved { id: String, revision: u64 },
    ResourcesChanged { uris: Vec<String>, revision: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub revision: u64,
    pub capabilities: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvocationAudit {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub capability_id: String,
    pub actor: Option<String>,
    pub request_id: Option<String>,
    pub ok: bool,
    pub summary: Option<String>,
    pub changed_resources: Vec<String>,
    pub error: Option<String>,
}

struct RegistryEntry {
    capability: Arc<dyn Capability>,
    input_validator: Validator,
    output_validator: Validator,
}

#[derive(Default)]
struct RegistryState {
    revision: u64,
    entries: BTreeMap<String, RegistryEntry>,
}

#[derive(Clone)]
pub struct CapabilityRegistry {
    state: Arc<RwLock<RegistryState>>,
    policy: Arc<RwLock<AccessPolicy>>,
    events: broadcast::Sender<RegistryEvent>,
    audit: Arc<RwLock<AuditState>>,
    idempotency: Arc<RwLock<IdempotencyState>>,
}

#[derive(Default)]
struct AuditState {
    next_sequence: u64,
    entries: VecDeque<InvocationAudit>,
}

#[derive(Default)]
struct IdempotencyState {
    order: VecDeque<String>,
    entries: BTreeMap<String, IdempotencyEntry>,
}

#[derive(Clone)]
struct IdempotencyEntry {
    input: Value,
    receipt: InvocationReceipt,
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new(AccessPolicy::default())
    }
}

impl CapabilityRegistry {
    pub fn new(policy: AccessPolicy) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            state: Arc::new(RwLock::new(RegistryState::default())),
            policy: Arc::new(RwLock::new(policy)),
            events,
            audit: Arc::new(RwLock::new(AuditState::default())),
            idempotency: Arc::new(RwLock::new(IdempotencyState::default())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RegistryEvent> {
        self.events.subscribe()
    }

    pub fn notify_resources_changed(&self, uris: Vec<String>) -> Result<(), RegistryError> {
        if uris.is_empty() {
            return Ok(());
        }
        let revision = self
            .state
            .read()
            .map_err(|_| RegistryError::LockPoisoned)?
            .revision;
        let _ = self
            .events
            .send(RegistryEvent::ResourcesChanged { uris, revision });
        Ok(())
    }

    pub fn set_policy(&self, policy: AccessPolicy) -> Result<(), RegistryError> {
        *self
            .policy
            .write()
            .map_err(|_| RegistryError::LockPoisoned)? = policy;
        Ok(())
    }

    pub fn register(&self, capability: Arc<dyn Capability>) -> Result<(), RegistryError> {
        let descriptor = capability.descriptor().clone();
        validate_descriptor(&descriptor)?;
        let input_validator = jsonschema::validator_for(&descriptor.input_schema)
            .map_err(|error| RegistryError::InvalidSchema(error.to_string()))?;
        let output_validator = jsonschema::validator_for(&descriptor.output_schema)
            .map_err(|error| RegistryError::InvalidSchema(error.to_string()))?;

        let mut state = self
            .state
            .write()
            .map_err(|_| RegistryError::LockPoisoned)?;
        if state.entries.contains_key(&descriptor.id) {
            return Err(RegistryError::Duplicate(descriptor.id));
        }
        state.entries.insert(
            descriptor.id.clone(),
            RegistryEntry {
                capability,
                input_validator,
                output_validator,
            },
        );
        state.revision += 1;
        let revision = state.revision;
        drop(state);
        let _ = self.events.send(RegistryEvent::CapabilityRegistered {
            id: descriptor.id,
            revision,
        });
        Ok(())
    }

    pub fn unregister(&self, id: &str) -> Result<bool, RegistryError> {
        let mut state = self
            .state
            .write()
            .map_err(|_| RegistryError::LockPoisoned)?;
        if state.entries.remove(id).is_none() {
            return Ok(false);
        }
        state.revision += 1;
        let revision = state.revision;
        drop(state);
        let _ = self.events.send(RegistryEvent::CapabilityRemoved {
            id: id.into(),
            revision,
        });
        Ok(true)
    }

    pub fn snapshot(&self) -> Result<RegistrySnapshot, RegistryError> {
        let state = self.state.read().map_err(|_| RegistryError::LockPoisoned)?;
        Ok(RegistrySnapshot {
            revision: state.revision,
            capabilities: state
                .entries
                .values()
                .map(|entry| entry.capability.descriptor().clone())
                .collect(),
        })
    }

    /// Returns only the capabilities currently permitted by the effective policy.
    pub fn effective_snapshot(&self) -> Result<RegistrySnapshot, RegistryError> {
        let policy = self
            .policy
            .read()
            .map_err(|_| RegistryError::LockPoisoned)?
            .clone();
        let mut snapshot = self.snapshot()?;
        snapshot
            .capabilities
            .retain(|descriptor| matches!(policy.evaluate(descriptor), PolicyDecision::Allowed));
        Ok(snapshot)
    }

    pub fn effective_policy(&self) -> Result<AccessPolicy, RegistryError> {
        self.policy
            .read()
            .map_err(|_| RegistryError::LockPoisoned)
            .map(|policy| policy.clone())
    }

    pub fn is_allowed(&self, descriptor: &CapabilityDescriptor) -> Result<bool, RegistryError> {
        let policy = self
            .policy
            .read()
            .map_err(|_| RegistryError::LockPoisoned)?;
        Ok(matches!(
            policy.evaluate(descriptor),
            PolicyDecision::Allowed
        ))
    }

    pub fn audit_log(
        &self,
        limit: usize,
        capability_id: Option<&str>,
    ) -> Result<Vec<InvocationAudit>, RegistryError> {
        let audit = self.audit.read().map_err(|_| RegistryError::LockPoisoned)?;
        Ok(audit
            .entries
            .iter()
            .rev()
            .filter(|entry| capability_id.is_none_or(|id| entry.capability_id == id))
            .take(limit.min(1000))
            .cloned()
            .collect())
    }

    pub fn descriptor(&self, id: &str) -> Result<Option<CapabilityDescriptor>, RegistryError> {
        let state = self.state.read().map_err(|_| RegistryError::LockPoisoned)?;
        Ok(state
            .entries
            .get(id)
            .map(|entry| entry.capability.descriptor().clone()))
    }

    pub async fn invoke(
        &self,
        id: &str,
        context: InvocationContext,
        input: Value,
    ) -> Result<InvocationReceipt, RegistryError> {
        let (capability, descriptor, revision) = {
            let state = self.state.read().map_err(|_| RegistryError::LockPoisoned)?;
            let entry = state
                .entries
                .get(id)
                .ok_or_else(|| RegistryError::NotFound(id.into()))?;

            if let Err(error) = entry.input_validator.validate(&input) {
                return Err(RegistryError::InvalidInput {
                    id: id.into(),
                    details: error.to_string(),
                });
            }
            (
                entry.capability.clone(),
                entry.capability.descriptor().clone(),
                state.revision,
            )
        };

        let policy = self
            .policy
            .read()
            .map_err(|_| RegistryError::LockPoisoned)?
            .clone();
        if let PolicyDecision::Denied(reason) = policy.evaluate(&descriptor) {
            return Err(RegistryError::Denied(reason));
        }
        if !descriptor.available {
            return Err(RegistryError::Capability(CapabilityError::Unavailable(
                descriptor
                    .unavailable_reason
                    .clone()
                    .unwrap_or_else(|| format!("{} is unavailable", descriptor.id)),
            )));
        }

        let idempotency_key = context
            .metadata
            .get("opencut/idempotencyKey")
            .and_then(Value::as_str)
            .map(|key| {
                format!(
                    "{}|{}|{}",
                    context.actor.as_deref().unwrap_or("anonymous"),
                    descriptor.id,
                    key
                )
            });
        if let Some(key) = &idempotency_key
            && let Some(cached) = self
                .idempotency
                .read()
                .map_err(|_| RegistryError::LockPoisoned)?
                .entries
                .get(key)
                .cloned()
        {
            if cached.input != input {
                return Err(RegistryError::InvalidInput {
                    id: id.into(),
                    details: "idempotencyKey was already used with different input".into(),
                });
            }
            return Ok(cached.receipt);
        }

        let audit_context = context.clone();
        let result = match capability.invoke(context, input.clone()).await {
            Ok(result) => result,
            Err(error) => {
                self.record_audit(
                    &descriptor.id,
                    &audit_context,
                    false,
                    None,
                    Vec::new(),
                    Some(error.to_string()),
                )?;
                return Err(RegistryError::Capability(error));
            }
        };

        {
            let state = self.state.read().map_err(|_| RegistryError::LockPoisoned)?;
            let entry = state
                .entries
                .get(id)
                .ok_or_else(|| RegistryError::NotFound(id.into()))?;
            if let Err(error) = entry.output_validator.validate(&result.data) {
                let output_error = RegistryError::InvalidOutput {
                    id: id.into(),
                    details: error.to_string(),
                };
                self.record_audit(
                    &descriptor.id,
                    &audit_context,
                    false,
                    result.summary.clone(),
                    result.changed_resources.clone(),
                    Some(output_error.to_string()),
                )?;
                return Err(output_error);
            }
        }

        if !result.changed_resources.is_empty() {
            let _ = self.events.send(RegistryEvent::ResourcesChanged {
                uris: result.changed_resources.clone(),
                revision,
            });
        }

        let receipt = InvocationReceipt {
            capability_id: descriptor.id,
            capability_version: descriptor.version,
            registry_revision: revision,
            result,
        };
        self.record_audit(
            &receipt.capability_id,
            &audit_context,
            true,
            receipt.result.summary.clone(),
            receipt.result.changed_resources.clone(),
            None,
        )?;
        if let Some(key) = idempotency_key {
            let mut state = self
                .idempotency
                .write()
                .map_err(|_| RegistryError::LockPoisoned)?;
            if !state.entries.contains_key(&key) {
                state.order.push_back(key.clone());
            }
            state.entries.insert(
                key,
                IdempotencyEntry {
                    input,
                    receipt: receipt.clone(),
                },
            );
            while state.order.len() > 1000 {
                if let Some(oldest) = state.order.pop_front() {
                    state.entries.remove(&oldest);
                }
            }
        }
        Ok(receipt)
    }

    fn record_audit(
        &self,
        capability_id: &str,
        context: &InvocationContext,
        ok: bool,
        summary: Option<String>,
        changed_resources: Vec<String>,
        error: Option<String>,
    ) -> Result<(), RegistryError> {
        let mut audit = self
            .audit
            .write()
            .map_err(|_| RegistryError::LockPoisoned)?;
        audit.next_sequence += 1;
        let sequence = audit.next_sequence;
        audit.entries.push_back(InvocationAudit {
            sequence,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            capability_id: capability_id.into(),
            actor: context.actor.clone(),
            request_id: context.request_id.clone(),
            ok,
            summary,
            changed_resources,
            error,
        });
        while audit.entries.len() > 2000 {
            audit.entries.pop_front();
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("capability `{0}` is already registered")]
    Duplicate(String),
    #[error("capability `{0}` was not found")]
    NotFound(String),
    #[error("invalid capability descriptor: {0}")]
    InvalidDescriptor(String),
    #[error("invalid JSON Schema: {0}")]
    InvalidSchema(String),
    #[error("input for `{id}` does not match its schema: {details}")]
    InvalidInput { id: String, details: String },
    #[error("output from `{id}` does not match its schema: {details}")]
    InvalidOutput { id: String, details: String },
    #[error("access denied: {0}")]
    Denied(String),
    #[error(transparent)]
    Capability(#[from] CapabilityError),
    #[error("internal registry lock was poisoned")]
    LockPoisoned,
}

fn validate_descriptor(descriptor: &CapabilityDescriptor) -> Result<(), RegistryError> {
    let id_is_valid = descriptor.id.contains('.')
        && descriptor.id.len() <= 120
        && descriptor.id.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        });
    if !id_is_valid {
        return Err(RegistryError::InvalidDescriptor(format!(
            "`{}` must be a lowercase dotted identifier of at most 120 characters",
            descriptor.id
        )));
    }
    for (label, schema) in [
        ("input", &descriptor.input_schema),
        ("output", &descriptor.output_schema),
    ] {
        if schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(RegistryError::InvalidDescriptor(format!(
                "{label} schema for `{}` must have an object root",
                descriptor.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{CapabilityDescriptor, CapabilityResult, FnCapability};

    fn echo() -> Arc<dyn Capability> {
        Arc::new(FnCapability::new(
            CapabilityDescriptor::read(
                "test.echo",
                "Echo",
                "Returns the supplied value",
                "test",
                json!({
                    "type": "object",
                    "properties": {"value": {}},
                    "required": ["value"],
                    "additionalProperties": false
                }),
                json!({
                    "type": "object",
                    "properties": {"value": {}},
                    "required": ["value"],
                    "additionalProperties": false
                }),
            ),
            |_, input| Box::pin(async move { Ok(CapabilityResult::data(input)) }),
        ))
    }

    #[tokio::test]
    async fn registered_capabilities_are_discoverable_and_invokable() {
        let registry = CapabilityRegistry::default();
        registry.register(echo()).unwrap();

        let snapshot = registry.snapshot().unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.capabilities[0].id, "test.echo");

        let receipt = registry
            .invoke(
                "test.echo",
                InvocationContext::default(),
                json!({"value": 42}),
            )
            .await
            .unwrap();
        assert_eq!(receipt.result.data, json!({"value": 42}));
    }

    #[tokio::test]
    async fn invalid_arguments_are_rejected_before_execution() {
        let registry = CapabilityRegistry::default();
        registry.register(echo()).unwrap();
        let error = registry
            .invoke("test.echo", InvocationContext::default(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(error, RegistryError::InvalidInput { .. }));
    }
}
