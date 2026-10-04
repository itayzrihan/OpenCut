//! OpenCut's transport-neutral Editor API.
//!
//! Every user-visible feature should register a [`Capability`] here. The same
//! registry is consumed by the desktop UI, headless automation, plugins,
//! scripting, and the MCP adapter, so a feature is never implemented twice.

mod artifact;
mod capability;
mod classic;
mod classic_archive;
mod classic_hyperframes_audio;
mod classic_hyperframes_layers;
mod classic_hyperframes_library;
mod hyperframes;
mod hyperframes_audio;
mod hyperframes_layer_edits;
mod hyperframes_manifest;
mod hyperframes_package;
mod hyperframes_source_edits;
mod hyperframes_variables;
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
pub use classic::{CLASSIC_TICKS_PER_SECOND, ClassicComposition, ClassicDocument, ClassicProject};
pub use classic_hyperframes_audio::*;
pub use classic_hyperframes_layers::*;
pub use classic_hyperframes_library::*;
pub use hyperframes::*;
pub use hyperframes_audio::*;
pub use hyperframes_layer_edits::*;
pub use hyperframes_manifest::*;
pub use hyperframes_package::*;
pub use hyperframes_variables::*;
pub use job::{JobManager, JobRecord, JobStatus};
pub use model::*;
pub use policy::{AccessPolicy, PolicyDecision};
pub use registry::{
    CapabilityRegistry, InvocationAudit, RegistryError, RegistryEvent, RegistrySnapshot,
};
pub use runtime::{
    OpenCutRuntime, ProjectSessionInfo, RecentProjectInfo, RuntimeCheckpoint, RuntimeError,
};
