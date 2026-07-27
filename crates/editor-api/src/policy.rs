use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AccessLevel, CapabilityDescriptor};

/// Runtime authorization policy applied before every capability invocation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessPolicy {
    pub max_access: AccessLevel,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

impl Default for AccessPolicy {
    fn default() -> Self {
        Self::full_local_access()
    }
}

impl AccessPolicy {
    /// Trusted local MCP clients receive complete app access by default.
    ///
    /// This does not grant shell, arbitrary filesystem, or machine access:
    /// only operations deliberately registered by OpenCut are reachable.
    pub fn full_local_access() -> Self {
        Self {
            max_access: AccessLevel::Admin,
            allow: vec!["*".into()],
            deny: Vec::new(),
        }
    }

    pub fn read_only() -> Self {
        Self {
            max_access: AccessLevel::Read,
            allow: vec!["*".into()],
            deny: Vec::new(),
        }
    }

    pub fn evaluate(&self, descriptor: &CapabilityDescriptor) -> PolicyDecision {
        if descriptor.access > self.max_access {
            return PolicyDecision::Denied(format!(
                "{} requires {:?} access; policy grants up to {:?}",
                descriptor.id, descriptor.access, self.max_access
            ));
        }

        if self
            .deny
            .iter()
            .any(|pattern| matches(pattern, &descriptor.id))
        {
            return PolicyDecision::Denied(format!(
                "{} is blocked by the capability deny list",
                descriptor.id
            ));
        }

        if !self
            .allow
            .iter()
            .any(|pattern| matches(pattern, &descriptor.id))
        {
            return PolicyDecision::Denied(format!(
                "{} is not included in the capability allow list",
                descriptor.id
            ));
        }

        PolicyDecision::Allowed
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    Allowed,
    Denied(String),
}

fn matches(pattern: &str, value: &str) -> bool {
    pattern == "*"
        || pattern == value
        || pattern
            .strip_suffix(".*")
            .is_some_and(|prefix| value == prefix || value.starts_with(&format!("{prefix}.")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::CapabilityDescriptor;

    fn descriptor(id: &str, access: AccessLevel) -> CapabilityDescriptor {
        let mut descriptor = CapabilityDescriptor::read(
            id,
            id,
            id,
            "test",
            json!({"type": "object"}),
            json!({"type": "object"}),
        );
        descriptor.access = access;
        descriptor
    }

    #[test]
    fn wildcard_namespace_policy_is_enforced() {
        let policy = AccessPolicy {
            max_access: AccessLevel::Write,
            allow: vec!["timeline.*".into()],
            deny: vec!["timeline.clip.delete".into()],
        };

        assert_eq!(
            policy.evaluate(&descriptor("timeline.clip.move", AccessLevel::Write)),
            PolicyDecision::Allowed
        );
        assert!(matches!(
            policy.evaluate(&descriptor("timeline.clip.delete", AccessLevel::Write)),
            PolicyDecision::Denied(_)
        ));
        assert!(matches!(
            policy.evaluate(&descriptor("export.render", AccessLevel::Read)),
            PolicyDecision::Denied(_)
        ));
    }
}
