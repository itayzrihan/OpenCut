//! Shared source-clock and coverage policy for Classic virtual camera assets.
use super::*;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSource {
    pub id: String,
    pub duration: f64,
    /// Recording start on the shared audio clock. May be negative.
    #[serde(default)]
    pub start: f64,
    #[serde(default)]
    pub binding_revision: u64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct CameraClockOptions {
    pub sources: Vec<CameraSource>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraClock {
    pub reference_id: String,
    pub origin: f64,
    pub duration: f64,
}
#[export]
pub fn podcast_camera_clock(o: CameraClockOptions) -> Option<CameraClock> {
    if o.sources.is_empty()
        || o.sources.len() > 64
        || o.sources.iter().any(|s| {
            s.id.is_empty()
                || !s.duration.is_finite()
                || s.duration <= 0.0
                || s.duration > 86400.0
                || !s.start.is_finite()
                || s.start.abs() > 86400.0
        })
    {
        return None;
    }
    // Stable tie-break: retain selection order for equally long recordings.
    let mut longest = &o.sources[0];
    for source in &o.sources[1..] {
        if source.duration > longest.duration {
            longest = source;
        }
    }
    Some(CameraClock {
        reference_id: longest.id.clone(),
        origin: longest.start,
        duration: longest.duration,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraRangeOptions {
    pub source: CameraSource,
    pub trim_start: f64,
    pub duration: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraRange {
    pub available: bool,
    pub source_start: f64,
    pub source_end: f64,
}
#[export]
pub fn unified_camera_range(o: CameraRangeOptions) -> CameraRange {
    let start = o.trim_start - o.source.start;
    let end = start + o.duration;
    CameraRange {
        available: o.trim_start.is_finite()
            && o.duration.is_finite()
            && o.duration > 0.0
            && o.source.duration.is_finite()
            && o.source.start.is_finite()
            && start >= -1e-6
            && end <= o.source.duration + 1e-6,
        source_start: start.max(0.0),
        source_end: end,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastCameraWindow {
    pub channel_id: String,
    pub start: f64,
    pub end: f64,
}
/// Hard coverage boundaries override minimum shot, preroll and reaction rules.
/// A camera ending never produces a frozen tail or a cut to absent footage.
pub fn constrain_camera_cuts(
    cuts: Vec<PodcastMulticamCut>,
    windows: &[PodcastCameraWindow],
    duration: f64,
) -> Vec<PodcastMulticamCut> {
    if windows.is_empty() {
        return cuts;
    }
    if windows
        .iter()
        .any(|w| !w.start.is_finite() || !w.end.is_finite() || w.start < 0.0 || w.end <= w.start)
    {
        return vec![];
    }
    let mut boundaries = vec![0.0, duration];
    for c in &cuts {
        boundaries.extend([c.timestamp, c.timestamp + c.duration]);
    }
    for w in windows {
        boundaries.extend([w.start.clamp(0.0, duration), w.end.clamp(0.0, duration)]);
    }
    // JSON archives normalize -0, so never publish negative-zero boundaries.
    for boundary in &mut boundaries {
        if *boundary == 0.0 {
            *boundary = 0.0;
        }
    }
    boundaries.sort_by(f64::total_cmp);
    boundaries.dedup_by(|a, b| (*a - *b).abs() < 1e-8);
    let mut result: Vec<PodcastMulticamCut> = vec![];
    let mut cut_index = 0;
    for span in boundaries.windows(2) {
        let (start, end) = (span[0], span[1]);
        if end - start < 1e-8 {
            continue;
        }
        while cut_index + 1 < cuts.len()
            && cuts[cut_index].timestamp + cuts[cut_index].duration <= start + 1e-8
        {
            cut_index += 1;
        }
        let preferred = cuts
            .get(cut_index)
            .filter(|c| c.timestamp <= start + 1e-8 && c.timestamp + c.duration >= end - 1e-8);
        let available = |w: &&PodcastCameraWindow| w.start <= start + 1e-8 && w.end >= end - 1e-8;
        let selected = preferred
            .and_then(|c| {
                windows
                    .iter()
                    .filter(available)
                    .find(|w| w.channel_id == c.channel_id)
            })
            .or_else(|| {
                result.last().and_then(|c| {
                    windows
                        .iter()
                        .filter(available)
                        .find(|w| w.channel_id == c.channel_id)
                })
            })
            .or_else(|| {
                windows
                    .iter()
                    .filter(available)
                    .max_by(|a, b| (a.end - a.start).total_cmp(&(b.end - b.start)))
            });
        let Some(selected) = selected else {
            return vec![];
        };
        if let Some(last) = result.last_mut()
            && last.channel_id == selected.channel_id
        {
            last.duration = end - last.timestamp;
        } else {
            result.push(PodcastMulticamCut {
                timestamp: start,
                duration: end - start,
                channel_id: selected.channel_id.clone(),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn longest_clock_and_late_short_camera() {
        let long = CameraSource {
            id: "long".into(),
            duration: 3600.0,
            start: 20.0,
            binding_revision: 0,
        };
        let short = CameraSource {
            id: "short".into(),
            duration: 1800.0,
            start: 50.0,
            binding_revision: 0,
        };
        let clock = podcast_camera_clock(CameraClockOptions {
            sources: vec![short.clone(), long],
        })
        .unwrap();
        assert_eq!(clock.duration, 3600.0);
        assert_eq!(clock.origin, 20.0);
        let relative = CameraSource {
            start: 30.0,
            ..short
        };
        assert!(
            !unified_camera_range(CameraRangeOptions {
                source: relative.clone(),
                trim_start: 0.0,
                duration: 10.0
            })
            .available
        );
        assert!(
            unified_camera_range(CameraRangeOptions {
                source: relative.clone(),
                trim_start: 30.0,
                duration: 1800.0
            })
            .available
        );
        assert!(
            !unified_camera_range(CameraRangeOptions {
                source: relative,
                trim_start: 1829.0,
                duration: 2.0
            })
            .available
        );
        let result = constrain_camera_cuts(
            vec![PodcastMulticamCut {
                timestamp: 0.0,
                duration: 3600.0,
                channel_id: "short".into(),
            }],
            &[
                PodcastCameraWindow {
                    channel_id: "long".into(),
                    start: 0.0,
                    end: 3600.0,
                },
                PodcastCameraWindow {
                    channel_id: "short".into(),
                    start: 30.0,
                    end: 1830.0,
                },
            ],
            3600.0,
        );
        assert_eq!(
            result
                .iter()
                .map(|c| (c.channel_id.as_str(), c.timestamp, c.duration))
                .collect::<Vec<_>>(),
            vec![
                ("long", 0.0, 30.0),
                ("short", 30.0, 1800.0),
                ("long", 1830.0, 1770.0)
            ]
        );
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct CameraSourcesCurrentOptions {
    pub recorded: Vec<CameraSource>,
    pub current: Vec<CameraSource>,
}
#[export]
pub fn unified_camera_sources_current(o: CameraSourcesCurrentOptions) -> bool {
    !o.recorded.is_empty()
        && o.recorded.iter().all(|recorded| {
            o.current.iter().any(|current| {
                current.id == recorded.id
                    && current.binding_revision == recorded.binding_revision
                    && current.duration > 0.0
                    && (current.duration - recorded.duration).abs() < 1e-6
            })
        })
}
