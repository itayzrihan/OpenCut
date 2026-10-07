//! OpenCut's transport-neutral Editor API.
//!
//! Every user-visible feature should register a [`Capability`] here. The same
//! registry is consumed by the desktop UI, headless automation, plugins,
//! scripting, and the MCP adapter, so a feature is never implemented twice.

mod artifact;
mod capability;
mod host_bridge;
mod editor_ui;
mod editor_host;
mod editor_ui_control;
mod editor_screenshot;
mod hyperframes_authoring;
mod editor_render;
mod classic;
mod classic_effects;
mod classic_masks;
mod classic_animation;
mod classic_archive;
mod classic_hyperframes_audio;
mod classic_hyperframes_layers;
mod classic_hyperframes_library;
mod hyperframes;
mod hyperframes_audio;
mod hyperframes_layer_edits;
mod hyperframes_layer_move;
mod hyperframes_layer_source;
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
    ARTIFACT_URI_PREFIX, ArtifactError, ArtifactLimits, ArtifactRef, ArtifactStore, StoredArtifact, ArtifactArchive,
};
pub use capability::{
    AccessLevel, Capability, CapabilityDescriptor, CapabilityError, CapabilityExecution,
    CapabilityFuture, CapabilityResult, DocumentKind, DocumentSupport, FnCapability,
    InvocationContext, InvocationReceipt,
};
pub use host_bridge::{HostBridge, HostEffect, HostEffectResult};
pub use editor_ui::register_editor_ui_capabilities;
pub use editor_host::register_editor_host_capabilities;
pub use editor_ui_control::register_editor_ui_control;
pub use operations::register_editor_image_generation;
pub use operations::{hyperframes_reference_source, register_hyperframes_reference_source, hyperframes_embedding_plan, register_hyperframes_embedding};
pub use operations::subscription_image_plan;
pub use operations::{owned_project_read, owned_media_transfer_plan, register_owned_project_capabilities};
pub use editor_screenshot::register_editor_screenshot_capability;
pub use hyperframes_authoring::register_hyperframes_authoring;
pub use editor_render::register_editor_render_capabilities;
pub use classic::{CLASSIC_TICKS_PER_SECOND, ClassicComposition, ClassicDocument, ClassicProject};
pub use classic_effects::ClassicEffectCatalog;
pub use classic_masks::ClassicMaskCatalog;
pub use classic_animation::{ClassicAnimationCatalog, ClassicAnimationGroup, AnimationTargetSelector};
pub use classic_hyperframes_audio::*;
pub use classic_hyperframes_layers::*;
pub use classic_hyperframes_library::*;
pub use hyperframes::*;
pub use hyperframes_audio::*;
pub use hyperframes_layer_edits::*;
pub use hyperframes_layer_move::*;
pub use hyperframes_layer_source::*;
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
