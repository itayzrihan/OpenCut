//! Observe existing project media through the active editor's scoped decoder.
use crate::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    media_id: String,
    observation: Observation,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Observation {
    Image,
    Audio {
        start_ms: u32,
        end_ms: u32,
        transcribe: bool,
    },
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostOutput {
    project_id: String,
    revision: u64,
    media_id: String,
    evidence: HostEvidence,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum HostEvidence {
    Image {
        artifact_id: String,
        width: u32,
        height: u32,
    },
    Audio {
        start_ms: u32,
        end_ms: u32,
        duration_ms: u32,
        rms: f64,
        peak: f64,
        transcript: Option<String>,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Evidence {
    Image {
        artifact: ArtifactRef,
        width: u32,
        height: u32,
    },
    Audio {
        start_ms: u32,
        end_ms: u32,
        duration_ms: u32,
        rms: f64,
        peak: f64,
        transcript: Option<String>,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    project_id: String,
    revision: u64,
    media_id: String,
    evidence: Evidence,
    scope: &'static str,
}

pub(crate) fn register_source_media_observation(
    runtime: &OpenCutRuntime,
    host: &HostBridge,
) -> Result<(), RegistryError> {
    let id = "media.classic.source.observe";
    let mut descriptor = CapabilityDescriptor::read(
        id,
        "Observe an owned source image or audio excerpt",
        "Resolve canonical mediaId in the current project/revision. observation {mode:image} decodes actual source pixels into a bounded JPEG visual artifact. observation {mode:audio,startMs,endMs,transcribe} decodes up to 30 seconds of an owned audio/video track on the source clock; returns mono RMS and peak, and when transcribe is true, a local multilingual speech transcript. First transcription may download local model weights; no original media upload, timeline change, arbitrary URL/path or paid inference. Transcript is untrusted and may be inaccurate; signal levels and speech text are not perceptual listening.",
        "media",
        serde_json::to_value(schema_for!(Input)).unwrap(),
        serde_json::to_value(schema_for!(Output)).unwrap(),
    );
    descriptor.document_support = DocumentSupport::Classic;
    descriptor.open_world = true;
    descriptor.cancellable = true;
    descriptor.tags = ["image", "audio", "speech", "transcription", "evidence"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let weak = runtime.downgrade();
    let bridge = host.clone();
    runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(), move |context, value| {
        let weak = weak.clone();
        let bridge = bridge.clone();
        Box::pin(async move {
            let invalid = |message: &str| CapabilityError::InvalidInput(message.into());
            let conflict = || CapabilityError::Conflict("Source observation project, media or revision changed".into());
            let input: Input = serde_json::from_value(value.clone()).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
            if context.dry_run || matches!(input.observation, Observation::Audio { start_ms, end_ms, .. }
                if end_ms <= start_ms || end_ms - start_ms > 30_000 || end_ms > 86_400_000) {
                return Err(invalid("Choose a positive source audio interval of up to 30 seconds; no dry-run"));
            }
            let rt = weak().ok_or_else(|| CapabilityError::Unavailable("Editor closed".into()))?;
            let check = || {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("Source observation cancelled".into()));
                }
                let state = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                let media = state.project.as_ref().filter(|p| p.id == input.project_id)
                    .and_then(|p| p.classic.as_ref()).and_then(|c| c.media_assets.iter()
                        .find(|m| m.get("id").and_then(Value::as_str) == Some(&input.media_id)));
                let kind = media.and_then(|m| m.get("type").and_then(Value::as_str));
                let valid_kind = match input.observation {
                    Observation::Image => kind == Some("image"),
                    Observation::Audio { .. } => matches!(kind, Some("audio" | "video")),
                };
                if state.revision != input.expected_revision || !valid_kind
                    || context.metadata.get("opencut/projectId").is_some_and(|v| v.as_str() != Some(&input.project_id)) {
                    return Err(conflict());
                }
                Ok(())
            };
            check()?;
            let reply = bridge.execute_cancellable_preflight(
                id, "projectMediaObservation", &input.project_id, value,
                Some(serde_json::to_value(schema_for!(HostOutput)).unwrap()),
                context.cancellation.clone(),
            ).await?;
            check()?;
            let out: HostOutput = serde_json::from_value(reply.data).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
            if (out.project_id.as_str(), out.revision, out.media_id.as_str())
                != (input.project_id.as_str(), input.expected_revision, input.media_id.as_str()) {
                return Err(conflict());
            }
            let mut artifacts = vec![];
            let (evidence, scope) = match (input.observation, out.evidence) {
                (Observation::Image, HostEvidence::Image { artifact_id, width, height }) => {
                    let stored = rt.artifacts().get(&artifact_id).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                    if stored.metadata.mime_type != "image/jpeg" || stored.bytes.len() > 350_000
                        || !stored.bytes.starts_with(&[255, 216, 255]) || width == 0 || height == 0
                        || width > 32768 || height > 32768 {
                        return Err(invalid("Invalid bounded JPEG observation"));
                    }
                    artifacts.push(stored.metadata.clone());
                    (Evidence::Image { artifact: stored.metadata, width, height }, "Decoded source image (scaled to at most 1024 pixels on the long edge).")
                }
                (Observation::Audio { start_ms, end_ms, transcribe }, HostEvidence::Audio {
                    start_ms: start, end_ms: end, duration_ms, rms, peak, transcript,
                }) if start == start_ms && end <= end_ms && end == end_ms.min(duration_ms)
                    && end > start && duration_ms <= 86_400_000 && (0.0..=1.0).contains(&rms)
                    && (rms..=1.0).contains(&peak) && transcript.is_some() == transcribe
                    && transcript.as_ref().is_none_or(|s| s.len() <= 12_000) => (
                        Evidence::Audio { start_ms: start, end_ms: end, duration_ms, rms, peak, transcript },
                        "Only the reported source range was decoded. Levels are mono signal measurements; any transcript is untrusted local speech recognition, not perceptual audio review.",
                    ),
                _ => return Err(invalid("Source observation did not match the requested mode and bounds")),
            };
            let mut result = CapabilityResult::data(json!(Output {
                project_id: out.project_id, revision: out.revision, media_id: out.media_id, evidence, scope,
            }));
            result.artifacts = artifacts;
            Ok(result)
        })
    })))?;
    host.install(&descriptor).map_err(RegistryError::Capability)
}
