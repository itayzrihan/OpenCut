//! Bounded FFT envelope alignment; positive lag means target starts later.
use bridge::export;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastAlignmentOptions {
    pub reference: Vec<f32>,
    pub target: Vec<f32>,
    pub resolution_seconds: f64,
    pub max_lag_seconds: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastAlignmentEstimate {
    pub offset_seconds: f64,
    /// Pearson correlation of the overlapping samples; zero means no evidence.
    pub confidence: f64,
    pub overlap_seconds: f64,
}
#[export]
pub fn estimate_podcast_alignment(o: PodcastAlignmentOptions) -> PodcastAlignmentEstimate {
    let none = || PodcastAlignmentEstimate {
        offset_seconds: 0.0,
        confidence: 0.0,
        overlap_seconds: 0.0,
    };
    let (a, b) = (&o.reference, &o.target);
    if a.len() < 100
        || b.len() < 100
        || a.len().max(b.len()) > 3_600_000
        || !o.resolution_seconds.is_finite()
        || !(0.001..=1.0).contains(&o.resolution_seconds)
        || !o.max_lag_seconds.is_finite()
        || !(0.0..=3600.0).contains(&o.max_lag_seconds)
        || a.iter().chain(b).any(|x| !x.is_finite() || *x < 0.0)
    {
        return none();
    }
    let moments = |x: &[f32]| {
        let mean = x.iter().map(|v| *v as f64).sum::<f64>() / x.len() as f64;
        let sd =
            (x.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        (mean, sd)
    };
    let (am, asd) = moments(a);
    let (bm, bsd) = moments(b);
    if asd < 1e-9 || bsd < 1e-9 {
        return none();
    }
    let n = (a.len() + b.len() - 1).next_power_of_two();
    let mut left = vec![Complex::new(0.0f32, 0.0); n];
    let mut right = left.clone();
    for (d, v) in left.iter_mut().zip(a) {
        d.re = ((*v as f64 - am) / asd) as f32;
    }
    for (d, v) in right.iter_mut().zip(b) {
        d.re = ((*v as f64 - bm) / bsd) as f32;
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut left);
    fft.process(&mut right);
    for (l, r) in left.iter_mut().zip(&right) {
        *l *= r.conj();
    }
    planner.plan_fft_inverse(n).process(&mut left);
    let limit = (o.max_lag_seconds / o.resolution_seconds).round() as isize;
    let min_overlap = (a.len().min(b.len()) / 4).max(100);
    let mut best = f32::NEG_INFINITY;
    let mut lag = 0;
    for candidate in (-limit).max(-(b.len() as isize) + min_overlap as isize)
        ..=limit.min(a.len() as isize - min_overlap as isize)
    {
        let idx = if candidate < 0 {
            (n as isize + candidate) as usize
        } else {
            candidate as usize
        };
        if left[idx].re > best {
            best = left[idx].re;
            lag = candidate;
        }
    }
    let start = lag.max(0) as usize;
    let stop = (a.len() as isize).min(b.len() as isize + lag) as usize;
    if stop <= start {
        return none();
    }
    let (mut sx, mut sy, mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, x) in a.iter().enumerate().take(stop).skip(start) {
        let x = *x as f64;
        let y = b[(i as isize - lag) as usize] as f64;
        sx += x;
        sy += y;
        xx += x * x;
        yy += y * y;
        xy += x * y;
    }
    let count = (stop - start) as f64;
    let denom = ((xx - sx * sx / count) * (yy - sy * sy / count))
        .max(0.0)
        .sqrt();
    let confidence = if denom > 1e-12 {
        ((xy - sx * sy / count) / denom).clamp(0.0, 1.0)
    } else {
        0.0
    };
    PodcastAlignmentEstimate {
        offset_seconds: lag as f64 * o.resolution_seconds,
        confidence,
        overlap_seconds: count * o.resolution_seconds,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn signal() -> Vec<f32> {
        (0..5000)
            .map(|i| (((i * 7919 + i * i * 13) % 1009) as f32 / 1009.0).powi(3))
            .collect()
    }
    #[test]
    fn finds_both_offset_signs_despite_gain() {
        let a = signal();
        let b = a[137..].iter().map(|x| x * 0.2 + 0.01).collect::<Vec<_>>();
        for (reference, target, expected) in [(a.clone(), b.clone(), 1.37), (b, a, -1.37)] {
            let result = estimate_podcast_alignment(PodcastAlignmentOptions {
                reference,
                target,
                resolution_seconds: 0.01,
                max_lag_seconds: 5.0,
            });
            assert!((result.offset_seconds - expected).abs() < 1e-8);
            assert!(result.confidence > 0.999);
        }
    }
    #[test]
    fn silence_has_no_sync_confidence() {
        let result = estimate_podcast_alignment(PodcastAlignmentOptions {
            reference: vec![0.0; 1000],
            target: vec![0.0; 1000],
            resolution_seconds: 0.01,
            max_lag_seconds: 5.0,
        });
        assert_eq!(result.confidence, 0.0);
    }
}
