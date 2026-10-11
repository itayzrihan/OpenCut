//! Sample-peak brickwall limiter with linked channels, anticipatory gain ramps
//! and a 12 dB release interval. Operates on bounded interleaved host PCM.
#[cfg_attr(feature = "wasm", wasm_bindgen::prelude::wasm_bindgen(js_name = hardLimitAudio))]
pub fn hard_limit_audio(
    samples: &[f32],
    channels: u32,
    sample_rate: u32,
    ceiling_db: f32,
    look_ahead_ms: f32,
    release_ms: f32,
) -> Vec<f32> {
    if channels == 0
        || channels > 32
        || !(8000..=192000).contains(&sample_rate)
        || samples.len() % channels as usize != 0
        || samples.len() > sample_rate as usize * channels as usize * 4
        || !ceiling_db.is_finite()
        || !look_ahead_ms.is_finite()
        || !release_ms.is_finite()
    {
        return samples.to_vec();
    }
    let channels = channels as usize;
    let ceiling = 10.0_f32.powf(ceiling_db.clamp(-60.0, 0.0) / 20.0);
    let attack_step = 1.0 / (sample_rate as f32 * look_ahead_ms.clamp(1.0, 20.0) / 1000.0).max(1.0);
    let release_step = 12.0 / (sample_rate as f32 * release_ms.clamp(10.0, 250.0) / 1000.0);
    let mut gains: Vec<f32> = samples
        .chunks_exact(channels)
        .map(|frame| {
            let peak = frame
                .iter()
                .filter(|v| v.is_finite())
                .fold(0.0_f32, |p, v| p.max(v.abs()));
            if peak > ceiling {
                ceiling / peak
            } else {
                1.0
            }
        })
        .collect();
    // Backwards ramp starts reducing gain before each transient, without moving
    // samples or truncating the tail. At most lookAhead worth of future is used.
    for i in (0..gains.len().saturating_sub(1)).rev() {
        gains[i] = gains[i].min(gains[i + 1] + attack_step);
    }
    let mut attenuation_db = 0.0_f32;
    let mut output = Vec::with_capacity(samples.len());
    for (frame, gain) in samples.chunks_exact(channels).zip(gains) {
        let target = 20.0 * gain.max(1e-20).log10();
        attenuation_db = target.min(attenuation_db + release_step);
        let gain = 10.0_f32.powf(attenuation_db / 20.0);
        output.extend(frame.iter().map(|v| {
            if v.is_finite() {
                (v * gain).clamp(-ceiling, ceiling)
            } else {
                0.0
            }
        }));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ceiling_stereo_link_and_timing_survive_boost_and_tail() {
        let n = 48000;
        let mut pcm = vec![0.0; n * 2];
        for i in 0..n {
            pcm[i * 2] = if i == 24000 || i == n - 1 { 8.0 } else { 0.1 };
            pcm[i * 2 + 1] = pcm[i * 2] * 0.5;
        }
        let wet = hard_limit_audio(&pcm, 2, 48000, -1.0, 7.0, 100.0);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0);
        assert_eq!(wet.len(), pcm.len());
        assert!(wet.iter().all(|v| v.abs() <= ceiling));
        assert!((wet[48000] - ceiling).abs() < 1e-6);
        assert!((wet[n * 2 - 2] - ceiling).abs() < 1e-6);
        for f in wet.chunks_exact(2) {
            assert!((f[1] - f[0] * 0.5).abs() < 1e-7);
        }
        assert!(wet[47998] < pcm[47998]); // lookahead acts before the spike
        assert!((wet[96000 - 10] - 0.1).abs() > 0.0); // anticipates final spike too
    }
    #[test]
    fn quiet_audio_identity_and_release_recovers() {
        let input = vec![0.1; 48000];
        assert_eq!(hard_limit_audio(&input, 1, 48000, -1.0, 7.0, 100.0), input);
        let mut input = input;
        input[1000] = 8.0;
        let wet = hard_limit_audio(&input, 1, 48000, -1.0, 7.0, 100.0);
        assert!(wet[1001] < 0.1);
        assert!((wet[20000] - 0.1).abs() < 1e-6);
    }
    #[test]
    fn windows_with_context_match_and_nonfinite_input_is_sanitized() {
        let mut input = vec![0.2; 48000 * 4];
        input[95999] = 10.0;
        input[96001] = -5.0;
        let full = hard_limit_audio(&input, 1, 48000, -1.0, 7.0, 100.0);
        let start = 48000;
        let end = 144000;
        let part = hard_limit_audio(&input[start..end + 1000], 1, 48000, -1.0, 7.0, 100.0);
        assert_eq!(&full[96000..end], &part[48000..96000]);
        assert_eq!(
            hard_limit_audio(&[f32::NAN, f32::INFINITY], 1, 48000, -1.0, 7.0, 100.0),
            vec![0.0, 0.0]
        );
    }
}
