//! External callers prepare reviews through the same host; never approve or unlock.
use crate::generative::{GenerativeDocument, Job, KEY, Reference};
use crate::{
    AccessLevel, CapabilityDescriptor, CapabilityError, CapabilityResult, DocumentSupport,
    FnCapability, HostBridge, InvocationContext, OpenCutRuntime, RegistryError,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub project_id: String,
    pub expected_revision: u64,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[a-zA-Z0-9_-]+$"))]
    pub operation_id: String,
    pub operation: Operation,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    ImportReference {
        #[schemars(length(min = 1, max = 300))]
        name: String,
        mime: String,
        #[schemars(length(min = 4, max = 16_777_216))]
        data_base64: String,
        #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
        sha256: String,
        #[serde(default)]
        storyboard: bool,
    },
    Prepare {
        kind: Kind,
        #[schemars(length(min = 1, max = 200))]
        model: String,
        #[schemars(length(min = 20, max = 90000))]
        prompt: String,
        #[serde(default)]
        duration: Option<u32>,
        #[serde(default)]
        resolution: Option<String>,
        #[serde(default)]
        aspect_ratio: Option<String>,
        #[schemars(length(max = 12))]
        reference_ids: Vec<String>,
        #[serde(default)]
        https_references: std::collections::BTreeMap<String, String>,
    },
    Status {},
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Storyboard,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub project_id: String,
    pub revision: u64,
    pub reference: Option<Reference>,
    pub job: Option<Job>,
    pub jobs: Vec<Job>,
}
fn bad(s: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}

pub fn register_generative_host(
    rt: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let mut d = CapabilityDescriptor::read(
        "project.generative.request",
        "Prepare a Director request in OpenCut",
        "Import a reference (base64 up to12MiB plus original SHA256), prepare a frozen video/storyboard review, or read existing job status in the OPEN Classic project. NEVER sends a paid generation. Human alone enters PIN and approves in OpenCut Generative. First use project.generative.read for instructions and project.generative.edit for script/direction. Video requires a real marked storyboard; original audio/video must have verified HTTPS. Returns artifact metadata/job ID/digest/status; generation is not complete until ready. Same operationId/input replays a saved result; changed input conflicts. Use a NEW operationId with each current expectedRevision for status polls. Explicit project/revision; host IO is nontransactional, not undoable and has no dryRun. Use project.generative.edit for undoable creative changes. No file paths, credentials, approve/unlock or arbitrary provider endpoints. Keep OpenCut open; later results use normal Media import.",
        "generative",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    d.access = AccessLevel::Write;
    d.document_support = DocumentSupport::Classic;
    d.open_world = true;
    d.idempotent = true;
    d.tags = vec![
        "director".into(),
        "generative".into(),
        "review".into(),
        "openrouter".into(),
        "seedance".into(),
    ];
    let weak = rt.downgrade();
    let bridge = host.clone();
    rt.registry().register(Arc::new(FnCapability::new(d.clone(),move |ctx,input| {
        let weak=weak.clone(); let bridge=bridge.clone();
        Box::pin(async move {
            if ctx.dry_run {return Err(bad("Host IO has no dryRun; no request was prepared"));}
            let rt=weak().ok_or_else(||bad("Runtime closed"))?;
            let args: Input=serde_json::from_value(input).map_err(|e|bad(e.to_string()))?;
            let check=|| {
                if ctx.cancellation.is_cancelled() {return Err(bad("Cancelled; reconcile the same operationId in OpenCut"));}
                let s=rt.snapshot().map_err(|e|bad(e.to_string()))?;
                if s.revision!=args.expected_revision || !s.project.as_ref().is_some_and(|p|p.id==args.project_id && p.classic.is_some()) || ctx.metadata.get("opencut/projectId").is_some_and(|p|p.as_str()!=Some(&args.project_id)) {return Err(CapabilityError::Conflict("Director project or revision changed".into()));}
                Ok(s)
            };
            let state=check()?;
            // All supplied reference IDs must belong to the canonical project.
            let document: GenerativeDocument=serde_json::from_value(state.project.as_ref().unwrap().extensions.get(KEY).cloned().unwrap_or(json!({}))).map_err(|e|bad(e.to_string()))?;
            if let Operation::Prepare {ref reference_ids,..}=args.operation {
                if reference_ids.iter().any(|id| !document.references.iter().any(|r| &r.id==id)) {return Err(bad("Attach reference metadata through OpenCut before preparing"));}
            }
            let mut host_input=serde_json::to_value(&args).unwrap();
            if let Operation::Prepare {kind: Kind::Video, ref prompt,..}=args.operation {
                host_input["operation"]["prompt"]=json!(serde_json::to_string(&json!({"direction":prompt,"priority_instructions":crate::generative::INSTRUCTIONS,"original_transcript":document.transcript})).unwrap());
            }
            let reply=bridge.execute_preflight("project.generative.request","generativeReview",&args.project_id,host_input,None).await?;
            check()?;
            let out: Output=serde_json::from_value(reply.data).map_err(|e|bad(e.to_string()))?;
            if out.project_id!=args.project_id || out.revision!=args.expected_revision || out.jobs.len()>200 {return Err(bad("Mismatched Director host reply"));}
            let change=match &args.operation {
                Operation::ImportReference{..} => Some(json!({"type":"reference","reference":out.reference.as_ref().ok_or_else(||bad("Missing imported reference"))?})),
                Operation::Prepare{..} => { let job=out.job.as_ref().filter(|j|j.status=="review").ok_or_else(||bad("Only an unapproved review may be prepared"))?; Some(json!({"type":"job","job":job})) },
                Operation::Status{} => None,
            };
            let revision=if let Some(change)=change {
                let mut inner: InvocationContext=ctx.clone(); inner.metadata.remove("opencut/idempotencyKey");
                rt.registry().invoke("project.generative.edit",inner,json!({"projectId":args.project_id,"expectedRevision":args.expected_revision,"change":change})).await.map_err(|e|bad(e.to_string()))?;
                rt.snapshot().map_err(|e|bad(e.to_string()))?.revision
            }else{args.expected_revision};
            let mut data=serde_json::to_value(out).unwrap(); data["revision"]=json!(revision);
            Ok(CapabilityResult::data(data))
        })
    })))?;
    host.install(&d).map_err(RegistryError::Capability)
}
