//! Bridged Classic multicam: shared Rust routing, canonical scene creation and history.
use super::classic_scenes::{classic_target, timestamp};
use super::*;
use classic_podcast::{PodcastMulticamCut, PodcastMulticamSettings};
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Channel {
    id: String,
    name: String,
    video_id: String,
    audio_id: String,
    video_binding_revision: u64,
    audio_binding_revision: u64,
    video_offset: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    video_delay: f64,
    audio_offset: f64,
    audio_delay: f64,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvancedPlan {
    microphones: Vec<classic_podcast::PodcastMicrophone>,
    /// Stream start relative to sequence origin; negative means already recording.
    starts: BTreeMap<String, f64>,
    routing: classic_podcast::AdvancedPodcastRouting,
}
impl AdvancedPlan {
    fn validate(&self, channels: &[Channel]) -> Result<(), String> {
        if self.microphones.is_empty()
            || self.microphones.len() > 4
            || self.starts.len() > 4
            || self
                .microphones
                .iter()
                .map(|m| m.segments.len())
                .sum::<usize>()
                > 512
        {
            return Err("Choose up to four microphone streams and 512 segments".into());
        }
        let ids: Vec<_> = self.microphones.iter().map(|m| m.id.clone()).collect();
        if !self
            .routing
            .validate(&channels.iter().map(|c| c.id.clone()).collect::<Vec<_>>())
            || ids != self.routing.microphone_ids
            || self.starts.len() != ids.len()
            || ids.iter().any(|id| {
                !self
                    .starts
                    .get(id)
                    .is_some_and(|v| v.is_finite() && v.abs() <= 36000.0)
            })
        {
            return Err("Invalid Advanced Podcast microphone/camera routing".into());
        }
        if channels.iter().any(|c| {
            !self
                .routing
                .cameras
                .iter()
                .find(|camera| camera.channel_id == c.id)
                .is_some_and(|camera| {
                    self.microphones.iter().any(|m| {
                        camera.microphone_ids.contains(&m.id)
                            && m.segments
                                .first()
                                .is_some_and(|s| s.recording.media_id == c.audio_id)
                    })
                })
        }) {
            return Err(
                "A camera's representative audio must belong to an assigned microphone".into(),
            );
        }
        let detected = classic_podcast::group_podcast_recordings(
            classic_podcast::GroupPodcastRecordingsOptions {
                recordings: self
                    .microphones
                    .iter()
                    .flat_map(|m| m.segments.iter().map(|s| s.recording.clone()))
                    .collect(),
            },
        );
        if !detected.issues.is_empty() || detected.microphones != self.microphones {
            return Err(
                "Microphone provenance or segment continuity changed; regroup recordings".into(),
            );
        }
        Ok(())
    }
    fn validate_assets(
        &self,
        assets: &[serde_json::Map<String, Value>],
    ) -> Result<(), CapabilityError> {
        for m in &self.microphones {
            for segment in &m.segments {
                let r = &segment.recording;
                let a = assets
                    .iter()
                    .find(|a| {
                        a["id"] == r.media_id
                            && a["type"] == "audio"
                            && a.get("missing") != Some(&Value::Bool(true))
                    })
                    .ok_or_else(|| invalid("Advanced Podcast recording unavailable"))?;
                if a["name"].as_str() != Some(&r.name)
                    || a["duration"].as_f64() != Some(r.duration)
                    || a.get("bindingRevision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        != r.binding_revision
                {
                    return Err(CapabilityError::Conflict(
                        "Microphone file changed since analysis; regroup and resynchronize".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advanced: Option<AdvancedPlan>,
    settings: PodcastMulticamSettings,
    #[schemars(length(min = 1, max = 32))]
    channels: Vec<Channel>,
    duration: f64,
    #[schemars(length(min = 1, max = 100000))]
    cuts: Vec<PodcastMulticamCut>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    plan: Plan,
    #[serde(default)]
    finish_podcast: bool,
    /// Explicit caller choice; automatic runs must never silently discard imported microphones.
    #[serde(default)]
    allow_camera_audio: bool,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn is_zero(v: &f64) -> bool {
    *v == 0.0
}
fn nonnegative(v: f64) -> bool {
    v.is_finite() && (0.0..=86400.0).contains(&v)
}
impl Plan {
    fn validate(&self) -> Result<(), String> {
        if self.channels.is_empty()
            || self.channels.len() > classic_podcast::MAX_PODCAST_CHANNELS
            || self.cuts.is_empty()
            || self.cuts.len() > 100000
            || !nonnegative(self.duration)
            || self.duration <= 0.0
            || classic_podcast::normalize_podcast_multicam_settings(self.settings.clone())
                != self.settings
        {
            return Err("Invalid multicam settings, duration or channel count".into());
        }
        let mut ids = HashSet::new();
        let mut videos = HashSet::new();
        let mut audio = HashSet::new();
        for c in &self.channels {
            if c.id.trim().is_empty()
                || c.name.trim().is_empty()
                || !ids.insert(&c.id)
                || !videos.insert(&c.video_id)
                || (self.advanced.is_none() && !audio.insert(&c.audio_id))
                || !nonnegative(c.video_delay)
                || c.video_delay >= self.duration
                || (c.video_offset > 0.0 && c.video_delay > 0.0)
                || !nonnegative(c.video_offset)
                || !nonnegative(c.audio_offset)
                || !nonnegative(c.audio_delay)
                || (c.audio_offset > 0.0 && c.audio_delay > 0.0)
            {
                return Err("Invalid or duplicate multicam channel/alignment".into());
            }
        }
        if let Some(a) = &self.advanced {
            a.validate(&self.channels)?;
        }
        let mut end = 0.0;
        for cut in &self.cuts {
            if !ids.contains(&cut.channel_id)
                || !nonnegative(cut.timestamp)
                || !nonnegative(cut.duration)
                || cut.duration <= 0.0
                || (cut.timestamp - end).abs() > 1e-6
            {
                return Err(
                    "Multicam cuts must cover the sequence continuously with known cameras".into(),
                );
            }
            end = cut.timestamp + cut.duration;
        }
        if (end - self.duration).abs() > 1e-6 {
            return Err("Multicam cuts do not cover the duration".into());
        }
        Ok(())
    }
}
pub(crate) fn validate_scene(scene: &Value, asset_ids: &HashSet<&str>) -> Result<(), String> {
    if let Some(value) = scene.get("multicam") {
        let plan: Plan = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        plan.validate()?;
        if let Some(a) = &plan.advanced {
            for m in &a.microphones {
                for s in &m.segments {
                    if !asset_ids.contains(s.recording.media_id.as_str()) {
                        return Err("Unbound Advanced Podcast segment".into());
                    }
                }
            }
        }
        for c in &plan.channels {
            if !asset_ids.contains(c.video_id.as_str()) || !asset_ids.contains(c.audio_id.as_str())
            {
                return Err("Unbound multicam media".into());
            }
        }
    }
    Ok(())
}
// Quantize each shared boundary once; audio offsets retain subframe precision.
fn snap_plan(mut plan: Plan, fps: f64) -> Result<Plan, CapabilityError> {
    if !fps.is_finite() || !(1.0..=240.0).contains(&fps) {
        return Err(invalid("Invalid project frame rate"));
    }
    let end_frame = (plan.duration * fps + 1e-7).floor() as u64;
    if end_frame == 0 {
        return Err(invalid("Multicam sequence is shorter than one frame"));
    }
    let mut cuts: Vec<PodcastMulticamCut> = Vec::new();
    let mut start_frame = 0;
    for cut in &plan.cuts {
        let end = ((cut.timestamp + cut.duration) * fps + 1e-7)
            .round()
            .min(end_frame as f64) as u64;
        if end <= start_frame {
            continue;
        }
        let timestamp = start_frame as f64 / fps;
        let stop = end as f64 / fps;
        if let Some(previous) = cuts.last_mut()
            && previous.channel_id == cut.channel_id
        {
            previous.duration = stop - previous.timestamp;
        } else {
            cuts.push(PodcastMulticamCut {
                timestamp,
                duration: stop - timestamp,
                channel_id: cut.channel_id.clone(),
            });
        }
        start_frame = end;
    }
    plan.duration = end_frame as f64 / fps;
    plan.cuts = cuts;
    plan.validate().map_err(|e| invalid(&e))?;
    Ok(plan)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalyzeInput {
    project_id: String,
    expected_revision: u64,
    options: classic_podcast::AnalyzePodcastOptions,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AnalyzeOutput {
    revision: u64,
    cuts: Vec<PodcastMulticamCut>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignInput {
    project_id: String,
    expected_revision: u64,
    options: classic_podcast::PodcastGroupAlignmentOptions,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrecisionPlanInput {
    project_id: String,
    expected_revision: u64,
    options: classic_podcast::PodcastPrecisionPlanOptions,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrecisionEstimateInput {
    project_id: String,
    expected_revision: u64,
    options: classic_podcast::PodcastPrecisionOptions,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrecisionResolveInput {
    project_id: String,
    expected_revision: u64,
    options: classic_podcast::PodcastPrecisionResolveOptions,
}

#[derive(Serialize, JsonSchema)]
struct PrecisionPlanOutput {
    windows: Vec<classic_podcast::PodcastPrecisionWindow>,
}
pub(super) fn register_multicam(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::classic_advanced_podcast::register_groups(registry, state.clone())?;
    super::classic_multicam_sources::register_sources(registry, state.clone())?;
    let alignment_state = state.clone();
    register::<AlignInput, classic_podcast::PodcastGroupAlignment, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.align",
        "Synchronize all multicam sources",
        "Shared Rust group alignment of up to 64 camera/microphone RMS envelopes on one clock, with automatic reference and overlap bridges. Null offsets explicitly identify unconnected sources. No media IO or document changes. Bounded input, optimistic revision; cancellation checked before and after. Browser uses the same kernel in a cancellable Worker. Commit via timeline.classic.multicam.create.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "sync", "audio"],
        move |context, input| {
            let state = alignment_state.clone();
            async move {
                {
                    let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                    if store.document.revision != input.expected_revision
                        || store
                            .document
                            .project
                            .as_ref()
                            .is_none_or(|p| p.id != input.project_id || p.classic.is_none())
                    {
                        return Err(CapabilityError::Conflict(
                            "Multicam synchronization target or revision changed".into(),
                        ));
                    }
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let result = classic_podcast::align_podcast_sources(input.options);
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                Ok(OperationSuccess::new(result))
            }
        },
    )?;
    let alignment_state = state.clone();
    register::<PrecisionPlanInput, PrecisionPlanOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.precision.plan",
        "Plan bounded waveform sync verification",
        "Shared Rust waveform precision kernel. Plans bounded windows, estimates signed PCM lag or resolves consistent multi-window evidence on the shared clock. Unverified and drifting sources are explicit. No media IO or state changes. Optimistic revision and cancellation checks. Browser invokes the same kernel in cancellable workers; commit via timeline.classic.multicam.create.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "sync", "audio"],
        move |context, input| {
            let state = alignment_state.clone();
            async move {
                {
                    let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                    if store.document.revision != input.expected_revision
                        || store
                            .document
                            .project
                            .as_ref()
                            .is_none_or(|p| p.id != input.project_id || p.classic.is_none())
                    {
                        return Err(CapabilityError::Conflict(
                            "Multicam synchronization target or revision changed".into(),
                        ));
                    }
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let result = PrecisionPlanOutput {
                    windows: classic_podcast::plan_podcast_precision(input.options),
                };
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                Ok(OperationSuccess::new(result))
            }
        },
    )?;
    let alignment_state = state.clone();
    register::<PrecisionEstimateInput, classic_podcast::PodcastPrecisionEstimate, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.precision.estimate",
        "Measure signed waveform sync lag",
        "Shared Rust waveform precision kernel. Plans bounded windows, estimates signed PCM lag or resolves consistent multi-window evidence on the shared clock. Unverified and drifting sources are explicit. No media IO or state changes. Optimistic revision and cancellation checks. Browser invokes the same kernel in cancellable workers; commit via timeline.classic.multicam.create.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "sync", "audio"],
        move |context, input| {
            let state = alignment_state.clone();
            async move {
                {
                    let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                    if store.document.revision != input.expected_revision
                        || store
                            .document
                            .project
                            .as_ref()
                            .is_none_or(|p| p.id != input.project_id || p.classic.is_none())
                    {
                        return Err(CapabilityError::Conflict(
                            "Multicam synchronization target or revision changed".into(),
                        ));
                    }
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let result = classic_podcast::estimate_podcast_precision(input.options);
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                Ok(OperationSuccess::new(result))
            }
        },
    )?;
    let alignment_state = state.clone();
    register::<PrecisionResolveInput, classic_podcast::PodcastPrecisionResult, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.precision.resolve",
        "Resolve verified shared-clock waveform offsets",
        "Shared Rust waveform precision kernel. Plans bounded windows, estimates signed PCM lag or resolves consistent multi-window evidence on the shared clock. Unverified and drifting sources are explicit. No media IO or state changes. Optimistic revision and cancellation checks. Browser invokes the same kernel in cancellable workers; commit via timeline.classic.multicam.create.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "sync", "audio"],
        move |context, input| {
            let state = alignment_state.clone();
            async move {
                {
                    let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                    if store.document.revision != input.expected_revision
                        || store
                            .document
                            .project
                            .as_ref()
                            .is_none_or(|p| p.id != input.project_id || p.classic.is_none())
                    {
                        return Err(CapabilityError::Conflict(
                            "Multicam synchronization target or revision changed".into(),
                        ));
                    }
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let result = classic_podcast::resolve_podcast_precision(input.options);
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                Ok(OperationSuccess::new(result))
            }
        },
    )?;
    let analysis_state = state.clone();
    register::<AnalyzeInput, AnalyzeOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.analyze",
        "Analyze microphone activity for multicam",
        "Pure shared Rust analysis of aligned 10ms RMS microphone envelopes. No files, network or state changes. Returns a camera cut plan using speech gating, gain normalization, bleed suppression, confirmation, minimum shot and maximum shot/reaction rules. Explicit project and revision. Maximum 32 channels and ten hours, cancellation checked before and after analysis. UI uses the same Rust kernel via WASM. Commit through timeline.classic.multicam.create.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "podcast", "audio", "analysis"],
        move |context, input| {
            let state = analysis_state.clone();
            async move {
                let revision = {
                    let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
                    if store.document.revision != input.expected_revision
                        || store
                            .document
                            .project
                            .as_ref()
                            .is_none_or(|p| p.id != input.project_id || p.classic.is_none())
                    {
                        return Err(CapabilityError::Conflict(
                            "Multicam analysis target or revision changed".into(),
                        ));
                    }
                    store.document.revision
                };
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let cuts = classic_podcast::analyze_podcast_multicam(input.options);
                if cuts.is_empty() {
                    return Err(invalid(
                        "Invalid or incomplete multicam microphone envelopes",
                    ));
                }
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                Ok(OperationSuccess::new(AnalyzeOutput { revision, cuts }))
            }
        },
    )?;
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.create",
        "Create a synchronized multicam sequence",
        "Atomically create an editable Classic multicam scene from an audio-derived plan. Channel offsets/delays and cuts are seconds. Requires bound video/audio assets and continuous camera coverage; when external audio exists, camera audio requires explicit allowCameraAudio=true; source bounds validated. Camera microphones are muted by default, external microphones remain continuous, each camera remains on one continuous cut track with inactive clips disabled (enabled=false). Stores settings/alignment/cuts at scene.multicam. Optional finishPodcast=true applies the canonical full podcast finishing preset (+15 dB volume, -1 dB gain, limiter -1 dB, noise reduction 100%, Sharpen 15%) in the same undoable creation. Analysis uses the shared Classic Rust podcast router; this commit performs no file or network IO. Explicit project and revision, dry run, cancellation, idempotency, undo/redo and atomic transactions. Bridged Classic capability.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "multicam", "podcast", "sync", "camera"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Create multicam sequence",
                    Some(input.expected_revision),
                    |document| {
                        input.plan.validate().map_err(|e| invalid(&e))?;
                        let classic = classic_target(document, &input.project_id)?;
                        let assets = classic.media_assets.clone();
                        if let Some(a) = &input.plan.advanced {
                            a.validate_assets(&assets)?;
                        }
                        if !input.allow_camera_audio
                            && assets.iter().any(|a| a["type"] == "audio")
                            && input.plan.channels.iter().any(|c| {
                                assets
                                    .iter()
                                    .any(|a| a["id"] == c.audio_id && a["type"] == "video")
                            })
                        {
                            return Err(invalid(
                                "External microphone recordings are available. Select them, or explicitly confirm camera audio with allowCameraAudio=true.",
                            ));
                        }
                        let rate = &classic.document["settings"]["fps"];
                        let fps = rate["numerator"].as_f64().unwrap_or(0.0)
                            / rate["denominator"].as_f64().unwrap_or(1.0);
                        let mut snapped = snap_plan(input.plan.clone(), fps)?;
                        let mut windows = Vec::new();
                        for c in &input.plan.channels {
                            let duration = assets
                                .iter()
                                .find(|a| a["id"] == c.video_id)
                                .and_then(|a| a.get("duration"))
                                .and_then(Value::as_f64)
                                .ok_or_else(|| invalid("Camera duration missing"))?;
                            let end = c.video_delay + duration - c.video_offset;
                            for cut in input.plan.cuts.iter().filter(|cut| cut.channel_id == c.id) {
                                if cut.timestamp + 1e-6 < c.video_delay
                                    || cut.timestamp + cut.duration > end + 1e-6
                                {
                                    return Err(invalid(
                                        "Multicam cut is outside the camera recording",
                                    ));
                                }
                            }
                            let start = (c.video_delay * fps - 1e-7).ceil() / fps;
                            let end = (end.min(snapped.duration) * fps + 1e-7).floor() / fps;
                            if end > start {
                                windows.push(classic_podcast::PodcastCameraWindow {
                                    channel_id: c.id.clone(),
                                    start,
                                    end,
                                });
                            }
                        }
                        snapped.cuts = classic_podcast::constrain_camera_cuts(
                            snapped.cuts,
                            &windows,
                            snapped.duration,
                        );
                        snapped.validate().map_err(|s| invalid(&s))?;
                        let mut occupied = HashSet::new();
                        collect_ids(&serde_json::to_value(&*document).unwrap(), &mut occupied);
                        let mut fresh = |prefix| {
                            super::classic_duplicate::fresh(document, &mut occupied, prefix)
                        };
                        let scene_id = fresh("multicam-scene");
                        let main_id = fresh("multicam-track");
                        let mut overlay = Vec::new();
                        let mut audio = Vec::new();
                        let plan = &snapped;
                        let ticks = |v: f64| (v * 120000.0).round() as i64;
                        let find = |id: &str, video: bool| -> Result<Value, CapabilityError> {
                            let asset = assets
                                .iter()
                                .find(|a| a["id"] == id)
                                .ok_or_else(|| invalid("Multicam media is not registered"))?;
                            if (video && asset["type"] != "video")
                                || (!video && asset["type"] != "video" && asset["type"] != "audio")
                            {
                                return Err(invalid(
                                    "Multicam source has an incompatible media type",
                                ));
                            }
                            if !asset["duration"]
                                .as_f64()
                                .is_some_and(|d| d.is_finite() && d > 0.0)
                            {
                                return Err(invalid("Multicam source duration is missing"));
                            }
                            Ok(Value::Object(asset.clone()))
                        };
                        for (index, c) in plan.channels.iter().enumerate() {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "operation was cancelled".into(),
                                ));
                            }
                            let video = find(&c.video_id, true)?;
                            let mic = find(&c.audio_id, false)?;
                            if video["bindingRevision"].as_u64().unwrap_or(0)
                                != c.video_binding_revision
                                || mic["bindingRevision"].as_u64().unwrap_or(0)
                                    != c.audio_binding_revision
                            {
                                return Err(CapabilityError::Conflict("Multicam media changed since analysis; run synchronization again".into()));
                            }
                            let vd = video["duration"].as_f64().unwrap();
                            let ad = mic["duration"].as_f64().unwrap();
                            if c.video_offset >= vd {
                                return Err(invalid("Multicam alignment exceeds source media"));
                            }
                            if let Some(u) =
                                super::classic_unified::metadata(video.as_object().unwrap())
                                    .map_err(|s| invalid(&s))?
                            {
                                if !super::classic_unified::sync_current(&u, &assets) {
                                    return Err(invalid(
                                        "Unified Angles needs current audio synchronization",
                                    ));
                                }
                            }
                            let coverage_start = (c.video_delay * fps - 1e-7).ceil() / fps;
                            let coverage_end =
                                ((c.video_delay + vd - c.video_offset).min(plan.duration) * fps
                                    + 1e-7)
                                    .floor()
                                    / fps;
                            let mut routed = Vec::new();
                            let mut camera_cuts = Vec::new();
                            for cut in &plan.cuts {
                                let mut points = vec![cut.timestamp, cut.timestamp + cut.duration];
                                if let Some(u) =
                                    super::classic_unified::metadata(video.as_object().unwrap())
                                        .map_err(|s| invalid(&s))?
                                    && let Some(sync) = u.sync
                                {
                                    for source in sync.sources {
                                        for point in [
                                            ((source.start + c.video_delay - c.video_offset) * fps
                                                - 1e-7)
                                                .ceil()
                                                / fps,
                                            ((source.start + source.duration + c.video_delay
                                                - c.video_offset)
                                                * fps
                                                + 1e-7)
                                                .floor()
                                                / fps,
                                        ] {
                                            if point > cut.timestamp + 1e-6
                                                && point < cut.timestamp + cut.duration - 1e-6
                                            {
                                                points.push(point);
                                            }
                                        }
                                    }
                                }
                                points.sort_by(f64::total_cmp);
                                points.dedup();
                                for pair in points.windows(2) {
                                    camera_cuts.push(PodcastMulticamCut {
                                        timestamp: pair[0],
                                        duration: pair[1] - pair[0],
                                        channel_id: cut.channel_id.clone(),
                                    });
                                }
                            }
                            for cut in &camera_cuts {
                                if context.cancellation.is_cancelled() {
                                    return Err(CapabilityError::Failed(
                                        "operation was cancelled".into(),
                                    ));
                                }
                                let active = cut.channel_id == c.id;
                                let start = cut.timestamp.max(coverage_start);
                                let end = (cut.timestamp + cut.duration).min(coverage_end);
                                if active
                                    && (start > cut.timestamp + 1e-6
                                        || end < cut.timestamp + cut.duration - 1e-6)
                                {
                                    return Err(invalid(
                                        "Multicam cut selects a camera outside its synchronized coverage",
                                    ));
                                }
                                if end <= start {
                                    continue;
                                }
                                let source_start = c.video_offset + start - c.video_delay;
                                let e = json!({"id":fresh("multicam-clip"),"type":"video","mediaId":c.video_id,"name":video["name"],
                            "startTime":ticks(start),"duration":ticks(end)-ticks(start),
                            "trimStart":ticks(source_start),"trimEnd":ticks((vd-source_start-(end-start)).max(0.0)),
                            "sourceDuration":ticks(vd),"isSourceAudioEnabled":plan.settings.keep_camera_mics,"enabled":active,
                            "params":{"transform.scaleX":1,"transform.scaleY":1,"opacity":1,"volume":1}});
                                routed.push(e);
                            }
                            overlay.push(json!({"id":fresh("multicam-track"),"type":"video","name":format!("Routed {} - {}",index+1,c.name),"hidden":false,"muted":!plan.settings.keep_camera_mics,"elements":routed}));
                            if plan.advanced.is_some() {
                                continue;
                            }
                            let duration = (plan.duration - c.audio_delay).min(ad - c.audio_offset);
                            if duration <= 0.0 {
                                continue;
                            }
                            audio.push(json!({"id":fresh("multicam-track"),"type":"audio","name":format!("Podcast audio {} - {}",index+1,c.name),"muted":false,"elements":[{
                        "id":fresh("multicam-audio"),"type":"audio","sourceType":"upload","mediaId":c.audio_id,"name":mic["name"],
                        "startTime":ticks(c.audio_delay),"duration":ticks(c.audio_delay+duration)-ticks(c.audio_delay),"trimStart":ticks(c.audio_offset),"trimEnd":ticks((ad-c.audio_offset-duration).max(0.0)),"sourceDuration":ticks(ad),"params":{"volume":1}}]}));
                        }
                        if let Some(advanced) = &plan.advanced {
                            for m in &advanced.microphones {
                                let mut elements = Vec::new();
                                for segment in &m.segments {
                                    let position = advanced.starts[&m.id] + segment.start;
                                    let start = position.max(0.0);
                                    let end =
                                        (position + segment.recording.duration).min(plan.duration);
                                    if end <= start {
                                        continue;
                                    }
                                    let trim = (start - position).max(0.0);
                                    elements.push(json!({"id":fresh("multicam-audio"),"type":"audio","sourceType":"upload",
                                        "mediaId":segment.recording.media_id,"name":segment.recording.name,
                                        "startTime":ticks(start),"duration":ticks(end)-ticks(start),"trimStart":ticks(trim),
                                        "trimEnd":ticks((segment.recording.duration-trim-(end-start)).max(0.0)),
                                        "sourceDuration":ticks(segment.recording.duration),"params":{"volume":1},
                                        "podcastMicrophoneId":m.id,"podcastRecorderToken":m.recorder_token,"podcastSequence":segment.sequence}));
                                }
                                if elements.is_empty() {
                                    return Err(invalid(
                                        "A microphone has no audio on the camera timeline",
                                    ));
                                }
                                audio.push(json!({"id":fresh("multicam-track"),"type":"audio","name":m.name,"muted":false,"elements":elements}));
                            }
                        }
                        let order: Vec<Value> = overlay
                            .iter()
                            .map(|t| t["id"].clone())
                            .chain(std::iter::once(json!(main_id)))
                            .chain(audio.iter().map(|t| t["id"].clone()))
                            .collect();
                        let now = timestamp()?;
                        let mut scene = json!({"id":scene_id,"name":plan.settings.sequence_name,"isMain":false,"createdAt":now,"updatedAt":now,"bookmarks":[],"multicam":plan,
                    "tracks":{"overlay":overlay,"audio":audio,"order":order,"main":{"id":main_id,"name":"Main Track","type":"video","hidden":false,"muted":false,"elements":[]}}});

                        if input.finish_podcast {
                            let mic_ids = audio
                                .iter()
                                .map(|t| t["id"].as_str().unwrap().to_owned())
                                .collect::<Vec<_>>();
                            let camera_ids = overlay
                                .iter()
                                .map(|t| t["id"].as_str().unwrap().to_owned())
                                .collect::<Vec<_>>();
                            super::classic_podcast_finish::finish(
                                &mut scene,
                                &mic_ids,
                                &camera_ids,
                                fresh("podcast-sharpen"),
                                fresh("podcast-effects"),
                            )?;
                        }
                        let classic = classic_target(document, &input.project_id)?;
                        classic.document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .push(scene);
                        classic.document["currentSceneId"] = json!(scene_id);
                        classic.document["metadata"]["updatedAt"] = json!(now);
                        Ok(vec![input.project_id.clone(), scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Created synchronized multicam sequence")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
