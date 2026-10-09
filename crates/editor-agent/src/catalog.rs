use crate::{AgentError, AgentScope};
use opencut_editor_api::{
    AccessLevel, CapabilityDescriptor, DocumentKind, InvocationContext, RegistrySnapshot,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Small metadata results precede exact schemas. No per-feature model tool list.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityMatch {
    pub id: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub access: AccessLevel,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

pub fn discover_capabilities(
    catalog: &RegistrySnapshot,
    kind: DocumentKind,
    query: &str,
    limit: usize,
) -> Vec<CapabilityMatch> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut matches: Vec<_> = catalog
        .capabilities
        .iter()
        .filter(|c| c.document_support.supports(kind))
        .filter_map(|c| {
            let text = format!(
                "{} {} {} {} {}",
                c.id,
                c.title,
                c.description,
                c.category,
                c.tags.join(" ")
            )
            .to_lowercase();
            let score = terms
                .iter()
                .filter(|term| text.contains(term.as_str()))
                .count();
            (terms.is_empty() || score > 0).then_some((score, c))
        })
        .collect();
    matches.sort_by(|(a_score, a), (b_score, b)| {
        b.available
            .cmp(&a.available)
            .then(b_score.cmp(a_score))
            .then(a.id.cmp(&b.id))
    });
    matches
        .into_iter()
        .take(limit.clamp(1, 50))
        .map(|(_, c)| CapabilityMatch {
            id: c.id.clone(),
            title: c.title.clone(),
            description: c.description.chars().take(480).collect(),
            version: c.version.clone(),
            access: c.access,
            available: c.available,
            unavailable_reason: c.unavailable_reason.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadedContracts {
    entries: BTreeMap<String, CapabilityDescriptor>,
    order: Vec<String>,
}

impl LoadedContracts {
    pub fn describe(
        &mut self,
        catalog: &RegistrySnapshot,
        kind: DocumentKind,
        id: &str,
    ) -> Result<CapabilityDescriptor, AgentError> {
        let descriptor = catalog
            .capabilities
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| {
                AgentError::Invalid(format!(
                    "unknown capability {id}; discover available tools first"
                ))
            })?;
        if !descriptor.document_support.supports(kind) {
            return Err(AgentError::Denied(format!(
                "{id} does not operate on this editor representation"
            )));
        }
        self.order.retain(|entry| entry != id);
        self.order.push(id.into());
        self.entries.insert(id.into(), descriptor.clone());
        while self.order.len() > 8 {
            let evicted = self.order.remove(0);
            self.entries.remove(&evicted);
        }
        Ok(descriptor.clone())
    }

    pub fn descriptors(&self) -> Vec<&CapabilityDescriptor> {
        self.order
            .iter()
            .filter_map(|id| self.entries.get(id))
            .collect()
    }

    /// Bind project/actor/revision outside model arguments. The canonical
    /// registry still validates schemas, policy, idempotency and actual state.
    pub fn prepare(
        &self,
        catalog: &RegistrySnapshot,
        scope: &AgentScope,
        kind: DocumentKind,
        revision: u64,
        call_id: &str,
        capability_id: &str,
        mut input: Value,
        max_access: AccessLevel,
    ) -> Result<PreparedInvocation, AgentError> {
        scope.validate()?;
        if call_id.trim().is_empty() || call_id.len() > 256 || call_id.chars().any(char::is_control)
        {
            return Err(AgentError::Invalid(
                "tool call needs a bounded stable ID".into(),
            ));
        }
        let loaded = self.entries.get(capability_id).ok_or_else(|| {
            AgentError::Invalid(format!("describe {capability_id} before invoking it"))
        })?;
        let current = catalog
            .capabilities
            .iter()
            .find(|c| c.id == capability_id)
            .ok_or_else(|| {
                AgentError::Conflict("capability was removed; rediscover tools".into())
            })?;
        if current != loaded {
            return Err(AgentError::Conflict(
                "capability contract changed; load its current schema".into(),
            ));
        }
        if !current.available
            || !current.document_support.supports(kind)
            || current.access > max_access
        {
            return Err(AgentError::Denied(
                current
                    .unavailable_reason
                    .clone()
                    .unwrap_or_else(|| "capability is outside the run's authority".into()),
            ));
        }
        let args = input
            .as_object_mut()
            .ok_or_else(|| AgentError::Invalid("capability input must be an object".into()))?;
        if args
            .get("projectId")
            .is_some_and(|id| id.as_str() != Some(scope.project_id.as_str()))
        {
            return Err(AgentError::Denied(
                "use an owned-project read/copy capability to access another project".into(),
            ));
        }
        if args
            .get("expectedRevision")
            .is_some_and(|value| value.as_u64() != Some(revision))
        {
            return Err(AgentError::Conflict(
                "arguments were prepared against a different revision; read state again".into(),
            ));
        }
        let properties = current.input_schema.get("properties");
        if properties.and_then(|p| p.get("projectId")).is_some() {
            args.insert("projectId".into(), json!(scope.project_id));
        }
        if properties.and_then(|p| p.get("expectedRevision")).is_some() {
            args.insert("expectedRevision".into(), json!(revision));
        }
        // Tuple encoding prevents delimiter collisions and keeps retry identity
        // separate even when two projects use the same provider run/call IDs.
        let key = json!([scope.run_id, call_id]).to_string();
        let context = InvocationContext {
            source: "editor-agent".into(),
            actor: Some(json!([scope.account_id, scope.project_id, scope.run_id]).to_string()),
            request_id: Some(key.clone()),
            metadata: serde_json::from_value(json!({
                "opencut/projectId": scope.project_id,
                "opencut/expectedRevision": revision,
                "opencut/idempotencyKey": key,
            }))
            .expect("object literal"),
            ..Default::default()
        };
        Ok(PreparedInvocation {
            capability_id: capability_id.into(),
            input,
            context,
            mutating: current.access != AccessLevel::Read,
            registry_revision: catalog.revision,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInvocation {
    pub capability_id: String,
    pub input: Value,
    pub context: InvocationContext,
    pub mutating: bool,
    pub registry_revision: u64,
}
