//! Active editor rendering, with bounded binary output held by ArtifactStore.
use crate::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderInput {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    #[schemars(range(min = 0))]
    time_ticks: Option<u64>,
    format: Option<Format>,
    #[serde(default)]
    include_audio: bool,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Format {
    Mp4,
    Webm,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderOutput {
    project_id: String,
    revision: u64,
    scene_id: String,
    artifact: ArtifactRef,
    media: Option<VideoInspection>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VideoInspection {
    duration_seconds: f64,
    width: u32,
    height: u32,
    frame_rate: f64,
    packet_count: u64,
    video_tracks: u32,
    audio_tracks: u32,
    codec: String,
}
pub fn register_editor_render_capabilities(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    for (id, title, export) in [
        (
            "editor.preview.render",
            "Render the active editor frame",
            false,
        ),
        (
            "editor.export.render",
            "Export the active editor scene",
            true,
        ),
    ] {
        let mut d = CapabilityDescriptor::read(
            id,
            title,
            if export {
                "Encode the active Classic scene using the production editor compositor, including HyperFrames. Supply sceneId, format (mp4 or webm) and includeAudio; omit timeTicks. Returns a bounded video artifact (maximum 64 MiB) and a download in chat. No arbitrary output path, publication or disk overwrite. Host cancels if project, scene or revision changes. A successful encoding is not a visual or audio quality judgment; review frames before exporting. Async, not transactional, no dryRun."
            } else {
                "Render a frame of the active Classic scene using the production compositor. Supply sceneId and timeTicks (120000 ticks per second); omit format/includeAudio. Returns a bounded JPEG artifact attached as image evidence to the model. No arbitrary filesystem path. Use several times to inspect a remix, then correct source before exporting. This is sampled evidence, not proof of unsampled motion or audio."
            },
            "render",
            serde_json::to_value(schema_for!(RenderInput)).unwrap(),
            serde_json::to_value(schema_for!(RenderOutput)).unwrap(),
        );
        d.document_support = DocumentSupport::Classic;
        d.cancellable = true;
        d.access = AccessLevel::Write; // Renderer execution may fetch composition dependencies.
        d.open_world = true;
        d.tags = vec![
            "hyperframes".into(),
            "render".into(),
            "preview".into(),
            "export".into(),
            "video".into(),
        ];
        let rt = runtime.downgrade();
        let bridge = host.clone();
        runtime.registry().register(Arc::new(FnCapability::new(d.clone(), move |context, input| {
            let rt = rt.clone(); let bridge = bridge.clone();
            Box::pin(async move {
                let rt = rt().ok_or_else(||CapabilityError::Unavailable("Editor runtime closed".into()))?;
                let args: RenderInput = serde_json::from_value(input.clone()).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                if context.dry_run || (export && (args.format.is_none() || args.time_ticks.is_some())) || (!export && (args.time_ticks.is_none() || args.format.is_some() || args.include_audio)) { return Err(CapabilityError::InvalidInput("Invalid render options".into())); }
                let check = || {
                    if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Render cancelled".into())); }
                    let state = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                    let classic = state.project.as_ref().filter(|p| p.id == args.project_id).and_then(|p| p.classic.as_ref());
                    if state.revision != args.expected_revision || classic.is_none_or(|c| c.document["currentSceneId"] != args.scene_id)
                        || context.metadata.get("opencut/projectId").is_some_and(|p| p.as_str()!=Some(&args.project_id)) {
                        return Err(CapabilityError::Conflict("Render project, scene or revision changed".into()));
                    }
                    Ok(())
                };
                check()?;
                let result = bridge.execute(id, "editorRender", &args.project_id, json!({"operation":if export {"export"} else {"preview"},"input":input})).await?;
                check()?;
                let output: RenderOutput = serde_json::from_value(result.data.clone()).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                let stored = rt.artifacts().get(&output.artifact.uri).map_err(|e| CapabilityError::Failed(e.to_string()))?;
                let mime = if export { match args.format { Some(Format::Mp4)=>"video/mp4", _=>"video/webm" } } else {"image/jpeg"};
                let signature = match mime { "image/jpeg"=>stored.bytes.starts_with(&[255,216,255]), "video/webm"=>stored.bytes.starts_with(&[0x1a,0x45,0xdf,0xa3]), _=>stored.bytes.get(4..8)==Some(b"ftyp") };
                if output.project_id!=args.project_id || output.revision!=args.expected_revision || output.scene_id!=args.scene_id || output.artifact!=stored.metadata || stored.metadata.mime_type!=mime || stored.metadata.byte_size==0 || !signature { return Err(CapabilityError::Conflict("Render artifact or scope differs from contract".into())); }
                let inspection = if export {
                    let media = output.media.as_ref().ok_or_else(|| CapabilityError::InvalidInput("Export requires container inspection".into()))?;
                    if !media.duration_seconds.is_finite() || media.duration_seconds <= 0.0 || !media.frame_rate.is_finite() || media.frame_rate <= 0.0 || media.width == 0 || media.height == 0 || media.video_tracks == 0 || media.packet_count == 0 || media.codec.is_empty() || media.codec.len() > 100 || (!args.include_audio && media.audio_tracks != 0) { return Err(CapabilityError::InvalidInput("Invalid encoded video inspection".into())); }
                    Some(rt.artifacts().put(serde_json::to_vec(&json!({"videoArtifact":stored.metadata,"container":media,"scope":"demuxed container metadata; not full visual or audio quality verification"})).unwrap(), "application/vnd.opencut.video-inspection+json", None, None, None).map_err(|e|CapabilityError::Failed(e.to_string()))?)
                } else { None };
                let mut result=CapabilityResult::data(result.data);
                result.artifacts.push(stored.metadata);
                if let Some(inspection) = inspection { result.artifacts.push(inspection); }
                Ok(result)
            })
        })))?;
        host.install(&d).map_err(RegistryError::Capability)?;
    }
    Ok(())
}
