//! Browser execution is a preflight only. Rust validates scope and commits via
//! the existing undoable capabilities; no host-owned copy of editor state.
use crate::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportReference {
    project_id: String,
    expected_revision: u64,
    id: String,
    upstream_commit: String,
    name: String,
    start_seconds: Option<f64>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replacement {
    file_path: String,
    find: String,
    replace: String,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remix {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    element_id: String,
    /// Each literal must occur exactly once. Read source before replacing it.
    #[schemars(length(min = 1, max = 32))]
    replacements: Vec<Replacement>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedSource {
    source: HyperframesSource,
    manifest: HyperframesRuntimeManifest,
}
fn invalid(message: impl ToString) -> CapabilityError {
    CapabilityError::InvalidInput(message.to_string())
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;
    #[test]
    fn registered_authoring_and_render_handlers_release_their_registry() {
        let runtime = OpenCutRuntime::full_access().unwrap();
        let weak = runtime.downgrade();
        let host = HostBridge::default();
        register_hyperframes_authoring(&runtime, &host).unwrap();
        register_editor_render_capabilities(&runtime, &host).unwrap();
        assert!(weak().is_some());
        drop(runtime);
        assert!(weak().is_none());
    }
}
fn check(
    runtime: &OpenCutRuntime,
    context: &InvocationContext,
    project: &str,
    revision: u64,
) -> Result<(), CapabilityError> {
    if context.cancellation.is_cancelled() {
        return Err(CapabilityError::Failed("Authoring cancelled".into()));
    }
    let state = runtime.snapshot().map_err(invalid)?;
    if state.project.as_ref().map(|p| p.id.as_str()) != Some(project)
        || state.revision != revision
        || context
            .metadata
            .get("opencut/projectId")
            .is_some_and(|p| p.as_str() != Some(project))
    {
        return Err(CapabilityError::Conflict(
            "Authoring project or revision changed".into(),
        ));
    }
    Ok(())
}
fn descriptor<T: JsonSchema>(id: &str, title: &str, description: &str) -> CapabilityDescriptor {
    let mut d = CapabilityDescriptor::read(
        id,
        title,
        description,
        "hyperframes",
        serde_json::to_value(schema_for!(T)).unwrap(),
        json!({"type":"object"}),
    );
    d.access = AccessLevel::Write;
    d.idempotent = false;
    d.open_world = true;
    d.cancellable = true;
    d.document_support = DocumentSupport::Classic;
    d.tags = vec![
        "hyperframes".into(),
        "remix".into(),
        "source".into(),
        "import".into(),
    ];
    d
}
pub fn register_hyperframes_authoring(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let mut d = descriptor::<ImportReference>(
        "hyperframes.examples.import",
        "Import a prepared HyperFrames reference",
        "Import a verified local example by exact id and upstreamCommit from examples.search/read. The host loads pinned dependencies and measures a runtime manifest; Rust checks every source digest and commits through timeline.hyperframes.import with undo and idempotency. No source code needs to pass through model context. Omit startSeconds to append; zero creates a standalone or overlay clip at the beginning. Async non-transactional preflight, atomic commit. Does not accept dryRun; use examples.read to inspect first.",
    );
    d.output_schema = runtime
        .registry()
        .descriptor("timeline.hyperframes.import")?
        .expect("built-in import")
        .output_schema;
    let rt = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(d.clone(), move |context, input| {
        let rt = rt.clone(); let bridge = bridge.clone();
        Box::pin(async move {
            let rt = rt().ok_or_else(||invalid("Editor runtime closed"))?;
            let args: ImportReference = serde_json::from_value(input.clone()).map_err(invalid)?;
            check(&rt, &context, &args.project_id, args.expected_revision)?;
            if context.dry_run { return Err(invalid("Inspect the reference before import; dryRun is unavailable")); }
            let manifest = rt.registry().invoke("hyperframes.examples.read", InvocationContext::default(), json!({"id":args.id,"upstreamCommit":args.upstream_commit})).await.map_err(invalid)?.result.data;
            let item = &manifest["item"];
            if item["verification"]["status"] != "verified" || item["prepared"]["status"] != "verified" { return Err(invalid("Reference is not verified")); }
            let prepared = item["prepared"].clone();
            let output = bridge.execute_preflight("hyperframes.examples.import", "hyperframesAuthoring", &args.project_id, json!({"operation":"import", "input":input, "prepared":prepared}), Some(serde_json::to_value(schema_for!(PreparedSource)).unwrap())).await?;
            check(&rt, &context, &args.project_id, args.expected_revision)?;
            let source: HyperframesSource = serde_json::from_value(output.data["source"].clone()).map_err(invalid)?;
            if source.entry_file != prepared["entryFile"] || !source.resource_asset_ids.is_empty() || !source.variables.is_empty() || source.files.len() != prepared["files"].as_array().ok_or_else(||invalid("Missing prepared files"))?.len() { return Err(invalid("Prepared package differs from catalog")); }
            for file in prepared["files"].as_array().unwrap() {
                let path = file["path"].as_str().ok_or_else(||invalid("Missing path"))?;
                hyperframes_reference_source(json!({"projectId":args.project_id,"expectedRevision":args.expected_revision,"id":args.id,"upstreamCommit":args.upstream_commit,"filePath":format!("@prepared/{path}"),"expectedSha256":file["sha256"]}), Some(source.files.get(path).ok_or_else(||invalid("Missing prepared file"))?))?;
            }
            let receipt = rt.registry().invoke("timeline.hyperframes.import", context, json!({"projectId":args.project_id,"expectedRevision":args.expected_revision,"name":args.name,"startSeconds":args.start_seconds,"source":source,"resolvedDurationSeconds":output.data["manifest"]["durationSeconds"],"runtimeManifest":output.data["manifest"]})).await.map_err(invalid)?;
            Ok(receipt.result)
        })
    })))?;
    host.install(&d).map_err(RegistryError::Capability)?;
    let mut d = descriptor::<Remix>(
        "hyperframes.composition.remix",
        "Remix and preflight a HyperFrames clip",
        "Apply up to 32 exact literal source replacements to one timeline occurrence. Each find must occur exactly once in filePath. The imported assetId is a key under /project/classic/document/hyperframesCompositions. Read /project/classic/document/hyperframesCompositions/<assetId>/source/entryFile, then /source/files/<JSON-Pointer-escaped filePath> with app.state.read; avoid reading all bundled JavaScript into context. The host executes a new isolated runtime to measure its manifest, then Rust commits via hyperframes.source.set with undo, source fingerprint, revision and shared-occurrence detachment. Placement and duration remain unchanged. Async non-transactional preflight with atomic commit; source may request network resources. Does not accept dryRun. After edits inspect rendered frames and correct problems before export.",
    );
    d.output_schema = runtime
        .registry()
        .descriptor("hyperframes.source.set")?
        .expect("built-in source edit")
        .output_schema;
    let rt = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(d.clone(), move |context, input| {
        let rt = rt.clone(); let bridge = bridge.clone();
        Box::pin(async move {
            let rt = rt().ok_or_else(||invalid("Editor runtime closed"))?;
            let args: Remix = serde_json::from_value(input).map_err(invalid)?;
            check(&rt, &context, &args.project_id, args.expected_revision)?;
            if context.dry_run { return Err(invalid("Remix requires renderer preflight; dryRun is unavailable")); }
            let state = rt.snapshot().map_err(invalid)?;
            let classic = state.project.as_ref().and_then(|p| p.classic.as_ref()).ok_or_else(||invalid("Classic project required"))?;
            let rows = classic.hyperframes_layer_rows(&args.scene_id, &args.element_id).map_err(invalid)?;
            let composition = classic.document.compositions.as_ref().and_then(|c| c.get(&rows.composition_id)).ok_or_else(||invalid("Missing composition"))?;
            let source = &composition.source;
            let mut changes = BTreeMap::<String, Option<String>>::new();
            for replacement in args.replacements {
                let text = changes.get(&replacement.file_path).and_then(|s| s.as_ref()).or_else(|| source.files.get(&replacement.file_path)).ok_or_else(||invalid("Replacement file is missing"))?;
                if replacement.find.is_empty() || text.matches(&replacement.find).count() != 1 { return Err(invalid("Replacement must match exactly once; read current source")); }
                let next = text.replacen(&replacement.find, &replacement.replace, 1);
                changes.insert(replacement.file_path, Some(next));
            }
            let prepared = rt.registry().invoke("hyperframes.source.prepare", InvocationContext::default(), json!({"source":source,"changes":changes})).await.map_err(invalid)?.result.data;
            let output = bridge.execute_preflight("hyperframes.composition.remix", "hyperframesAuthoring", &args.project_id, json!({"operation":"remix","projectId":args.project_id,"expectedRevision":args.expected_revision,"source":prepared["source"]}), Some(serde_json::to_value(schema_for!(PreparedSource)).unwrap())).await?;
            check(&rt, &context, &args.project_id, args.expected_revision)?;
            let receipt = rt.registry().invoke("hyperframes.source.set", context, json!({"projectId":args.project_id,"expectedRevision":args.expected_revision,"sceneId":args.scene_id,"elementId":args.element_id,"sourceFingerprint":source.fingerprint(),"changes":changes,"manifest":output.data["manifest"]})).await.map_err(invalid)?;
            Ok(receipt.result)
        })
    })))?;
    host.install(&d).map_err(RegistryError::Capability)
}
