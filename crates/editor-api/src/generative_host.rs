//! External callers prepare reviews through the same host; never approve or unlock.
use crate::generative::{GenerativeDocument, Job, KEY, Reference};
use crate::{
    AccessLevel, CapabilityDescriptor, CapabilityError, CapabilityResult, DocumentSupport,
    FnCapability, HostBridge, InvocationContext, OpenCutRuntime, RegistryError,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
mod storyboard_export;

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
    /// Resolve already owned image bytes internally; never pass binary through a model.
    ImportArtifactReference {
        #[schemars(
            length(min = 1, max = 160),
            regex(pattern = "^artifact-[a-zA-Z0-9_-]+$")
        )]
        artifact_id: String,
        #[schemars(length(min = 1, max = 300))]
        name: String,
        #[serde(default)]
        storyboard: bool,
    },
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
    PrepareChapters {
        plan_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<crate::generative::chapters::BatchLink>,
}
fn bad(s: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}

fn owned_image_artifact(
    rt: &OpenCutRuntime,
    state: &crate::EditorDocument,
    artifact_id: &str,
) -> Result<crate::StoredArtifact, CapabilityError> {
    let stored = rt
        .artifacts()
        .get(artifact_id)
        .map_err(|e| bad(e.to_string()))?;
    let mime = stored.metadata.mime_type.as_str();
    let signature = match mime {
        "image/png" => {
            stored.bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && stored.bytes.len() >= 24
                && stored.bytes.get(12..16) == Some(b"IHDR")
        }
        "image/jpeg" => stored.bytes.starts_with(&[255, 216, 255]),
        _ => false,
    };
    if stored.bytes.is_empty()
        || stored.bytes.len() > 12 * 1024 * 1024
        || !signature
        || stored.metadata.byte_size != stored.bytes.len() as u64
        || stored.metadata.sha256 != format!("{:x}", Sha256::digest(&stored.bytes))
    {
        return Err(bad(
            "Import a stored PNG/JPEG of at most 12 MiB with its original verified bytes; no resizing or re-encoding is performed",
        ));
    }
    let images = &state
        .project
        .as_ref()
        .and_then(|p| p.classic.as_ref())
        .ok_or_else(|| bad("Open the image's Classic project"))?
        .media_assets;
    // Artifacts are runtime-wide. Bind bytes to an actual current project image,
    // not merely an artifact ID that survived a project switch. A recovered
    // imagegen result can have a new artifact ID for exactly the same content.
    let owned = images.iter().any(|image| {
        if image.get("type").and_then(|v| v.as_str()) != Some("image")
            || image.get("mimeType").and_then(|v| v.as_str()) != Some(mime)
            || image.get("size").and_then(|v| v.as_u64()) != Some(stored.metadata.byte_size)
        {
            return false;
        }
        let Some(binding) = image.get("generation") else {
            return false;
        };
        if binding.get("sha256").and_then(|v| v.as_str()) != Some(stored.metadata.sha256.as_str()) {
            return false;
        }
        let Some(bound_id) = binding.get("artifactId").and_then(|v| v.as_str()) else {
            return false;
        };
        rt.artifacts().get(bound_id).is_ok_and(|bound| {
            bound.metadata.id == bound_id
                && bound.metadata.sha256 == stored.metadata.sha256
                && bound.metadata.mime_type == mime
                && bound.metadata.byte_size == stored.metadata.byte_size
                && bound.bytes == stored.bytes
        })
    });
    if !owned {
        return Err(CapabilityError::Denied(
            "The image artifact is not bound to media in this project".into(),
        ));
    }
    Ok(stored)
}

pub fn register_generative_host(
    rt: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let mut d = CapabilityDescriptor::read(
        "project.generative.request",
        "Prepare a Director request in OpenCut",
        "Import an owned image by importArtifactReference {artifactId,name,storyboard}: resolve a PNG/JPEG at most12MiB already bound to this project's media, verify original SHA256, and transfer internally without model-visible binary. Use this after human-reviewed imagegen.generate, then project.production.edit addReferenceVersion with returned reference.id and the intended stable slot. Existing importReference accepts externally supplied base64 up to12MiB plus SHA256. Prepare a frozen video/storyboard review or read job status in the OPEN Classic project. NEVER sends a paid generation. Human alone approves the exact request and PIN in OpenCut Generative. First read project.generative.read. Storyboards optional. Original audio/video references need verified HTTPS. prepareChapters takes a canonical planId and validates captured sources before preparing one frozen review per chapter and batch manifest. Returns reference/job metadata only; generation is complete only when ready. Same operationId/input replays a saved result; changed input conflicts. Use a new operationId/current expectedRevision for status polls. Explicit project/revision, cancellable host IO, no transaction or dryRun. No file paths, credentials, approve/unlock or arbitrary provider endpoints. Keep OpenCut open.",
        "generative",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    d.access = AccessLevel::Write;
    d.document_support = DocumentSupport::Classic;
    d.open_world = true;
    d.cancellable = true;
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
            let imported_artifact=if let Operation::ImportArtifactReference {ref artifact_id, ref name, storyboard}=args.operation {
                if name.trim().is_empty() || name.len()>300 || name.contains(['/', '\\', '\0']) {return Err(bad("Use a display filename of at most 300 UTF-8 bytes, not a path, for the imported image"));}
                let stored=owned_image_artifact(&rt,&state,artifact_id)?;
                host_input["operation"]=json!({"type":"importReference","name":name,"mime":stored.metadata.mime_type,"dataBase64":STANDARD.encode(&stored.bytes),"sha256":stored.metadata.sha256,"storyboard":storyboard});
                Some(stored.metadata)
            }else{None};
            if let Operation::Prepare {kind: Kind::Video, ref prompt,..}=args.operation {
                host_input["operation"]["prompt"]=json!(serde_json::to_string(&json!({"direction":prompt,"priority_instructions":crate::generative::INSTRUCTIONS,"original_transcript":document.transcript})).unwrap());
            }
            if let Operation::PrepareChapters {ref plan_id}=args.operation {
                let plan=document.chapter_plans.iter().find(|p|&p.id==plan_id).ok_or_else(||bad("Chapter plan missing"))?;
                if plan.batch_id.is_some(){return Err(bad("This chapter plan already has prepared requests. Read its existing batch and job status instead."));}
                let workspace:crate::production::ProductionWorkspace=serde_json::from_value(state.project.as_ref().unwrap().extensions.get(crate::production::KEY).cloned().unwrap_or(json!({}))).map_err(|e|bad(e.to_string()))?;
                plan.check_sources(&workspace,&document).map_err(|e|bad(e.to_string()))?;
                host_input["operation"]["plan"]=serde_json::to_value(plan).unwrap();
            }
            let reply=bridge.execute_preflight("project.generative.request","generativeReview",&args.project_id,host_input,None).await?;
            let settled_state=check()?;
            if let Operation::ImportArtifactReference {ref artifact_id,..}=args.operation {
                let current=owned_image_artifact(&rt,&settled_state,artifact_id)?;
                if imported_artifact.as_ref()!=Some(&current.metadata){return Err(CapabilityError::Conflict("The imported artifact changed before its reference was committed".into()));}
            }
            let out: Output=serde_json::from_value(reply.data).map_err(|e|bad(e.to_string()))?;
            if out.project_id!=args.project_id || out.revision!=args.expected_revision || out.jobs.len()>200 {return Err(bad("Mismatched Director host reply"));}
            if let Operation::ImportArtifactReference {ref name,storyboard,..}=args.operation {
                let source=imported_artifact.as_ref().unwrap();
                if !out.reference.as_ref().is_some_and(|reference| reference.name==*name && reference.kind==crate::generative::ReferenceKind::Image && reference.mime==source.mime_type && reference.bytes==source.byte_size && reference.storyboard==storyboard) || out.job.is_some() || !out.jobs.is_empty() || out.batch.is_some() {return Err(bad("Imported reference receipt differs from the verified image"));}
            }
            let change=match &args.operation {
                Operation::ImportReference{..}|Operation::ImportArtifactReference{..} => Some(json!({"type":"reference","reference":out.reference.as_ref().ok_or_else(||bad("Missing imported reference"))?})),
                Operation::Prepare{..} => { let job=out.job.as_ref().filter(|j|j.status=="review").ok_or_else(||bad("Only an unapproved review may be prepared"))?; Some(json!({"type":"job","job":job})) },
                Operation::PrepareChapters{plan_id} => {
                    let plan=document.chapter_plans.iter().find(|p|&p.id==plan_id).unwrap();let batch=out.batch.as_ref().filter(|b|&b.plan_id==plan_id&&b.version==plan.version&&b.job_ids.len()==plan.chapters.len()).ok_or_else(||bad("Mismatched chapter batch receipt"))?;
                    if out.jobs.len()!=batch.job_ids.len()||out.jobs.iter().zip(&batch.job_ids).any(|(j,id)|&j.id!=id||j.status!="review"){return Err(bad("Only unapproved matching chapter requests may be prepared"));}
                    Some(json!({"type":"chapterBatch","planId":plan_id,"version":plan.version,"batchId":batch.id,"jobIds":batch.job_ids,"jobs":out.jobs}))
                },
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
    host.install(&d).map_err(RegistryError::Capability)?;
    storyboard_export::register(rt, host)
}
