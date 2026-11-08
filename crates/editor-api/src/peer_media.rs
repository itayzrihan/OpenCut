//! Online-device media IO is hosted; project scope and discovered contracts are canonical.
use crate::*;
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    media_id: Option<String>,
    device_id: Option<String>,
    operation_id: Option<String>,
    expected_binding_revision: Option<u64>,
    #[serde(default)]
    resume: bool,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceView { id: String, name: String, last_seen_at: u64 }
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobView {
    operation_id: String, project_id: String, media_id: String, device_id: String,
    expected_binding_revision: u64,
    status: String, phase: String, received_bytes: u64, total_bytes: u64,
    error: Option<String>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output { project_id: String, revision: u64, devices: Vec<DeviceView>, jobs: Vec<JobView>, job: Option<JobView>, linked: bool }

pub fn register_peer_media(runtime: &OpenCutRuntime, host: &HostBridge) -> Result<(), RegistryError> {
    for (id, operation, title) in [
        ("media.devices.list", "devices", "Find my online media devices"),
        ("media.transfer.list", "transfers", "Read this project's original-file downloads"),
        ("media.transfer.start", "start", "Pull a missing original from my device"),
        ("media.transfer.status", "status", "Read original-file transfer progress"),
        ("media.transfer.cancel", "cancel", "Cancel an original-file transfer"),
        ("media.transfer.commit", "commit", "Link a verified downloaded original"),
    ] {
        let mut descriptor = CapabilityDescriptor::read(id, title,
            "Same-Legitate-user online media transfer, Classic host IO. Both devices must opt in and remain online. Devices only see their authenticated user's peers; source reads are limited to an existing project/media ID. start downloads an exact-size original with encrypted bounded chunks, resumable staging and whole-file SHA-256 verification. It returns a job, not completed editing. Poll status using the same operationId; ready means verified bytes exist but are not linked yet. commit uses the existing canonical media-binding transaction and refreshes the editor; all timeline edits stay intact and binding Undo remains available. No arbitrary URL/path, source overwrite, project replacement, API credentials, paid provider or duplicate media ID. Use current project/revision and existing binding revision. A lost reply may have accepted work: reconcile the same operationId; resume=true is explicit and only supported for start. cancel retains partial bytes. External non-transactional IO, Write authority, no dryRun or atomic batches. Enabling sharing or registering a relay is an account setting and cannot be silently changed by the agent.",
            "media", serde_json::to_value(schema_for!(Input)).unwrap(), serde_json::to_value(schema_for!(Output)).unwrap());
        descriptor.document_support = DocumentSupport::Classic;
        descriptor.access = AccessLevel::Write;
        descriptor.open_world = true;
        descriptor.cancellable = true;
        descriptor.idempotent = true;
        descriptor.tags = vec!["media".into(), "devices".into(), "sync".into(), "offline".into(), "relink".into()];
        let weak = runtime.downgrade(); let bridge = host.clone();
        runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(), move |context, input| {
            let weak = weak.clone(); let bridge = bridge.clone();
            Box::pin(async move {
                let invalid = |m: &str| CapabilityError::InvalidInput(m.into());
                let args: Input = serde_json::from_value(input).map_err(|e| invalid(&e.to_string()))?;
                if context.dry_run || !opencut_account_core::transfer::safe_id(&args.project_id)
                    || (args.resume && operation != "start") { return Err(invalid("Invalid transfer request or unsupported dryRun")); }
                for value in [&args.media_id, &args.device_id, &args.operation_id].into_iter().flatten() {
                    if !opencut_account_core::transfer::safe_id(value) { return Err(invalid("Invalid transfer identity")); }
                }
                if !["devices", "transfers"].contains(&operation) && args.operation_id.is_none() { return Err(invalid("A stable operationId is required")); }
                if operation == "start" && (args.media_id.is_none() || args.device_id.is_none() || args.expected_binding_revision.is_none()) {
                    return Err(invalid("Source device, missing media and binding revision are required"));
                }
                let rt = weak().ok_or_else(|| CapabilityError::Unavailable("Editor closed".into()))?;
                let check = |revision: bool| {
                    if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Transfer invocation cancelled; reconcile the same operationId".into())); }
                    let snapshot = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                    if (revision && snapshot.revision != args.expected_revision)
                        || !snapshot.project.as_ref().is_some_and(|p| p.id == args.project_id && p.classic.is_some())
                        || context.metadata.get("opencut/projectId").is_some_and(|p| p.as_str() != Some(&args.project_id)) {
                        return Err(CapabilityError::Conflict("Active transfer project or revision changed".into()));
                    }
                    if operation == "start" {
                        let asset = snapshot.project.as_ref().unwrap().classic.as_ref().unwrap().media_assets.iter()
                            .find(|a| a.get("id").and_then(Value::as_str) == args.media_id.as_deref()).ok_or_else(|| invalid("Missing media is not registered in this project"))?;
                        if asset.get("missing") != Some(&json!(true)) || asset.get("bindingRevision").and_then(Value::as_u64).unwrap_or(0) != args.expected_binding_revision.unwrap() {
                            return Err(CapabilityError::Conflict("Source is available or its binding changed".into()));
                        }
                    }
                    Ok(snapshot.revision)
                };
                check(true)?;
                let reply = bridge.execute_cancellable_preflight(id, "peerMedia", &args.project_id,
                    json!({"operation":operation,"input":args}), Some(serde_json::to_value(schema_for!(Output)).unwrap()), context.cancellation.clone()).await?;
                // commit deliberately runs the already-canonical binding transaction.
                let revision = check(operation != "commit")?;
                if serde_json::to_vec(&reply.data).map_err(|_| invalid("Invalid transfer reply"))?.len() > 65536 { return Err(invalid("Transfer reply is too large")); }
                let result: Output = serde_json::from_value(reply.data).map_err(|e| invalid(&e.to_string()))?;
                if result.project_id != args.project_id || result.revision != revision || result.devices.len() > 64 || result.jobs.len() > 100
                    || result.jobs.iter().any(|j| j.project_id != args.project_id || j.received_bytes > j.total_bytes || j.total_bytes > opencut_account_core::transfer::MAX_FILE_BYTES)
                    || result.job.as_ref().is_some_and(|j| j.project_id != args.project_id || Some(&j.operation_id) != args.operation_id.as_ref()
                        || j.received_bytes > j.total_bytes || j.total_bytes > opencut_account_core::transfer::MAX_FILE_BYTES
                        || !["running", "ready", "failed", "cancelled"].contains(&j.status.as_str())) {
                    return Err(invalid("Transfer host returned an inconsistent scope or progress"));
                }
                Ok(CapabilityResult::data(serde_json::to_value(result).unwrap()))
            })
        })))?;
        host.install(&descriptor).map_err(RegistryError::Capability)?;
    }
    Ok(())
}

pub fn validate_media_pull(request: Value, manifest: Value, local: Value) -> Result<(), String> {
    let request: opencut_account_core::transfer::MediaPullRequest = serde_json::from_value(request).map_err(|e| e.to_string())?;
    let manifest: opencut_account_core::transfer::MediaPullManifest = serde_json::from_value(manifest).map_err(|e| e.to_string())?;
    manifest.validate(&request, &local)
}
