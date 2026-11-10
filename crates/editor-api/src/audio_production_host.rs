//! Agent may prepare an ElevenLabs review, never approve or obtain credentials.
use crate::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    draft_id: String,
    expected_draft_version: u64,
    operation_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    project_id: String,
    revision: u64,
    job_id: String,
    digest: String,
    status: String,
}
pub fn register_audio_production_host(
    rt: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let id = "project.audio.request";
    let mut d = CapabilityDescriptor::read(
        id,
        "Prepare audio generation approval",
        "Prepare a frozen ElevenLabs speech/dialogue/sound/music review from an existing canonical audio draft, then reveal The Director Audio tab. First project.audio.draft.edit; preserves the original language. Human alone enters PIN and approves the paid request. Cannot authorize, unlock, submit or retry paid work. Same operationId replays identical review; a new edited draft needs a new operationId. Explicit project/revision/draft version. Account-scoped host IO, no arbitrary paths or provider endpoints. Nontransactional, no dry-run.",
        "audio",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    d.access = AccessLevel::Write;
    d.document_support = DocumentSupport::Classic;
    d.open_world = true;
    d.idempotent = true;
    d.cancellable = true;
    d.tags = vec![
        "elevenlabs".into(),
        "speech".into(),
        "music".into(),
        "sound".into(),
        "director".into(),
    ];
    let weak = rt.downgrade();
    let bridge = host.clone();
    rt.registry().register(Arc::new(FnCapability::new(d.clone(),move|ctx,input|{let weak=weak.clone();let bridge=bridge.clone();Box::pin(async move{
        let bad=|message:&str|CapabilityError::InvalidInput(message.into());
        if ctx.dry_run{return Err(bad("Audio request preparation has no dry-run"));}
        let rt=weak().ok_or_else(||bad("Runtime closed"))?;
        let i:Input=serde_json::from_value(input).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
        if i.operation_id.is_empty()||i.operation_id.len()>128||!i.operation_id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-'){return Err(bad("Invalid audio operation ID"));}
        let check=||{
            if ctx.cancellation.is_cancelled(){return Err(bad("Audio preparation cancelled"));}
            let s=rt.snapshot().map_err(|e|CapabilityError::Failed(e.to_string()))?;
            let p=s.project.as_ref().filter(|p|p.id==i.project_id&&p.classic.is_some()).ok_or_else(||bad("Project changed"))?;
            if s.revision!=i.expected_revision||ctx.metadata.get("opencut/projectId").is_some_and(|v|v.as_str()!=Some(&i.project_id)){return Err(CapabilityError::Conflict("Audio project or revision changed".into()));}
            let audio:crate::audio_production::AudioProduction=serde_json::from_value(p.extensions.get(crate::audio_production::KEY).cloned().unwrap_or(json!({}))).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
            audio.drafts.into_iter().find(|d|d.id==i.draft_id&&d.version==i.expected_draft_version).ok_or_else(||CapabilityError::Conflict("Audio draft changed".into()))
        };
        let draft=check()?;
        let reply=bridge.execute_cancellable_preflight(id,"audioProduction",&i.project_id,json!({"projectId":i.project_id,"expectedRevision":i.expected_revision,"operationId":i.operation_id,"draft":draft}),Some(serde_json::to_value(schema_for!(Output)).unwrap()),ctx.cancellation.clone()).await?;
        check()?;let out:Output=serde_json::from_value(reply.data.clone()).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
        if out.project_id!=i.project_id||out.revision!=i.expected_revision||out.status!="review"||out.job_id.len()!=32||out.digest.len()!=64{return Err(bad("Invalid audio review reply"));}
        Ok(CapabilityResult::data(reply.data))
    })})))?;
    host.install(&d).map_err(RegistryError::Capability)
}
