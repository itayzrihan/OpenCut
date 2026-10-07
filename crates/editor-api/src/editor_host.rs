//! The editor shell and checkpoint validator share one installed host contract set.
use crate::{HostBridge, OpenCutRuntime, RegistryError};

/// Install contracts serviced by the trusted local editor host. This only
/// registers handlers and adapters; it performs no browser, filesystem or
/// provider IO. Desktop screenshot access remains an explicit shell opt-in.
/// Add future editor host features here once, so pending checkpoints are
/// validated against exactly the same descriptors as the running editor.
pub fn register_editor_host_capabilities(
    runtime: &OpenCutRuntime,
    bridge: &HostBridge,
) -> Result<(), RegistryError> {
    crate::register_editor_ui_capabilities(runtime, bridge)?;
    crate::register_editor_ui_control(runtime, bridge)?;
    crate::register_hyperframes_reference_source(runtime, bridge)?;
    crate::register_hyperframes_embedding(runtime, bridge)?;
    crate::register_editor_image_generation(runtime, bridge)?;
    crate::register_owned_project_capabilities(runtime, bridge)?;
    crate::register_hyperframes_authoring(runtime, bridge)?;
    crate::register_editor_render_capabilities(runtime, bridge)
}
