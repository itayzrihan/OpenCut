//! Real-valued spectral I/O for the DBS-TIGER ONNX graph.
use rustfft::{Fft, FftPlanner, num_complex::Complex};
use std::sync::Arc;

const FFT_SIZE: usize = 2048;
const HOP: usize = 512;
const BINS: usize = FFT_SIZE / 2 + 1;
const CENTER: usize = FFT_SIZE / 2;
const MAX_SAMPLES: usize = 6 * 44_100;

#[cfg_attr(feature = "wasm", wasm_bindgen::prelude::wasm_bindgen)]
pub struct DbsSpectrum {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
}

#[cfg_attr(feature = "wasm", wasm_bindgen::prelude::wasm_bindgen)]
impl DbsSpectrum {
    #[cfg_attr(feature = "wasm", wasm_bindgen::prelude::wasm_bindgen(constructor))]
    pub fn new() -> Self {
        let mut planner = FftPlanner::new();
        Self {
            forward: planner.plan_fft_forward(FFT_SIZE),
            inverse: planner.plan_fft_inverse(FFT_SIZE),
            window: (0..FFT_SIZE)
                .map(|i| {
                    0.5 * (1.0 - (std::f64::consts::TAU * i as f64 / FFT_SIZE as f64).cos()) as f32
                })
                .collect(),
        }
    }

    /// Torch's centered periodic-Hann STFT with reflection padding.
    /// Output is planar real/imaginary with time as the innermost dimension.
    pub fn analyze(&self, samples: &[f32]) -> Vec<f32> {
        if samples.len() <= CENTER || samples.len() > MAX_SAMPLES {
            return Vec::new();
        }
        let frames = samples.len() / HOP + 1;
        let mut output = vec![0.0; 2 * BINS * frames];
        let mut bins = vec![Complex::default(); FFT_SIZE];
        let mut scratch = vec![Complex::default(); self.forward.get_inplace_scratch_len()];
        for frame in 0..frames {
            for (i, bin) in bins.iter_mut().enumerate() {
                let padded = frame * HOP + i;
                let index = if padded < CENTER {
                    CENTER - padded
                } else if padded - CENTER >= samples.len() {
                    2 * (samples.len() - 1) + CENTER - padded
                } else {
                    padded - CENTER
                };
                *bin = Complex::new(samples[index] * self.window[i], 0.0);
            }
            self.forward.process_with_scratch(&mut bins, &mut scratch);
            for (bin, value) in bins[..BINS].iter().enumerate() {
                output[bin * frames + frame] = value.re;
                output[(bin + BINS) * frames + frame] = value.im;
            }
        }
        output
    }

    /// Input is [2, 3, bins, time] from ONNX. Output is three planar stems.
    pub fn synthesize(&self, spectra: &[f32], samples: usize) -> Vec<f32> {
        let frames = samples / HOP + 1;
        if samples <= CENTER || samples > MAX_SAMPLES || spectra.len() != 6 * BINS * frames {
            return Vec::new();
        }
        let mut output = vec![0.0; 3 * samples];
        let mut weights = vec![0.0; samples];
        let mut bins = vec![Complex::default(); FFT_SIZE];
        let mut scratch = vec![Complex::default(); self.inverse.get_inplace_scratch_len()];
        for frame in 0..frames {
            let padded = frame * HOP;
            let first = CENTER.saturating_sub(padded);
            let last = FFT_SIZE.min(samples + CENTER - padded);
            for stem in 0..3 {
                for bin in 0..BINS {
                    let index = (stem * BINS + bin) * frames + frame;
                    let value = Complex::new(spectra[index], spectra[index + 3 * BINS * frames]);
                    bins[bin] = value;
                    if bin > 0 && bin < CENTER {
                        bins[FFT_SIZE - bin] = value.conj();
                    }
                }
                self.inverse.process_with_scratch(&mut bins, &mut scratch);
                for i in first..last {
                    let sample = padded + i - CENTER;
                    output[stem * samples + sample] +=
                        bins[i].re * self.window[i] / FFT_SIZE as f32;
                    if stem == 0 {
                        weights[sample] += self.window[i] * self.window[i];
                    }
                }
            }
        }
        for stem in output.chunks_exact_mut(samples) {
            for (sample, weight) in stem.iter_mut().zip(&weights) {
                *sample /= weight;
            }
        }
        output
    }
}

impl Default for DbsSpectrum {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_three_stems_with_non_aligned_length() {
        let waveform: Vec<_> = (0..4373)
            .map(|i| ((i as f32 * 0.15).cos() + (i as f32 * 0.24).sin()) / 2.0)
            .collect();
        let fft = DbsSpectrum::new();
        let spectrum = fft.analyze(&waveform);
        let mut stems = Vec::new();
        for plane in spectrum.chunks_exact(spectrum.len() / 2) {
            for _ in 0..3 {
                stems.extend_from_slice(plane);
            }
        }
        for restored in fft
            .synthesize(&stems, waveform.len())
            .chunks_exact(waveform.len())
        {
            assert!(
                restored
                    .iter()
                    .zip(&waveform)
                    .all(|(a, b)| (a - b).abs() < 1e-5)
            );
        }
    }
}
