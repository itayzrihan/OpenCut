//! Speech noise suppression. The host supplies bounded PCM windows; no IO or
//! project state is owned here. RNNoise's one-frame delay is compensated before
//! dry/wet mixing, preserving sync and the final partial frame.
use nnnoiseless::DenoiseState;

fn sample(samples: &[f32], position: f64) -> f32 {
    let i = position.floor() as usize;
    let fraction = (position - i as f64) as f32;
    let a = samples.get(i).copied().unwrap_or(0.0);
    let b = samples.get(i + 1).copied().unwrap_or(a);
    a + (b - a) * fraction
}

#[cfg_attr(feature = "wasm", wasm_bindgen::prelude::wasm_bindgen(js_name = reduceAudioNoise))]
pub fn reduce_audio_noise(samples: &[f32], sample_rate: u32, amount: f32) -> Vec<f32> {
    if samples.is_empty() || !amount.is_finite() || amount <= 0.0 {
        return samples.to_vec();
    }
    // The host sends at most a 2-second window plus warmup. Bound work and
    // allocations even if this low-level WASM entry is called directly.
    if !(8000..=192000).contains(&sample_rate) || samples.len() > sample_rate as usize * 4 {
        return samples.to_vec();
    }
    let mix = amount.clamp(0.0, 100.0) / 100.0;
    let count = (samples.len() as f64 * 48000.0 / sample_rate as f64).ceil() as usize;
    let mut state = DenoiseState::new();
    let mut input = [0.0; 480];
    let mut output = [0.0; 480];
    let mut wet = vec![0.0; count];
    // Flush a final zero-padded frame to retain the last audible samples.
    for frame in 0..count.div_ceil(480) + 1 {
        for (i, value) in input.iter_mut().enumerate() {
            let n = frame * 480 + i;
            *value = if n < count {
                let s = sample(samples, n as f64 * sample_rate as f64 / 48000.0);
                if s.is_finite() {
                    s.clamp(-1.0, 1.0) * 32768.0
                } else {
                    0.0
                }
            } else {
                0.0
            };
        }
        state.process_frame(&mut output, &input);
        if frame == 0 {
            continue;
        }
        for (i, value) in output.iter().enumerate() {
            if let Some(dest) = wet.get_mut((frame - 1) * 480 + i) {
                *dest = *value / 32768.0;
            }
        }
    }
    samples
        .iter()
        .enumerate()
        .map(|(i, dry)| {
            let dry = if dry.is_finite() { *dry } else { 0.0 };
            dry * (1.0 - mix) + sample(&wet, i as f64 * 48000.0 / sample_rate as f64) * mix
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zero_is_bit_exact_and_partial_frame_is_retained() {
        let input: Vec<f32> = (0..11027).map(|i| (i as f32 * 0.1).sin() * 0.1).collect();
        assert_eq!(reduce_audio_noise(&input, 44100, 0.0), input);
        let wet = reduce_audio_noise(&input, 44100, 100.0);
        let half = reduce_audio_noise(&input, 44100, 50.0);
        assert_eq!(wet.len(), input.len());
        assert!(wet.iter().all(|s| s.is_finite()));
        for i in 0..input.len() {
            assert!((half[i] - (input[i] + wet[i]) * 0.5).abs() < 1e-6);
        }
    }
    #[test]
    fn suppresses_stationary_noise() {
        let mut seed = 42_u32;
        let input: Vec<f32> = (0..96000)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 8) as f32 / 16777216.0 - 0.5) * 0.06
            })
            .collect();
        let output = reduce_audio_noise(&input, 48000, 100.0);
        let energy = |v: &[f32]| v[24000..].iter().map(|x| x * x).sum::<f32>();
        assert!(
            energy(&output) < energy(&input) * 0.75,
            "noise energy ratio: {}",
            energy(&output) / energy(&input)
        );
    }
    #[test]
    fn silence_is_finite_and_channel_processing_is_independent() {
        assert!(
            reduce_audio_noise(&vec![0.0; 4800], 48000, 100.0)
                .iter()
                .all(|s| *s == 0.0)
        );
    }
}
