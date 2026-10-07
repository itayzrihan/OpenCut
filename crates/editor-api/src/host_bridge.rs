//! Suspends registered host capabilities without holding editor locks across IO.
//! The host installs adapters; model input cannot choose an endpoint or adapter.
use crate::{CapabilityDescriptor, CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEffect {
    pub id: u64,
    pub adapter: String,
    pub project_id: String,
    pub request: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum HostEffectResult {
    Success {
        data: Value,
    },
    /// A definitive rejection before commit. Transport failure is NOT rejection:
    /// leave the effect pending and reconcile/retry its original request.
    Rejected {
        message: String,
    },
}

#[derive(Default)]
struct State {
    next_id: u64,
    adapters: BTreeMap<String, CapabilityDescriptor>,
    pending: BTreeMap<u64, (HostEffect, oneshot::Sender<HostEffectResult>, Value)>,
}

#[derive(Clone, Default)]
pub struct HostBridge(Arc<Mutex<State>>);

impl HostBridge {
    pub fn install(&self, descriptor: &CapabilityDescriptor) -> Result<(), CapabilityError> {
        self.0
            .lock()
            .map_err(lock_error)?
            .adapters
            .insert(descriptor.id.clone(), descriptor.clone());
        Ok(())
    }
    pub fn supports(&self, descriptor: &CapabilityDescriptor) -> bool {
        self.0
            .lock()
            .is_ok_and(|s| s.adapters.get(&descriptor.id) == Some(descriptor))
    }
    pub fn pending(&self) -> Result<Vec<HostEffect>, CapabilityError> {
        Ok(self
            .0
            .lock()
            .map_err(lock_error)?
            .pending
            .values()
            .map(|(effect, _, _)| effect.clone())
            .collect())
    }
    pub async fn execute(
        &self,
        capability_id: &str,
        adapter: &str,
        project_id: &str,
        request: Value,
    ) -> Result<CapabilityResult, CapabilityError> {
        self.execute_preflight(capability_id, adapter, project_id, request, None).await
    }
    /// Internal preflight reply contracts may differ from the public final
    /// capability output. This schema comes from Rust, never model input.
    pub async fn execute_preflight(
        &self,
        capability_id: &str,
        adapter: &str,
        project_id: &str,
        request: Value,
        reply_schema: Option<Value>,
    ) -> Result<CapabilityResult, CapabilityError> {
        // Prepared offline source includes pinned JS/fonts. It never enters
        // model context and remains bounded like the corresponding host reply.
        let max_request = match adapter { "hyperframesAuthoring" => 4_000_000, "subscriptionImage" => 12_000_000, _ => 400_000 };
        if request.to_string().len() > max_request {
            return Err(CapabilityError::InvalidInput(
                "host request exceeds its bound".into(),
            ));
        }
        let receiver = {
            let mut state = self.0.lock().map_err(lock_error)?;
            let public_schema = state
                .adapters
                .get(capability_id)
                .ok_or_else(|| {
                    CapabilityError::Unavailable("host capability is not installed".into())
                })?
                .output_schema
                .clone();
            let output_schema = reply_schema.unwrap_or(public_schema);
            // One editor owns at most one external operation at a time. No
            // network-side write may hide inside a synchronous transaction.
            if !state.pending.is_empty() {
                return Err(CapabilityError::Conflict(
                    "reconcile the pending host operation first".into(),
                ));
            }
            state.next_id += 1;
            let id = state.next_id;
            let (sender, receiver) = oneshot::channel();
            state.pending.insert(
                id,
                (
                    HostEffect {
                        id,
                        adapter: adapter.into(),
                        project_id: project_id.into(),
                        request,
                    },
                    sender,
                    output_schema,
                ),
            );
            receiver
        };
        match receiver
            .await
            .map_err(|_| CapabilityError::Unavailable("host response channel closed".into()))?
        {
            HostEffectResult::Success { data } => Ok(CapabilityResult::data(data)),
            HostEffectResult::Rejected { message } => Err(CapabilityError::Failed(message)),
        }
    }
    pub fn settle(&self, id: u64, result: HostEffectResult) -> Result<(), CapabilityError> {
        if serde_json::to_vec(&result)
            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?
            .len()
            > 4_000_000
        {
            return Err(CapabilityError::InvalidInput(
                "host response exceeds its bound".into(),
            ));
        }
        let mut state = self.0.lock().map_err(lock_error)?;
        let (_, _, schema) = state.pending.get(&id).ok_or_else(|| {
            CapabilityError::Conflict("unknown or already settled host effect".into())
        })?;
        if let HostEffectResult::Success { data } = &result {
            let validator = jsonschema::validator_for(schema)
                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
            if let Err(error) = validator.validate(data) {
                // Do not consume the pending request: the host may have
                // committed even though its response was malformed.
                return Err(CapabilityError::Conflict(format!(
                    "host response does not match its contract; reconcile the same operation: {error}"
                )));
            }
        }
        let (_, sender, _) = state.pending.remove(&id).expect("checked effect");
        drop(state);
        sender
            .send(result)
            .map_err(|_| CapabilityError::Conflict("host invocation was dropped".into()))
    }
    /// Only for recovery preparation which has not been handed to host IO.
    /// This is not cancellation or proof that an in-flight write did not commit.
    pub fn discard_unstarted(&self, id: u64) -> Result<(), CapabilityError> {
        self.0.lock().map_err(lock_error)?.pending.remove(&id);
        Ok(())
    }
}
fn lock_error<T>(_: T) -> CapabilityError {
    CapabilityError::Failed("host bridge lock was poisoned".into())
}
