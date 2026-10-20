//! One shared clock for every camera/microphone, independent of UI channel pairs.
//! Correlations are edges, not independent pairwise edits. Unmatched sources can
//! join through any already connected recording; disconnected sources fail closed.
use crate::{PodcastAlignmentOptions, estimate_podcast_alignment};
use bridge::export;
use serde::{Deserialize, Serialize};

pub const MAX_PODCAST_CHANNELS: usize = 32;
pub const MAX_PODCAST_SOURCES: usize = MAX_PODCAST_CHANNELS * 2;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastGroupAlignmentOptions {
    pub envelopes: Vec<Vec<f32>>,
    pub resolution_seconds: f64,
    pub max_lag_seconds: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastGroupAlignment {
    /// Recording start relative to the automatically selected reference.
    pub offsets: Vec<Option<f64>>,
    pub confidence: Vec<f64>,
    pub reference_index: usize,
    /// Edges of the shared-clock tree, used for bounded waveform verification.
    pub parents: Vec<Option<usize>>,
}
#[export]
pub fn align_podcast_sources(o: PodcastGroupAlignmentOptions) -> PodcastGroupAlignment {
    let n = o.envelopes.len();
    let mut result = PodcastGroupAlignment {
        offsets: vec![None; n.min(MAX_PODCAST_SOURCES)],
        confidence: vec![0.0; n.min(MAX_PODCAST_SOURCES)],
        reference_index: 0,
        parents: vec![None; n.min(MAX_PODCAST_SOURCES)],
    };
    if n == 0
        || n > MAX_PODCAST_SOURCES
        || o.envelopes.iter().map(Vec::len).sum::<usize>() > 32_000_000
        || !o.resolution_seconds.is_finite()
        || !(0.001..=1.0).contains(&o.resolution_seconds)
        || !o.max_lag_seconds.is_finite()
        || !(0.0..=3600.0).contains(&o.max_lag_seconds)
        || o.envelopes.iter().any(|e| {
            e.len() < 100 || e.len() > 3_600_000 || e.iter().any(|v| !v.is_finite() || *v < 0.0)
        })
    {
        return result;
    }
    // Prefer a long, non-silent recording, regardless of whether it is a camera
    // or an external mic. Gain does not affect this ranking.
    let usable: Vec<bool> = o
        .envelopes
        .iter()
        .map(|e| {
            let mean = e.iter().map(|v| *v as f64).sum::<f64>() / e.len() as f64;
            e.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / e.len() as f64 > 1e-18
        })
        .collect();
    let Some(reference) = (0..n)
        .filter(|i| usable[*i])
        .max_by_key(|i| o.envelopes[*i].len())
    else {
        return result;
    };
    result.reference_index = reference;
    result.offsets[reference] = Some(0.0);
    result.confidence[reference] = 1.0;
    // Maximum-confidence spanning tree over the recording graph. Do not commit
    // a weak microphone-to-microphone match before testing its camera bridge:
    // different speakers can create misleading low-correlation peaks.
    let mut newest = reference;
    let mut best: Vec<Option<(usize, f64, f64)>> = vec![None; n];
    loop {
        for target in 0..n {
            if result.offsets[target].is_some() || !usable[target] {
                continue;
            }
            let edge = estimate_podcast_alignment(PodcastAlignmentOptions {
                reference: o.envelopes[newest].clone(),
                target: o.envelopes[target].clone(),
                resolution_seconds: o.resolution_seconds,
                max_lag_seconds: o.max_lag_seconds,
            });
            if edge.confidence >= 0.15 && best[target].is_none_or(|(_, _, c)| edge.confidence > c) {
                best[target] = Some((newest, edge.offset_seconds, edge.confidence));
            }
        }
        let next = (0..n)
            .filter(|i| result.offsets[*i].is_none())
            .filter_map(|i| best[i].map(|edge| (i, edge)))
            .max_by(|a, b| a.1.2.total_cmp(&b.1.2));
        let Some((target, (source, lag, confidence))) = next else {
            break;
        };
        result.parents[target] = Some(source);
        result.offsets[target] = Some(result.offsets[source].unwrap() + lag);
        result.confidence[target] = confidence.min(result.confidence[source]);
        newest = target;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn noise(n: usize, seed: u64) -> Vec<f32> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x % 10000) as f32 / 10000.0
            })
            .collect()
    }
    #[test]
    fn jointly_aligns_twelve_sources_with_gain_and_both_offset_signs() {
        let audio = noise(9000, 7123);
        let starts: Vec<usize> = (0..12).map(|i| i * 137).collect();
        let result = align_podcast_sources(PodcastGroupAlignmentOptions {
            envelopes: starts
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    audio[*s..*s + 6000]
                        .iter()
                        .map(|v| v * (i + 1) as f32 / 10.0)
                        .collect()
                })
                .collect(),
            resolution_seconds: 0.01,
            max_lag_seconds: 30.0,
        });
        for (i, start) in starts.iter().enumerate() {
            let expected = (*start as f64 - starts[result.reference_index] as f64) * 0.01;
            assert!((result.offsets[i].unwrap() - expected).abs() < 0.011);
            assert!(result.confidence[i] > 0.99);
        }
    }
    #[test]
    fn uses_bridge_when_two_recordings_do_not_overlap() {
        let audio = noise(17000, 41253);
        let result = align_podcast_sources(PodcastGroupAlignmentOptions {
            envelopes: vec![
                audio[0..7000].to_vec(),
                audio[4000..11000].to_vec(),
                audio[9000..17000].to_vec(),
            ],
            resolution_seconds: 0.01,
            max_lag_seconds: 120.0,
        });
        assert!((result.offsets[0].unwrap() + 90.0).abs() < 0.011);
        assert!((result.offsets[1].unwrap() + 50.0).abs() < 0.011);
    }
    #[test]
    fn prefers_stronger_camera_bridge_over_misleading_microphone_match() {
        let a = noise(6000, 17321);
        let b = noise(6100, 32987);
        let camera: Vec<f32> = (0..6000).map(|i| 2.0 * a[i] + b[i]).collect();
        let reference: Vec<f32> = (0..6100)
            .map(|i| b[i] + 0.4 * a[i.saturating_sub(100).min(5999)])
            .collect();
        let result = align_podcast_sources(PodcastGroupAlignmentOptions {
            envelopes: vec![a, camera, reference],
            resolution_seconds: 0.01,
            max_lag_seconds: 3.0,
        });
        assert_eq!(result.reference_index, 2);
        assert!(result.offsets[0].unwrap().abs() < 0.011);
        assert!(result.offsets[1].unwrap().abs() < 0.011);
    }
    #[test]
    fn silent_or_unrelated_source_is_not_assigned_a_fake_offset() {
        let result = align_podcast_sources(PodcastGroupAlignmentOptions {
            envelopes: vec![noise(5000, 7123), vec![0.0; 5000], noise(5000, 92112)],
            resolution_seconds: 0.01,
            max_lag_seconds: 3.0,
        });
        assert_eq!(result.offsets.iter().filter(|x| x.is_some()).count(), 1);
        assert!(result.offsets[1].is_none());
    }
}
