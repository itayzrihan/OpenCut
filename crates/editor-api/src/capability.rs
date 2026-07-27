use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// How much authority a capability requires.
///
/// The ordering is intentional: policies can grant a maximum level.
#[derive(
    Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum AccessLevel {
    /// Observes OpenCut state without changing it.
    #[default]
    Read,
    /// Changes app or project state through a reversible operation.
    Write,
    /// Can delete, overwrite, publish, render, or otherwise cause material effects.
    Destructive,
    /// Controls app-level configuration, plugins, credentials, or policy.
    Admin,
}

/// Complete, machine-readable metadata for an Editor API operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptor {
    /// Stable dotted identifier, for example `timeline.clip.move`.
    pub id: String,
    /// Human-friendly display name.
    pub title: String,
    /// Clear behavioral description for humans and agents.
    pub description: String,
    /// Capability contract version. Increment when behavior or schemas change.
    pub version: String,
    /// JSON Schema 2020-12 object schema for invocation arguments.
    pub input_schema: Value,
    /// JSON Schema 2020-12 object schema for structured output.
    pub output_schema: Value,
    /// Required authority.
    #[serde(default)]
    pub access: AccessLevel,
    /// Whether repeated identical calls have no additional effect.
    #[serde(default)]
    pub idempotent: bool,
    /// Whether the capability can interact outside the currently open project.
    #[serde(default)]
    pub open_world: bool,
    /// Whether successful writes can participate in an application transaction.
    #[serde(default)]
    pub transactional: bool,
    /// Whether the operation honors InvocationContext::dry_run.
    #[serde(default)]
    pub supports_dry_run: bool,
    /// Whether cancellation is observed while the operation is running.
    #[serde(default)]
    pub cancellable: bool,
    /// Whether the host currently has the platform support and permission required.
    #[serde(default = "default_available")]
    pub available: bool,
    /// Human-readable explanation when available is false.
    pub unavailable_reason: Option<String>,
    /// Functional group used for discovery, such as `timeline` or `export`.
    pub category: String,
    /// Searchable vocabulary and feature aliases.
    #[serde(default)]
    pub tags: Vec<String>,
}

impl CapabilityDescriptor {
    pub fn read(
        id: impl Into<String>,
        title: impl Into<String>,
        description: impl Into<String>,
        category: impl Into<String>,
        input_schema: Value,
        output_schema: Value,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: description.into(),
            version: "1.0.0".into(),
            input_schema,
            output_schema,
            access: AccessLevel::Read,
            idempotent: true,
            open_world: false,
            transactional: false,
            supports_dry_run: false,
            cancellable: false,
            available: true,
            unavailable_reason: None,
            category: category.into(),
            tags: Vec::new(),
        }
    }
}

fn default_available() -> bool {
    true
}

/// Context common to every Editor API invocation, regardless of transport.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvocationContext {
    /// Transport or integration making the request (`mcp`, `desktop`, `script`, etc.).
    pub source: String,
    /// Optional client/session identity for auditing.
    pub actor: Option<String>,
    /// Caller-generated correlation identifier.
    pub request_id: Option<String>,
    /// Ask capable operations to validate/preview without committing.
    #[serde(default)]
    pub dry_run: bool,
    /// Extensible transport metadata that does not alter capability arguments.
    #[serde(default)]
    pub metadata: Map<String, Value>,
    /// Cancelled when the originating transport request is cancelled.
    #[serde(skip, default)]
    #[schemars(skip)]
    pub cancellation: CancellationToken,
}

/// Successful result returned by a capability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResult {
    /// Structured result matching the descriptor's output schema.
    pub data: Value,
    /// Optional concise message suitable for a human activity log.
    pub summary: Option<String>,
    /// URIs of resources whose contents may have changed.
    #[serde(default)]
    pub changed_resources: Vec<String>,
    /// Opaque artifacts created by this operation.
    #[serde(default)]
    pub artifacts: Vec<crate::ArtifactRef>,
}

impl CapabilityResult {
    pub fn data(data: Value) -> Self {
        Self {
            data,
            summary: None,
            changed_resources: Vec::new(),
            artifacts: Vec::new(),
        }
    }
}

/// Auditable envelope around a successful capability result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvocationReceipt {
    pub capability_id: String,
    pub capability_version: String,
    pub registry_revision: u64,
    pub result: CapabilityResult,
}

#[derive(Debug, Error)]
pub enum CapabilityError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("operation was denied: {0}")]
    Denied(String),
    #[error("required app state is unavailable: {0}")]
    Unavailable(String),
    #[error("operation conflict: {0}")]
    Conflict(String),
    #[error("operation failed: {0}")]
    Failed(String),
}

#[async_trait]
pub trait Capability: Send + Sync {
    fn descriptor(&self) -> &CapabilityDescriptor;

    async fn invoke(
        &self,
        context: InvocationContext,
        input: Value,
    ) -> Result<CapabilityResult, CapabilityError>;
}

pub type CapabilityFuture =
    Pin<Box<dyn Future<Output = Result<CapabilityResult, CapabilityError>> + Send + 'static>>;

/// Adapts an async closure into a capability, keeping feature modules concise.
pub struct FnCapability {
    descriptor: CapabilityDescriptor,
    handler: Arc<dyn Fn(InvocationContext, Value) -> CapabilityFuture + Send + Sync>,
}

impl FnCapability {
    pub fn new<F>(descriptor: CapabilityDescriptor, handler: F) -> Self
    where
        F: Fn(InvocationContext, Value) -> CapabilityFuture + Send + Sync + 'static,
    {
        Self {
            descriptor,
            handler: Arc::new(handler),
        }
    }
}

#[async_trait]
impl Capability for FnCapability {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    async fn invoke(
        &self,
        context: InvocationContext,
        input: Value,
    ) -> Result<CapabilityResult, CapabilityError> {
        (self.handler)(context, input).await
    }
}
