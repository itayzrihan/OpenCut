//! Synthesis is sandboxed host IO; validation and binary artifacts remain canonical.
use crate::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    procedural: ProceduralAudioSource,
    #[serde(default)]
    #[schemars(range(min = 0, max = 30))]
    offset_seconds: f64,
    #[schemars(range(min = 0.02, max = 8))]
    duration_seconds: Option<f64>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostPcm {
    #[schemars(range(min = 1, max = 2))]
    channels: u32,
    #[schemars(length(max = 2048000))]
    pcm16_base64: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    project_id: String,
    revision: u64,
    artifact: ArtifactRef,
    sample_rate: u32,
    channels: u32,
    frames: u32,
    source_duration_seconds: f64,
    offset_seconds: f64,
    duration_seconds: f64,
    peak: f64,
    rms: f64,
}

pub fn register_earshot_preview(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let mut descriptor = CapabilityDescriptor::read(
        "audio.earshot.preview",
        "Synthesize and inspect an Earshot sound",
        "Preflight the complete bounded Earshot recipe using the same isolated synthesis engine as timeline playback and export. Return a listenable WAV artifact and measured peak/RMS for a requested window (up to 8 seconds, defaults to first 8 seconds or source end). offsetSeconds selects later sections. Accepts preset, duration, seed, pitch, parameters, echo and full sourceCode. Does not insert a clip, create a media file, or change the project. The WAV is an ephemeral bounded ArtifactStore preview, not the timeline source. Requires the active Classic project and exact expectedRevision. Host execution may load pinned synthesis dependencies; no arbitrary URL/path or filesystem access. Supports cancellation; no dryRun or atomic transactions. Measured PCM is not a subjective quality judgment.",
        "audio",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    descriptor.document_support = DocumentSupport::Classic;
    descriptor.access = AccessLevel::Write;
    descriptor.open_world = true;
    descriptor.cancellable = true;
    descriptor.idempotent = false;
    descriptor.tags = vec![
        "earshot".into(),
        "procedural".into(),
        "sound-effects".into(),
        "preview".into(),
        "preflight".into(),
        "audio".into(),
    ];
    let weak = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(), move |context, input| {
        let weak = weak.clone();
        let bridge = bridge.clone();
        Box::pin(async move {
            let invalid = |message: &str| CapabilityError::InvalidInput(message.into());
            let rt = weak().ok_or_else(|| CapabilityError::Unavailable("Editor runtime closed".into()))?;
            let args: Input = serde_json::from_value(input).map_err(|e| invalid(&e.to_string()))?;
            args.procedural.validate().map_err(|e| invalid(&e))?;
            let remaining = args.procedural.duration - args.offset_seconds;
            let duration = args.duration_seconds.unwrap_or(remaining.min(8.0));
            if context.dry_run || !args.offset_seconds.is_finite() || args.offset_seconds < 0.0
                || !duration.is_finite() || !(0.02..=8.0).contains(&duration) || duration > remaining + 1e-9 {
                return Err(invalid("Preview must be a 0.02..8 second window inside the source; dryRun is unsupported"));
            }
            let start_frame = (args.offset_seconds * 48000.0).round() as u32;
            let frames = ((duration * 48000.0).round() as u32).min((args.procedural.duration * 48000.0).round() as u32 - start_frame);
            let check = || {
                if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Earshot preview cancelled".into())); }
                let state = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                if state.revision != args.expected_revision || !state.project.as_ref().is_some_and(|p| p.id == args.project_id && p.classic.is_some())
                    || context.metadata.get("opencut/projectId").is_some_and(|p| p.as_str() != Some(&args.project_id)) {
                    return Err(CapabilityError::Conflict("Earshot preview project or revision changed".into()));
                }
                Ok(())
            };
            check()?;
            let result = bridge.execute_cancellable_preflight("audio.earshot.preview", "earshotPreview", &args.project_id,
                json!({"projectId":args.project_id,"expectedRevision":args.expected_revision,"procedural":args.procedural,"startFrame":start_frame,"frames":frames}),
                Some(serde_json::to_value(schema_for!(HostPcm)).unwrap()), context.cancellation.clone()).await?;
            check()?;
            let pcm: HostPcm = serde_json::from_value(result.data).map_err(|e| invalid(&e.to_string()))?;
            let bytes = STANDARD.decode(&pcm.pcm16_base64).map_err(|_| invalid("Invalid preview PCM encoding"))?;
            if !(1..=2).contains(&pcm.channels) || bytes.len() != frames as usize * pcm.channels as usize * 2 {
                return Err(invalid("Preview PCM channel/sample count differs from requested window"));
            }
            let mut peak = 0.0_f64;
            let mut energy = 0.0;
            for value in bytes.chunks_exact(2) {
                let sample = f64::from(i16::from_le_bytes([value[0], value[1]])) / 32768.0;
                peak = peak.max(sample.abs());
                energy += sample * sample;
            }
            let rms = (energy / (frames * pcm.channels) as f64).sqrt();
            let mut wav = Vec::with_capacity(44 + bytes.len());
            wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(36 + bytes.len() as u32).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt "); wav.extend_from_slice(&16_u32.to_le_bytes());
            wav.extend_from_slice(&1_u16.to_le_bytes()); wav.extend_from_slice(&(pcm.channels as u16).to_le_bytes());
            wav.extend_from_slice(&48000_u32.to_le_bytes()); wav.extend_from_slice(&(48000 * pcm.channels * 2).to_le_bytes());
            wav.extend_from_slice(&(pcm.channels as u16 * 2).to_le_bytes()); wav.extend_from_slice(&16_u16.to_le_bytes());
            wav.extend_from_slice(b"data"); wav.extend_from_slice(&(bytes.len() as u32).to_le_bytes()); wav.extend_from_slice(&bytes);
            let artifact = rt.artifacts().put(wav, "audio/wav", None, None, Some((frames as f64 / 48.0).round() as u64))
                .map_err(|e| CapabilityError::Failed(e.to_string()))?;
            let mut result = CapabilityResult::data(serde_json::to_value(Output {
                project_id: args.project_id, revision: args.expected_revision, artifact: artifact.clone(), sample_rate: 48000,
                channels: pcm.channels, frames, source_duration_seconds: args.procedural.duration,
                offset_seconds: start_frame as f64 / 48000.0, duration_seconds: frames as f64 / 48000.0, peak, rms,
            }).unwrap());
            result.artifacts.push(artifact);
            Ok(result)
        })
    })))?;
    host.install(&descriptor).map_err(RegistryError::Capability)
}
