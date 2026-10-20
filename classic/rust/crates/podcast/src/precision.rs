//! Bounded, signed-waveform verification after shared-clock envelope alignment.
//! No media IO. The host decodes only these short windows in cancellable workers.
use crate::PodcastGroupAlignment;
use bridge::export;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionPlanOptions {
    pub alignment: PodcastGroupAlignment,
    pub durations: Vec<f64>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionWindow {
    pub reference_index: usize,
    pub target_index: usize,
    pub reference_start: f64,
    pub target_start: f64,
    pub duration_seconds: f64,
}
fn valid_group(g: &PodcastGroupAlignment) -> bool {
    let n = g.offsets.len();
    n > 0
        && n <= 64
        && g.parents.len() == n
        && g.confidence.len() == n
        && g.reference_index < n
        && g.parents[g.reference_index].is_none()
        && g.offsets.iter().all(|v| v.is_some_and(|v| v.is_finite()))
        && g.parents
            .iter()
            .enumerate()
            .all(|(i, p)| p.is_none_or(|p| p < n && p != i))
}
#[export]
pub fn plan_podcast_precision(o: PodcastPrecisionPlanOptions) -> Vec<PodcastPrecisionWindow> {
    let g = o.alignment;
    if !valid_group(&g)
        || o.durations.len() != g.offsets.len()
        || o.durations
            .iter()
            .any(|d| !d.is_finite() || *d <= 0.0 || *d > 36000.0)
    {
        return vec![];
    }
    let mut windows = vec![];
    for (target, parent) in g.parents.iter().enumerate() {
        let Some(reference) = *parent else { continue };
        let a = g.offsets[reference].unwrap();
        let b = g.offsets[target].unwrap();
        let start = a.max(b) + 0.6;
        let end = (a + o.durations[reference]).min(b + o.durations[target]) - 0.6;
        if end - start < 30.0 {
            continue;
        }
        // Separated evidence catches mismatches and clock drift; never decode a
        // multi-hour recording into PCM just to refine a millisecond offset.
        for fraction in [0.1, 0.3, 0.5, 0.7, 0.9] {
            let time = start + (end - start - 8.0) * fraction;
            windows.push(PodcastPrecisionWindow {
                reference_index: reference,
                target_index: target,
                reference_start: time - a,
                target_start: time - b,
                duration_seconds: 8.0,
            });
        }
    }
    windows
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionOptions {
    pub reference: Vec<f32>,
    pub target: Vec<f32>,
    pub sample_rate: u32,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionEstimate {
    pub offset_seconds: f64,
    pub confidence: f64,
}
#[export]
pub fn estimate_podcast_precision(o: PodcastPrecisionOptions) -> PodcastPrecisionEstimate {
    let none = || PodcastPrecisionEstimate {
        offset_seconds: 0.0,
        confidence: 0.0,
    };
    let rate = o.sample_rate as usize;
    if !(8000..=48000).contains(&rate)
        || o.reference.len() != o.target.len()
        || o.reference.len() < rate * 2
        || o.reference.len() > rate * 12
        || o.reference.iter().chain(&o.target).any(|x| !x.is_finite())
    {
        return none();
    }
    // Remove DC/low-frequency rumble without discarding waveform phase. Abs NCC
    // supports polarity-inverted microphone wiring; gain does not affect timing.
    let filter = |x: Vec<f32>| -> Vec<f32> {
        let mut prev = 0.0;
        x.into_iter()
            .map(|v| {
                let y = v - 0.97 * prev;
                prev = v;
                y
            })
            .collect()
    };
    let a = filter(o.reference);
    let b = filter(o.target);
    let len = a.len();
    let n = (len * 2 - 1).next_power_of_two();
    let mut x = vec![Complex::new(0.0f32, 0.0); n];
    let mut y = x.clone();
    for (d, v) in x.iter_mut().zip(&a) {
        d.re = *v;
    }
    for (d, v) in y.iter_mut().zip(&b) {
        d.re = *v;
    }
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut x);
    fft.process(&mut y);
    for (x, y) in x.iter_mut().zip(y) {
        *x *= y.conj();
    }
    planner.plan_fft_inverse(n).process(&mut x);
    let power = |a: &[f32]| {
        let mut p = vec![0.0f64; a.len() + 1];
        for (i, v) in a.iter().enumerate() {
            p[i + 1] = p[i] + (*v as f64).powi(2);
        }
        p
    };
    let ap = power(&a);
    let bp = power(&b);
    let limit = (rate / 2) as isize;
    let score = |lag: isize| {
        let start = lag.max(0) as usize;
        let end = (len as isize + lag).min(len as isize) as usize;
        let bs = (start as isize - lag) as usize;
        let be = (end as isize - lag) as usize;
        let denom = ((ap[end] - ap[start]) * (bp[be] - bp[bs])).sqrt();
        let idx = if lag < 0 {
            (n as isize + lag) as usize
        } else {
            lag as usize
        };
        if denom < 1e-12 {
            0.0
        } else {
            (x[idx].re as f64 / n as f64 / denom).abs().min(1.0)
        }
    };
    let (lag, best) = (-limit..=limit)
        .map(|l| (l, score(l)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap();
    let alternate = (-limit..=limit)
        .filter(|l| (l - lag).abs() > (rate / 100) as isize)
        .map(score)
        .fold(0.0, f64::max);
    // Boundary peaks and repeated tones do not justify a precise correction.
    if lag.abs() == limit || best < 0.12 || best < alternate * 1.15 {
        return none();
    }
    PodcastPrecisionEstimate {
        offset_seconds: lag as f64 / rate as f64,
        confidence: best,
    }
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionResolveOptions {
    pub alignment: PodcastGroupAlignment,
    pub windows: Vec<PodcastPrecisionWindow>,
    pub estimates: Vec<PodcastPrecisionEstimate>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPrecisionResult {
    pub offsets: Vec<Option<f64>>,
    pub unverified: Vec<usize>,
    pub drifting: Vec<usize>,
}
#[export]
pub fn resolve_podcast_precision(o: PodcastPrecisionResolveOptions) -> PodcastPrecisionResult {
    let g = o.alignment;
    let n = g.offsets.len();
    let mut out = PodcastPrecisionResult {
        offsets: g.offsets.clone(),
        unverified: vec![],
        drifting: vec![],
    };
    if !valid_group(&g) || o.windows.len() != o.estimates.len() || o.windows.len() > 315 {
        out.offsets = vec![None; n.min(64)];
        return out;
    }
    let mut corrections = vec![None; n];
    corrections[g.reference_index] = Some(0.0);
    // Tree traversal preserves the original common clock, including microphone
    // phase relationships. Unverified edges retain their coarse relative lag.
    for _ in 0..n {
        for target in 0..n {
            if corrections[target].is_some() {
                continue;
            }
            let Some(parent) = g.parents[target] else {
                continue;
            };
            let Some(base) = corrections[parent] else {
                continue;
            };
            let mut evidence: Vec<_> = o
                .windows
                .iter()
                .zip(&o.estimates)
                .filter(|(w, e)| {
                    w.target_index == target
                        && w.reference_index == parent
                        && e.confidence >= 0.12
                        && e.confidence <= 1.0
                        && e.offset_seconds.is_finite()
                        && e.offset_seconds.abs() < 0.5
                })
                .map(|(_, e)| e)
                .collect();
            evidence.sort_by(|a, b| a.offset_seconds.total_cmp(&b.offset_seconds));
            let mut correction = 0.0;
            if evidence.len() >= 2 {
                let median = evidence[evidence.len() / 2].offset_seconds;
                let agreeing: Vec<_> = evidence
                    .iter()
                    .filter(|e| (e.offset_seconds - median).abs() <= 0.015)
                    .collect();
                if agreeing.len() >= 2 {
                    let weight: f64 = agreeing.iter().map(|e| e.confidence).sum();
                    correction = agreeing
                        .iter()
                        .map(|e| e.offset_seconds * e.confidence)
                        .sum::<f64>()
                        / weight;
                    // Any high-quality inconsistent window can be clock drift.
                    if evidence.iter().any(|e| {
                        e.confidence >= 0.3 && (e.offset_seconds - correction).abs() > 0.03
                    }) {
                        out.drifting.push(target);
                    }
                } else {
                    out.drifting.push(target);
                    out.unverified.push(target);
                }
            } else {
                out.unverified.push(target);
            }
            corrections[target] = Some(base + correction);
            out.offsets[target] = Some(g.offsets[target].unwrap() + base + correction);
        }
    }
    for (i, c) in corrections.iter().enumerate() {
        if c.is_none() {
            out.offsets[i] = None;
            out.unverified.push(i);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn noise(n: usize) -> Vec<f32> {
        let mut x = 17321u64;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x % 10000) as f32 / 5000.0 - 1.0
            })
            .collect()
    }
    #[test]
    fn signed_waveform_finds_subframe_offsets_with_gain_polarity_and_rumble() {
        let signal = noise(80000);
        let a = signal[..64000].to_vec();
        let b: Vec<_> = signal[2773..66773]
            .iter()
            .map(|v| -0.17 * v + 0.4)
            .collect();
        for (reference, target, expected) in [
            (a.clone(), b.clone(), 2773.0 / 16000.0),
            (b, a, -2773.0 / 16000.0),
        ] {
            let r = estimate_podcast_precision(PodcastPrecisionOptions {
                reference,
                target,
                sample_rate: 16000,
            });
            assert!((r.offset_seconds - expected).abs() < 1.0 / 16000.0);
            assert!(r.confidence > 0.99);
        }
    }
    #[test]
    fn silence_tones_invalid_and_unrelated_audio_are_not_precise() {
        let tone: Vec<_> = (0..64000).map(|i| (i as f32 * 0.1).sin()).collect();
        for (a, b) in [
            (vec![0.0; 64000], vec![0.0; 64000]),
            (tone.clone(), tone),
            (noise(64000), noise(128000)[64000..].to_vec()),
            (vec![f32::NAN; 64000], noise(64000)),
        ] {
            assert_eq!(
                estimate_podcast_precision(PodcastPrecisionOptions {
                    reference: a,
                    target: b,
                    sample_rate: 16000
                })
                .confidence,
                0.0
            );
        }
    }
    fn group() -> PodcastGroupAlignment {
        PodcastGroupAlignment {
            offsets: vec![Some(0.0), Some(10.0), Some(-5.0)],
            confidence: vec![1.0; 3],
            reference_index: 0,
            parents: vec![None, Some(0), Some(1)],
        }
    }
    #[test]
    fn bounded_windows_and_refinement_preserve_shared_clock_and_detect_drift() {
        let windows = plan_podcast_precision(PodcastPrecisionPlanOptions {
            alignment: group(),
            durations: vec![36000.0; 3],
        });
        assert_eq!(windows.len(), 10);
        assert!(windows.iter().all(|w| w.duration_seconds == 8.0
            && w.reference_start >= 0.0
            && w.target_start >= 0.0));
        let estimates = windows
            .iter()
            .map(|w| PodcastPrecisionEstimate {
                offset_seconds: if w.target_index == 1 {
                    0.1733125
                } else {
                    -0.02
                },
                confidence: 0.8,
            })
            .collect();
        let r = resolve_podcast_precision(PodcastPrecisionResolveOptions {
            alignment: group(),
            windows: windows.clone(),
            estimates,
        });
        assert!((r.offsets[1].unwrap() - 10.1733125).abs() < 1e-8);
        assert!((r.offsets[2].unwrap() - (-4.8466875)).abs() < 1e-8);
        assert!(r.unverified.is_empty() && r.drifting.is_empty());
        let estimates = windows
            .iter()
            .enumerate()
            .map(|(i, _)| PodcastPrecisionEstimate {
                offset_seconds: (i % 3) as f64 * 0.1,
                confidence: 0.8,
            })
            .collect();
        let r = resolve_podcast_precision(PodcastPrecisionResolveOptions {
            alignment: group(),
            windows,
            estimates,
        });
        assert_eq!(r.drifting.len(), 2);
    }
    #[test]
    fn missing_waveform_evidence_retains_coarse_offsets_and_warns() {
        let r = resolve_podcast_precision(PodcastPrecisionResolveOptions {
            alignment: group(),
            windows: vec![],
            estimates: vec![],
        });
        assert_eq!(r.offsets, group().offsets);
        assert_eq!(r.unverified, vec![1, 2]);
    }
}
