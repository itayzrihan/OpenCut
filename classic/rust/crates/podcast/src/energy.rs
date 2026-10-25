//! Shared speech activity and bleed suppression. Audio decoding stays in the host.
use super::*;
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzePodcastOptions {
    /// One aligned RMS envelope per microphone, sampled every 10ms.
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = 32)))]
    pub envelopes: Vec<Vec<f32>>,
    pub channel_ids: Vec<String>,
    pub duration: f64,
    pub settings: PodcastMulticamSettings,
    #[serde(default)]
    pub camera_windows: Vec<PodcastCameraWindow>,
    #[serde(default)]
    pub advanced: Option<AdvancedPodcastRouting>,
}
fn percentile(values: &[f32], p: f64) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(f32::total_cmp);
    v[((v.len() - 1) as f64 * p).round() as usize]
}
fn median(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(f32::total_cmp);
    let mid = v.len() / 2;
    if v.len() % 2 == 0 {
        (v[mid - 1] + v[mid]) / 2.0
    } else {
        v[mid]
    }
}
fn normalize(envelope: &[f32]) -> Vec<f32> {
    let floor = percentile(envelope, 0.2);
    let reference = percentile(envelope, 0.95);
    let threshold = floor + 0.18 * (reference - floor);
    if reference <= 1e-9 {
        return vec![0.0; envelope.len()];
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for i in 0..=envelope.len() {
        if i < envelope.len() && envelope[i] >= threshold {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            if let Some(previous) = spans.last_mut()
                && s - previous.1 <= 30
            {
                previous.1 = i;
            } else {
                spans.push((s, i));
            }
        }
    }
    let mut result = vec![0.0; envelope.len()];
    let mut values = Vec::new();
    for (s, e) in spans {
        if e - s >= 25 {
            result[s..e].copy_from_slice(&envelope[s..e]);
            values.extend_from_slice(&envelope[s..e]);
        }
    }
    let scale = median(&values);
    if scale > 1e-9 {
        for v in &mut result {
            *v /= scale;
        }
    }
    result
}
fn smooth(channels: &[Vec<f32>], width: usize) -> Vec<Vec<f32>> {
    channels
        .iter()
        .map(|x| {
            let mut prefix = vec![0.0f64; x.len() + 1];
            for (i, v) in x.iter().enumerate() {
                prefix[i + 1] = prefix[i] + *v as f64;
            }
            (0..x.len())
                .map(|i| {
                    let lo = i.saturating_sub(width / 2);
                    let hi = (i + width - width / 2).min(x.len());
                    ((prefix[hi] - prefix[lo]) / width as f64) as f32
                })
                .collect()
        })
        .collect()
}
#[export]
pub fn analyze_podcast_multicam(o: AnalyzePodcastOptions) -> Vec<PodcastMulticamCut> {
    let n = o.channel_ids.len();
    if n == 0
        || n > crate::MAX_PODCAST_CHANNELS
        || o.camera_windows.len() > n
        || o.camera_windows
            .iter()
            .any(|w| !o.channel_ids.contains(&w.channel_id))
        || o.camera_windows
            .iter()
            .map(|w| &w.channel_id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != o.camera_windows.len()
        || o.envelopes.len() != o.advanced.as_ref().map_or(n, |a| a.microphone_ids.len())
        || o.advanced
            .as_ref()
            .is_some_and(|a| !a.validate(&o.channel_ids))
        || !o.duration.is_finite()
        || !(0.0..=36000.0).contains(&o.duration)
    {
        return vec![];
    }
    let frames = (o.duration / RESOLUTION_SECONDS).ceil() as usize;
    if frames == 0
        || o.envelopes.iter().any(|e| {
            e.len() < frames || e.len() > 3_600_001 || e.iter().any(|v| !v.is_finite() || *v < 0.0)
        })
    {
        return vec![];
    }
    if let Some(mapping) = &o.advanced {
        let timeline = crate::advanced::advanced_camera_timeline(
            &o.envelopes,
            mapping,
            &o.channel_ids,
            frames,
        );
        let cuts = crate::route_podcast_multicam_grouped(
            RoutePodcastMulticamOptions {
                timeline,
                channel_ids: o.channel_ids,
                duration: o.duration,
                settings: o.settings,
            },
            &mapping.angle_groups,
        );
        return constrain_camera_cuts(cuts, &o.camera_windows, o.duration);
    }
    let mut channels: Vec<_> = o
        .envelopes
        .iter()
        .map(|e| normalize(&e[..frames]))
        .collect();
    if n >= 2 && o.settings.anti_bleed {
        let mut bleed = vec![vec![0.35; n]; n];
        for source in 0..n {
            bleed[source][source] = 0.0;
            let solo: Vec<_> = (0..frames)
                .filter(|&i| {
                    channels[source][i] > 0.1
                        && (0..n).all(|j| {
                            j == source
                                || channels[j][i] < channels[source][i] / 3.0
                                || channels[j][i] < 0.05
                        })
                })
                .collect();
            if solo.len() >= 200 {
                for target in 0..n {
                    if target != source {
                        let ratios: Vec<_> = solo
                            .iter()
                            .map(|&i| channels[target][i] / channels[source][i])
                            .collect();
                        bleed[source][target] = median(&ratios);
                    }
                }
            }
        }
        channels = (0..n)
            .map(|target| {
                (0..frames)
                    .map(|i| {
                        let leakage = (0..n)
                            .filter(|&j| j != target)
                            .map(|j| bleed[j][target] * channels[j][i])
                            .sum::<f32>();
                        (channels[target][i] - leakage).max(0.0)
                    })
                    .collect()
            })
            .collect();
        channels = smooth(&channels, 50);
        for x in &mut channels {
            let active: Vec<_> = x.iter().copied().filter(|v| *v > 0.0).collect();
            let floor = median(&active) * 0.15;
            for v in x {
                if *v < floor {
                    *v = 0.0;
                }
            }
        }
        channels = smooth(&channels, 30);
    } else if n >= 2 {
        channels = smooth(&channels, 30);
    }
    let timeline = (0..frames)
        .map(|i| channels.iter().map(|c| c[i]).collect())
        .collect();
    let cuts = route_podcast_multicam(RoutePodcastMulticamOptions {
        timeline,
        channel_ids: o.channel_ids,
        duration: o.duration,
        settings: o.settings,
    });
    constrain_camera_cuts(cuts, &o.camera_windows, o.duration)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_has_no_speech_and_gain_does_not_change_speaker() {
        assert!(normalize(&vec![0.0; 500]).iter().all(|x| *x == 0.0));
        let envelope: Vec<_> = (0..500)
            .map(|i| {
                if i > 100 && i < 400 {
                    0.05 + (i % 19) as f32 / 100.0
                } else {
                    0.0
                }
            })
            .collect();
        let scaled: Vec<_> = envelope.iter().map(|v| v * 0.25).collect();
        for (a, b) in normalize(&envelope).iter().zip(normalize(&scaled)) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
