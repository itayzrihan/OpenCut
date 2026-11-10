//! Bounded source-video observation through the same active editor host.
use crate::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    media_id: String,
    #[schemars(length(min = 1, max = 8))]
    times_ms: Vec<u32>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostFrame {
    time_ms: u32,
    artifact_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostOutput {
    project_id: String,
    revision: u64,
    media_id: String,
    duration_ms: u32,
    width: u32,
    height: u32,
    frames: Vec<HostFrame>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Frame {
    time_ms: u32,
    artifact: ArtifactRef,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    project_id: String,
    revision: u64,
    media_id: String,
    duration_ms: u32,
    width: u32,
    height: u32,
    frames: Vec<Frame>,
    scope: String,
}
pub fn register_production_video(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let id = "project.production.video.inspect";
    let mut descriptor = CapabilityDescriptor::read(
        id,
        "Observe bounded frames from an owned source video",
        "Decode 1..8 explicitly requested source-video timestamps locally in the active browser/Electron editor. Input timesMs are source milliseconds, not timeline ticks. Source must be a canonical available Classic video mediaId. Returns actual decoded duration/dimensions and bounded JPEG ArtifactStore frames (max640px/180KB each), attached as model evidence. No source upload, paid inference, timeline mutation, arbitrary URL/path or invented motion/audio conclusions. Sampled frames do not prove unsampled motion, speech or the entire video; combine with real transcript/audio tools. Scope/revision checked before and after host work; cancellable, non-transactional, no dry-run.",
        "production",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    descriptor.access = AccessLevel::Write;
    descriptor.open_world = true;
    descriptor.cancellable = true;
    descriptor.document_support = DocumentSupport::Classic;
    descriptor.tags = vec![
        "video".into(),
        "frames".into(),
        "analysis".into(),
        "evidence".into(),
        "production".into(),
    ];
    let weak = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(),move|context,value|{let weak=weak.clone();let bridge=bridge.clone();Box::pin(async move{
        let args:Input=serde_json::from_value(value.clone()).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
        if context.dry_run||args.times_ms.is_empty()||args.times_ms.len()>8||args.times_ms.iter().any(|t|*t>=86_400_000)||args.times_ms.iter().collect::<std::collections::BTreeSet<_>>().len()!=args.times_ms.len(){return Err(CapabilityError::InvalidInput("Choose1..8 unique source timestamps; no dry-run".into()));}
        let rt=weak().ok_or_else(||CapabilityError::Unavailable("Editor closed".into()))?;
        let check=||{
            if context.cancellation.is_cancelled(){return Err(CapabilityError::Failed("Video inspection cancelled".into()));}
            let document=rt.snapshot().map_err(|e|CapabilityError::Failed(e.to_string()))?;
            let media=document.project.as_ref().filter(|p|p.id==args.project_id).and_then(|p|p.classic.as_ref()).and_then(|c|c.media_assets.iter().find(|m|m.get("id").and_then(|v|v.as_str())==Some(&args.media_id)&&m.get("type").and_then(|v|v.as_str())==Some("video")));
            if document.revision!=args.expected_revision||media.is_none()||context.metadata.get("opencut/projectId").is_some_and(|p|p.as_str()!=Some(&args.project_id)){return Err(CapabilityError::Conflict("Video inspection source, project or revision changed".into()));}Ok(())
        };check()?;
        let reply=bridge.execute(id,"productionVideoFrames",&args.project_id,value).await?;check()?;
        let output:HostOutput=serde_json::from_value(reply.data).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
        if output.project_id!=args.project_id||output.revision!=args.expected_revision||output.media_id!=args.media_id||output.duration_ms==0||output.duration_ms>86_400_000||output.width==0||output.height==0||output.width>32768||output.height>32768||output.frames.len()!=args.times_ms.len(){return Err(CapabilityError::Conflict("Video observation scope differs from request".into()));}
        let mut frames=Vec::new();let mut evidence=Vec::new();
        for (frame,time) in output.frames.into_iter().zip(args.times_ms){
            let artifact=rt.artifacts().get(&frame.artifact_id).map_err(|e|CapabilityError::InvalidInput(e.to_string()))?;
            if frame.time_ms!=time||time>=output.duration_ms||artifact.metadata.mime_type!="image/jpeg"||artifact.metadata.byte_size>180000||!artifact.bytes.starts_with(&[255,216,255]){return Err(CapabilityError::Conflict("Video frame differs from requested timestamp or bounded JPEG contract".into()));}
            evidence.push(artifact.metadata.clone());frames.push(Frame{time_ms:time,artifact:artifact.metadata});
        }
        let out=Output{project_id:output.project_id,revision:output.revision,media_id:output.media_id,duration_ms:output.duration_ms,width:output.width,height:output.height,frames,scope:"Sampled decoded source frames only. No audio, motion or unsampled interval verification.".into()};
        let mut result=CapabilityResult::data(serde_json::to_value(out).unwrap());result.artifacts=evidence;Ok(result)
    })})))?;
    // The browser returns artifact IDs; only the runtime can resolve verified
    // metadata and publish the public capability output.
    descriptor.output_schema = serde_json::to_value(schema_for!(HostOutput)).unwrap();
    host.install(&descriptor).map_err(RegistryError::Capability)
}
