//! Browser/Electron PDF rendering of a verified canonical proposal.
use crate::*;
use crate::generative::{GenerativeDocument, KEY, storyboard};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input { project_id: String, expected_revision: u64 }
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    project_id: String, revision: u64, plan_digest: String,
    artifact: ArtifactRef, page_count: u32,
}
pub(super) fn register(runtime: &OpenCutRuntime, host: &HostBridge) -> Result<(), RegistryError> {
    let id = "project.generative.storyboard.export";
    let mut d = CapabilityDescriptor::read(id, "Export a client storyboard PDF", "Render the canonical client proposal locally in the active browser or Electron host. Includes existing full storyboard sheets, all client scene descriptions and explicitly bound scene images, preserving Hebrew and RTL. Never generates paid images. Prepare client copy with project.generative.edit (storyboard), inspect project.generative.storyboard.plan, then export. Returns a bounded application/pdf ArtifactStore artifact and chat download; no arbitrary output path or publication. Pages use high-resolution raster typography for consistent multilingual layout. Maximum 120 pages/15 MiB. Cancellable on project/revision/account changes. Async, non-transactional; no dry-run.", "generative", serde_json::to_value(schema_for!(Input)).unwrap(), serde_json::to_value(schema_for!(Output)).unwrap());
    d.document_support = DocumentSupport::Classic;
    d.access = AccessLevel::Write; // Fetches only owned image bytes via the active host.
    d.open_world = true;
    d.cancellable = true;
    d.tags = vec!["storyboard".into(), "pdf".into(), "proposal".into(), "export".into()];
    let weak = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(d.clone(), move |context, input| {
        let weak = weak.clone(); let bridge = bridge.clone();
        Box::pin(async move {
            if context.dry_run { return Err(CapabilityError::InvalidInput("PDF rendering does not support dry-run; inspect the storyboard plan first".into())); }
            let rt = weak().ok_or_else(|| CapabilityError::Unavailable("Editor runtime closed".into()))?;
            let args: Input = serde_json::from_value(input).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
            let check = || {
                if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Storyboard export cancelled".into())); }
                let state = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                let p = state.project.as_ref().filter(|p| p.id == args.project_id && p.classic.is_some())
                    .ok_or_else(|| CapabilityError::Conflict("Storyboard project changed".into()))?;
                if state.revision != args.expected_revision || context.metadata.get("opencut/projectId").is_some_and(|v| v.as_str() != Some(&args.project_id)) {
                    return Err(CapabilityError::Conflict("Storyboard project or revision changed".into()));
                }
                let document: GenerativeDocument = serde_json::from_value(p.extensions.get(KEY).cloned().unwrap_or_else(|| json!({}))).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                storyboard::plan(&document, &p.id, state.revision, &p.name).map_err(|e| CapabilityError::InvalidInput(e.to_string()))
            };
            let plan = check()?;
            let reply = bridge.execute(id, "storyboardPdf", &args.project_id, json!({"plan":plan})).await?;
            if check()?.digest != plan.digest { return Err(CapabilityError::Conflict("Storyboard changed while exporting".into())); }
            let output: Output = serde_json::from_value(reply.data.clone()).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
            let stored = rt.artifacts().get(&output.artifact.uri).map_err(|e| CapabilityError::Failed(e.to_string()))?;
            if output.project_id != args.project_id || output.revision != args.expected_revision || output.plan_digest != plan.digest
                || output.artifact != stored.metadata || stored.metadata.mime_type != "application/pdf"
                || stored.metadata.byte_size > 15 * 1024 * 1024 || !stored.bytes.starts_with(b"%PDF-")
                || !stored.bytes.ends_with(b"%%EOF\n") || output.page_count == 0 || output.page_count > 120 {
                return Err(CapabilityError::Conflict("Storyboard PDF artifact or scope differs from the verified plan".into()));
            }
            let mut result = CapabilityResult::data(reply.data);
            result.artifacts.push(stored.metadata);
            Ok(result)
        })
    })))?;
    host.install(&d).map_err(RegistryError::Capability)
}
