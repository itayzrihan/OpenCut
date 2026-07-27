//! OpenCut's transport-neutral Editor API.
//!
//! Every user-visible feature should register a [`Capability`] here. The same
//! registry is consumed by the desktop UI, headless automation, plugins,
//! scripting, and the MCP adapter, so a feature is never implemented twice.

mod artifact;
mod capability;
mod job;
mod model;
mod operations;
mod policy;
mod registry;
mod render;
mod runtime;

pub use artifact::{
    ARTIFACT_URI_PREFIX, ArtifactError, ArtifactLimits, ArtifactRef, ArtifactStore, StoredArtifact,
};
pub use capability::{
    AccessLevel, Capability, CapabilityDescriptor, CapabilityError, CapabilityFuture,
    CapabilityResult, FnCapability, InvocationContext, InvocationReceipt,
};
pub use job::{JobManager, JobRecord, JobStatus};
pub use model::*;
pub use policy::{AccessPolicy, PolicyDecision};
pub use registry::{
    CapabilityRegistry, InvocationAudit, RegistryError, RegistryEvent, RegistrySnapshot,
};
pub use runtime::{
    OpenCutRuntime, ProjectSessionInfo, RecentProjectInfo, RuntimeCheckpoint, RuntimeError,
};
