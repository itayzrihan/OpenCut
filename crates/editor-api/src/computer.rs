//! Electron-only, explicitly enabled host IO. No host adapter is installed in web/MCP servers.
use crate::{
    AccessLevel, AgentMode, CapabilityDescriptor, CapabilityError, CapabilityResult,
    DocumentSupport, FnCapability, HostBridge, OpenCutRuntime, RegistryError,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ComputerOperation {
    List {
        path: String,
    },
    Read {
        path: String,
        #[serde(default)]
        offset: u64,
    },
    Write {
        path: String,
        content: String,
        expected_sha256: Option<String>,
    },
    Mkdir {
        path: String,
    },
    Copy {
        path: String,
        destination: String,
    },
    Move {
        path: String,
        destination: String,
    },
    Remove {
        path: String,
    },
    Shell {
        command: String,
        cwd: String,
        timeout_ms: u32,
    },
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComputerInput {
    project_id: String,
    expected_revision: u64,
    operation: ComputerOperation,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComputerOutput {
    text: String,
}

pub fn register_computer_capabilities(
    runtime: &OpenCutRuntime,
    bridge: &HostBridge,
) -> Result<(), RegistryError> {
    for (id, title, read) in [
        ("computer.files.inspect", "Inspect computer files", true),
        ("computer.files.change", "Change computer files", false),
        ("computer.terminal.execute", "Run a terminal command", false),
    ] {
        let mut descriptor = CapabilityDescriptor::read(
            id,
            title,
            "Electron-only computer access, disabled by default. inspect accepts list/read; change accepts write/mkdir/copy/move/remove; terminal accepts shell. Absolute paths required. Read returns a bounded UTF-8 chunk (offset in bytes); binary files require another tool. Write requires expectedSha256 for existing files (read first); null creates a new file exclusively. Copy/move do not overwrite. Remove is recursive. Shell has cwd, timeoutMs (1..120000), bounded output; every shell and file change asks native approval in askDestructive mode. FullAccess executes without individual prompts. Plan permits inspect only. Results are bounded text/JSON; do not read credentials or modify permission controls. External changes cannot be undone in the editor. Never retry an uncertain external effect with a new identity.",
            "computer",
            serde_json::to_value(schema_for!(ComputerInput)).expect("schema"),
            serde_json::to_value(schema_for!(ComputerOutput)).expect("schema"),
        );
        descriptor.access = if read {
            AccessLevel::Read
        } else {
            AccessLevel::Destructive
        };
        descriptor.open_world = true;
        descriptor.transactional = false;
        descriptor.cancellable = true;
        descriptor.document_support = DocumentSupport::Both;
        descriptor.tags = ["computer", "files", "terminal", "electron"]
            .map(str::to_owned)
            .to_vec();
        let state = runtime.state.clone();
        let host = bridge.clone();
        runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(), move |context, input| {
            let state = state.clone(); let host = host.clone();
            Box::pin(async move {
                let input: ComputerInput = serde_json::from_value(input).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
                if context.dry_run || context.cancellation.is_cancelled() { return Err(CapabilityError::Denied("Computer IO cancelled or dry-run unsupported".into())); }
                let inspect = matches!(input.operation, ComputerOperation::List{..}|ComputerOperation::Read{..});
                let shell = matches!(input.operation, ComputerOperation::Shell{..});
                if (id == "computer.files.inspect") != inspect || (id == "computer.terminal.execute") != shell { return Err(CapabilityError::InvalidInput("Operation differs from capability contract".into())); }
                let policy = {
                    let state=state.read().map_err(|_|CapabilityError::Failed("editor lock".into()))?;
                    if state.active_project_id()!=Some(&input.project_id) || state.document.revision!=input.expected_revision { return Err(CapabilityError::Conflict("Computer operation scope changed".into())); }
                    if context.metadata.get("opencut/projectId").is_some_and(|v|v.as_str()!=Some(&input.project_id)) { return Err(CapabilityError::Denied("Computer operation scope differs".into())); }
                    state.document.agent_policy.clone()
                };
                if !policy.computer_access || (policy.mode==AgentMode::Plan && !inspect) { return Err(CapabilityError::Denied("Computer access disabled by agent policy".into())); }
                let operation_id=context.request_id.ok_or_else(||CapabilityError::InvalidInput("Computer IO needs a host operation identity".into()))?;
                let output=host.execute(id,"computer",&input.project_id,serde_json::json!({"operationId":operation_id,"projectId":input.project_id,"generation":policy.generation,"mode":policy.mode,"operation":input.operation})).await?;
                Ok(CapabilityResult::data(output.data))
            })
        })))?;
        bridge
            .install(&descriptor)
            .map_err(RegistryError::Capability)?;
    }
    Ok(())
}
