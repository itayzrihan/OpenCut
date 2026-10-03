use super::*;
use crate::{
    HyperframesComposition, HyperframesInspection, HyperframesSource, inspect_hyperframes,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectInput {
    source: HyperframesSource,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportInput {
    project_id: String,
    expected_revision: u64,
    name: String,
    source: HyperframesSource,
    /// Omit to append at the end of the existing timeline.
    start_seconds: Option<f64>,
    /// Omit to create an overlay track in that same timeline.
    track_id: Option<String>,
    /// Runtime-measured duration when the root has no authored data-duration.
    resolved_duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportOutput {
    mutation: MutationOutput,
    asset_id: String,
    item_id: String,
    track_id: String,
    inspection: HyperframesInspection,
}

pub(super) fn register_hyperframes_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<InspectInput, HyperframesInspection, _, _>(
        registry,
        "hyperframes.project.inspect",
        "Inspect HyperFrames project",
        "Inspects supplied HyperFrames source without executing scripts or fetching files. Retains authored layers, nested hosts, resource references and unresolved runtime requirements.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "html", "composition", "layers", "import"],
        |context, input| async move {
            check_cancelled(&context)?;
            let inspection = inspect_hyperframes(&input.source).map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(inspection))
        },
    )?;
    register::<ImportInput, ImportOutput, _, _>(
        registry,
        "timeline.hyperframes.import",
        "Import HyperFrames into timeline",
        "Preserves a HyperFrames source package as a compound clip in the existing timeline. Appends by default or places at an explicit time on an existing visual track. Supports revision checks, undo, dry run and registry idempotency keys. Playback requires the HyperFrames renderer integration.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "hyperframes",
            "html",
            "composition",
            "compound",
            "import",
            "timeline",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                check_cancelled(&context)?;
                let inspection = inspect_hyperframes(&input.source).map_err(model_error)?;
                let duration = inspection.duration_seconds.or(input.resolved_duration_seconds)
                    .ok_or_else(|| CapabilityError::InvalidInput(
                        "HyperFrames duration is unresolved; supply a runtime-measured resolvedDurationSeconds".into()
                    ))?;
                let composition = HyperframesComposition {
                    source: Arc::new(input.source),
                    composition_id: inspection.composition_id.clone(),
                    width: inspection.width,
                    height: inspection.height,
                    fps: inspection.fps,
                    duration_seconds: duration,
                };
                composition.validate().map_err(model_error)?;
                let mut asset_id = String::new();
                let mut item_id = String::new();
                let mut track_id = String::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Import HyperFrames project",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        let start = input
                            .start_seconds
                            .unwrap_or_else(|| project.timeline.duration());
                        if let Some(id) = &input.track_id {
                            let track = project
                                .timeline
                                .tracks
                                .iter()
                                .find(|track| &track.id == id)
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "HyperFrames target track does not exist".into(),
                                    )
                                })?;
                            ensure_unlocked(track, None)?;
                            if !matches!(track.kind, TrackKind::Video | TrackKind::Overlay) {
                                return Err(CapabilityError::InvalidInput(
                                    "HyperFrames requires a video or overlay track".into(),
                                ));
                            }
                        }
                        asset_id = document.allocate_id("asset");
                        item_id = document.allocate_id("item");
                        track_id = input
                            .track_id
                            .clone()
                            .unwrap_or_else(|| document.allocate_id("track"));
                        let project = project_mut(document)?;
                        if input.track_id.is_none() {
                            project.timeline.tracks.push(new_track(
                                track_id.clone(),
                                "HyperFrames",
                                TrackKind::Overlay,
                            ));
                        }
                        project.assets.push(MediaAsset {
                            id: asset_id.clone(),
                            name: input.name.clone(),
                            source: format!("opencut://hyperframes/{}", inspection.fingerprint),
                            media_type: MediaType::Other,
                            duration_seconds: Some(duration),
                            width: Some(inspection.width),
                            height: Some(inspection.height),
                            frame_rate: Some(inspection.fps),
                            sample_rate: None,
                            channels: None,
                            has_video: true,
                            has_audio: true,
                            proxy_source: None,
                            offline: false,
                            unified_angles: None,
                            hyperframes: Some(composition),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        let track = project
                            .timeline
                            .tracks
                            .iter_mut()
                            .find(|track| track.id == track_id)
                            .unwrap();
                        track.items.push(TimelineItem {
                            id: item_id.clone(),
                            name: input.name,
                            kind: TimelineItemKind::Compound,
                            start_seconds: start,
                            duration_seconds: duration,
                            start: None,
                            duration: None,
                            source_in_seconds: 0.0,
                            source_out_seconds: Some(duration),
                            source_in: None,
                            source_out: None,
                            speed: 1.0,
                            enabled: true,
                            locked: false,
                            group_id: None,
                            linked_item_ids: Default::default(),
                            asset_id: Some(asset_id.clone()),
                            active_angle_asset_id: None,
                            fit_mode: None,
                            transform: Transform::default(),
                            opacity: 1.0,
                            blend_mode: BlendMode::default(),
                            audio: AudioProperties::default(),
                            text: None,
                            shape: None,
                            smart_layer: None,
                            masks: Vec::new(),
                            effects: Vec::new(),
                            keyframes: Vec::new(),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        check_cancelled(&context)?;
                        Ok(vec![asset_id.clone(), item_id.clone(), track_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(ImportOutput {
                    mutation,
                    asset_id,
                    item_id,
                    track_id,
                    inspection,
                })
                .summary("Imported HyperFrames source into the existing timeline")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn model_error(error: ModelError) -> CapabilityError {
    CapabilityError::InvalidInput(error.to_string())
}
fn check_cancelled(context: &InvocationContext) -> Result<(), CapabilityError> {
    if context.cancellation.is_cancelled() {
        Err(CapabilityError::Failed(
            "HyperFrames operation was cancelled".into(),
        ))
    } else {
        Ok(())
    }
}
