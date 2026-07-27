use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundMode {
    #[default]
    Remove,
    Blur,
    Grayscale,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentationQuality {
    Fast,
    #[default]
    Balanced,
    Precise,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundRemovalSettings {
    pub enabled: bool,
    pub mode: BackgroundMode,
    pub quality: SegmentationQuality,
    pub mask_threshold: f32,
    pub edge_contrast: f32,
    pub edge_feather: f32,
    pub temporal_smoothing: f32,
    pub blur_strength: f32,
}

impl Default for BackgroundRemovalSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: BackgroundMode::Remove,
            quality: SegmentationQuality::Balanced,
            mask_threshold: 0.5,
            edge_contrast: 1.0,
            edge_feather: 0.5,
            temporal_smoothing: 0.24,
            blur_strength: 0.55,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBackgroundRemovalSettings {
    #[serde(flatten)]
    pub settings: BackgroundRemovalSettings,
    pub input_size: u32,
    pub preview_fps: u32,
    pub cache_entries: usize,
    pub blur_sigma: f32,
}

pub fn resolve_settings(
    mut settings: BackgroundRemovalSettings,
) -> ResolvedBackgroundRemovalSettings {
    settings.mask_threshold = settings.mask_threshold.clamp(0.05, 0.95);
    settings.edge_contrast = settings.edge_contrast.clamp(0.5, 2.5);
    settings.edge_feather = settings.edge_feather.clamp(0.0, 8.0);
    settings.temporal_smoothing = settings.temporal_smoothing.clamp(0.0, 0.85);
    settings.blur_strength = settings.blur_strength.clamp(0.0, 1.0);

    let (input_size, preview_fps, cache_entries) = match settings.quality {
        SegmentationQuality::Fast => (256, 15, 24),
        SegmentationQuality::Balanced => (384, 24, 48),
        SegmentationQuality::Precise => (512, 30, 72),
    };
    let blur_sigma = 2.0 + settings.blur_strength * 38.0;

    ResolvedBackgroundRemovalSettings {
        settings,
        input_size,
        preview_fps,
        cache_entries,
        blur_sigma,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Text,
    Audio,
    Graphic,
    Effect,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSpan {
    pub start_time: f64,
    pub duration: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub id: String,
    pub track_type: TrackKind,
    #[serde(default)]
    pub spans: Vec<TimeSpan>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePlacementInput {
    pub source_track_index: usize,
    pub source_start_time: f64,
    pub source_duration: f64,
    pub tracks: Vec<TrackSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DuplicatePlacement {
    ExistingTrack { track_id: String },
    NewTrack { insert_index: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlacementError {
    SourceTrackNotFound,
    InvalidSourceSpan,
}

pub fn plan_duplicate_placement(
    input: &DuplicatePlacementInput,
) -> Result<DuplicatePlacement, PlacementError> {
    if input.source_track_index >= input.tracks.len() {
        return Err(PlacementError::SourceTrackNotFound);
    }
    if !input.source_start_time.is_finite()
        || !input.source_duration.is_finite()
        || input.source_duration <= 0.0
    {
        return Err(PlacementError::InvalidSourceSpan);
    }

    if let Some(above_index) = input.source_track_index.checked_sub(1) {
        let above = &input.tracks[above_index];
        if above.track_type == TrackKind::Video
            && !track_overlaps(
                above,
                input.source_start_time,
                input.source_start_time + input.source_duration,
            )
        {
            return Ok(DuplicatePlacement::ExistingTrack {
                track_id: above.id.clone(),
            });
        }
    }

    // Display tracks are ordered from top to bottom. Inserting at the source
    // index creates a new video layer immediately above the source without
    // disturbing or overwriting the incompatible/occupied track above it.
    Ok(DuplicatePlacement::NewTrack {
        insert_index: input.source_track_index,
    })
}

fn track_overlaps(track: &TrackSummary, start_time: f64, end_time: f64) -> bool {
    track.spans.iter().any(|span| {
        let span_end = span.start_time + span.duration.max(0.0);
        start_time < span_end && end_time > span.start_time
    })
}

pub fn refine_alpha_mask(
    current: &[u8],
    previous: &[u8],
    mask_threshold: f32,
    edge_contrast: f32,
    temporal_smoothing: f32,
) -> Vec<u8> {
    let threshold = mask_threshold.clamp(0.05, 0.95);
    let contrast = edge_contrast.clamp(0.5, 2.5);
    let smoothing = temporal_smoothing.clamp(0.0, 0.85);
    let can_smooth = previous.len() == current.len() && !previous.is_empty();

    current
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let current_alpha = *value as f32 / 255.0;
            let stable_alpha = if can_smooth {
                let previous_alpha = previous[index] as f32 / 255.0;
                current_alpha * (1.0 - smoothing) + previous_alpha * smoothing
            } else {
                current_alpha
            };
            let contrasted = (stable_alpha - threshold) * contrast + 0.5;
            (contrasted.clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, track_type: TrackKind, spans: &[(f64, f64)]) -> TrackSummary {
        TrackSummary {
            id: id.to_string(),
            track_type,
            spans: spans
                .iter()
                .map(|(start_time, duration)| TimeSpan {
                    start_time: *start_time,
                    duration: *duration,
                })
                .collect(),
        }
    }

    #[test]
    fn uses_free_video_track_immediately_above_source() {
        let result = plan_duplicate_placement(&DuplicatePlacementInput {
            source_track_index: 1,
            source_start_time: 100.0,
            source_duration: 50.0,
            tracks: vec![
                track("above", TrackKind::Video, &[(0.0, 100.0)]),
                track("source", TrackKind::Video, &[(100.0, 50.0)]),
            ],
        });

        assert_eq!(
            result,
            Ok(DuplicatePlacement::ExistingTrack {
                track_id: "above".to_string()
            })
        );
    }

    #[test]
    fn creates_video_track_when_track_above_has_wrong_type() {
        let result = plan_duplicate_placement(&DuplicatePlacementInput {
            source_track_index: 1,
            source_start_time: 100.0,
            source_duration: 50.0,
            tracks: vec![
                track("text", TrackKind::Text, &[]),
                track("source", TrackKind::Video, &[(100.0, 50.0)]),
            ],
        });

        assert_eq!(result, Ok(DuplicatePlacement::NewTrack { insert_index: 1 }));
    }

    #[test]
    fn creates_video_track_when_video_track_above_is_occupied() {
        let result = plan_duplicate_placement(&DuplicatePlacementInput {
            source_track_index: 1,
            source_start_time: 100.0,
            source_duration: 50.0,
            tracks: vec![
                track("busy", TrackKind::Video, &[(125.0, 10.0)]),
                track("source", TrackKind::Video, &[(100.0, 50.0)]),
            ],
        });

        assert_eq!(result, Ok(DuplicatePlacement::NewTrack { insert_index: 1 }));
    }

    #[test]
    fn resolves_quality_profile_and_clamps_tuning() {
        let resolved = resolve_settings(BackgroundRemovalSettings {
            quality: SegmentationQuality::Precise,
            edge_contrast: 9.0,
            temporal_smoothing: -1.0,
            blur_strength: 2.0,
            ..BackgroundRemovalSettings::default()
        });

        assert_eq!(resolved.input_size, 512);
        assert_eq!(resolved.preview_fps, 30);
        assert_eq!(resolved.cache_entries, 72);
        assert_eq!(resolved.settings.edge_contrast, 2.5);
        assert_eq!(resolved.settings.temporal_smoothing, 0.0);
        assert_eq!(resolved.blur_sigma, 40.0);
    }

    #[test]
    fn refines_alpha_with_contrast_and_temporal_stability() {
        let refined = refine_alpha_mask(&[0, 128, 255], &[0, 64, 255], 0.5, 1.0, 0.5);
        assert_eq!(refined, vec![0, 96, 255]);
    }
}
