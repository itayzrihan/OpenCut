use bridge::export;
use serde::{Deserialize, Serialize};

const EPSILON_SECONDS: f64 = 0.000_001;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysisFrame {
    pub start: f64,
    pub end: f64,
    pub rms: f64,
    pub peak: f64,
    #[serde(default)]
    pub zero_crossing_rate: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysisRange {
    pub start: f64,
    pub end: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWordTiming {
    pub word_index: usize,
    pub start: f64,
    pub end: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSilenceAnalysisSettings {
    #[serde(default = "default_min_silence_seconds")]
    pub min_silence_seconds: f64,
    #[serde(default = "default_min_speech_seconds")]
    pub min_speech_seconds: f64,
    #[serde(default = "default_speech_padding_seconds")]
    pub speech_padding_seconds: f64,
    #[serde(default = "default_bridge_gap_seconds")]
    pub bridge_gap_seconds: f64,
    #[serde(default = "default_noise_percentile")]
    pub noise_percentile: f64,
    #[serde(default = "default_min_threshold")]
    pub min_threshold: f64,
    #[serde(default = "default_max_threshold")]
    pub max_threshold: f64,
    #[serde(default = "default_hysteresis_ratio")]
    pub hysteresis_ratio: f64,
    #[serde(default = "default_max_word_snap_seconds")]
    pub max_word_snap_seconds: f64,
    #[serde(default = "default_min_word_duration_seconds")]
    pub min_word_duration_seconds: f64,
}

impl Default for AudioSilenceAnalysisSettings {
    fn default() -> Self {
        Self {
            min_silence_seconds: default_min_silence_seconds(),
            min_speech_seconds: default_min_speech_seconds(),
            speech_padding_seconds: default_speech_padding_seconds(),
            bridge_gap_seconds: default_bridge_gap_seconds(),
            noise_percentile: default_noise_percentile(),
            min_threshold: default_min_threshold(),
            max_threshold: default_max_threshold(),
            hysteresis_ratio: default_hysteresis_ratio(),
            max_word_snap_seconds: default_max_word_snap_seconds(),
            min_word_duration_seconds: default_min_word_duration_seconds(),
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAudioSilenceOptions {
    pub frames: Vec<AudioAnalysisFrame>,
    pub duration_seconds: f64,
    #[serde(default)]
    pub transcript_words: Vec<TranscriptWordTiming>,
    #[serde(default)]
    pub settings: AudioSilenceAnalysisSettings,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastAudioSilenceSettings {
    #[serde(default = "default_fast_rms_threshold")]
    pub rms_threshold: f64,
    #[serde(default = "default_fast_min_silence_seconds")]
    pub min_silence_seconds: f64,
    #[serde(default = "default_fast_padding_seconds")]
    pub padding_seconds: f64,
}

impl Default for FastAudioSilenceSettings {
    fn default() -> Self {
        Self {
            rms_threshold: default_fast_rms_threshold(),
            min_silence_seconds: default_fast_min_silence_seconds(),
            padding_seconds: default_fast_padding_seconds(),
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectFastAudioSilenceOptions {
    pub frames: Vec<AudioAnalysisFrame>,
    pub duration_seconds: f64,
    #[serde(default)]
    pub settings: FastAudioSilenceSettings,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSilenceAnalysisDiagnostics {
    pub analyzed_duration_seconds: f64,
    pub frames_analyzed: usize,
    pub noise_floor: f64,
    pub speech_threshold: f64,
    pub release_threshold: f64,
    pub speech_region_count: usize,
    pub cut_range_count: usize,
    pub transcript_words_refined: usize,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSilenceAnalysisResult {
    pub cut_ranges: Vec<AudioAnalysisRange>,
    pub speech_regions: Vec<AudioAnalysisRange>,
    pub refined_words: Vec<TranscriptWordTiming>,
    pub diagnostics: AudioSilenceAnalysisDiagnostics,
}

/// Retains the original quick-cut behavior while keeping its thresholds in
/// shared Rust instead of duplicating timeline policy in each UI shell.
#[export]
pub fn detect_fast_audio_silence(
    DetectFastAudioSilenceOptions {
        frames,
        duration_seconds,
        settings,
    }: DetectFastAudioSilenceOptions,
) -> Vec<AudioAnalysisRange> {
    let duration = finite_non_negative(duration_seconds);
    let frames = sanitize_frames(frames, duration);
    let defaults = FastAudioSilenceSettings::default();
    let rms_threshold = positive_or(settings.rms_threshold, defaults.rms_threshold);
    let min_silence_seconds =
        positive_or(settings.min_silence_seconds, defaults.min_silence_seconds);
    let padding_seconds = finite_non_negative(settings.padding_seconds).min(1.0);
    let mut ranges = Vec::new();
    let mut silence_start = None;

    for (index, frame) in frames.iter().enumerate() {
        let is_silent = frame.rms < rms_threshold;
        if is_silent && silence_start.is_none() {
            silence_start = Some(frame.start);
        }
        let is_last_frame = index + 1 == frames.len();
        if let Some(start) = silence_start
            && (!is_silent || is_last_frame)
        {
            let silence_end = if is_silent { frame.end } else { frame.start };
            if silence_end - start + EPSILON_SECONDS >= min_silence_seconds {
                let padded_start = start + padding_seconds;
                let padded_end = silence_end - padding_seconds;
                if padded_end > padded_start {
                    ranges.push(AudioAnalysisRange {
                        start: padded_start,
                        end: padded_end,
                    });
                }
            }
            silence_start = None;
        }
    }

    ranges
}

/// Detects speech and silence from compact audio features. The UI shell owns
/// decoding, while adaptive thresholds, hysteresis, gap bridging, and bounded
/// transcript realignment remain shared Rust policy for every app.
#[export]
pub fn analyze_audio_silence(
    AnalyzeAudioSilenceOptions {
        frames,
        duration_seconds,
        transcript_words,
        settings,
    }: AnalyzeAudioSilenceOptions,
) -> AudioSilenceAnalysisResult {
    let duration = finite_non_negative(duration_seconds);
    let settings = sanitize_settings(settings);
    let frames = sanitize_frames(frames, duration);
    if duration <= EPSILON_SECONDS || frames.is_empty() {
        return empty_result(duration, frames.len(), transcript_words);
    }

    let mut rms_values = frames.iter().map(|frame| frame.rms).collect::<Vec<_>>();
    rms_values.sort_by(f64::total_cmp);
    let noise_floor = percentile(&rms_values, settings.noise_percentile);
    // A 95th percentile still ignores isolated clicks while recognizing short
    // spoken phrases that occupy much less than half of a selected clip.
    let high_energy = percentile(&rms_values, 0.95).max(noise_floor);
    let dynamic_range = (high_energy - noise_floor).max(0.0);
    // A pure multiplier fails on recordings with a high steady noise floor.
    // Cap it by a fraction of the observed dynamic range instead.
    let adaptive_threshold = (noise_floor * 1.8)
        .min(noise_floor + dynamic_range * 0.36)
        .max(settings.min_threshold)
        .min(settings.max_threshold);
    let release_threshold =
        (adaptive_threshold * settings.hysteresis_ratio).max(settings.min_threshold * 0.65);

    let scores = smoothed_activity_scores(&frames);
    let word_anchors = transcript_anchor_frames(&frames, &transcript_words, duration);
    let mut active = vec![false; frames.len()];
    let mut in_speech = false;
    for index in 0..frames.len() {
        let threshold = if in_speech {
            release_threshold
        } else {
            adaptive_threshold
        };
        let anchored = word_anchors[index]
            && scores[index]
                >= (noise_floor + dynamic_range * 0.04).max(settings.min_threshold * 0.5);
        if scores[index] >= threshold || anchored {
            in_speech = true;
            active[index] = true;
        } else {
            in_speech = false;
        }
    }

    let raw_regions = active_regions(&frames, &active);
    let bridged_regions = merge_close_ranges(raw_regions, settings.bridge_gap_seconds);
    let meaningful_regions = bridged_regions
        .into_iter()
        .filter(|range| {
            range.end - range.start + EPSILON_SECONDS >= settings.min_speech_seconds
                || transcript_words.iter().any(|word| {
                    let center = (word.start + word.end.max(word.start)) / 2.0;
                    center >= range.start && center <= range.end
                })
        })
        .collect::<Vec<_>>();
    let speech_regions = merge_close_ranges(
        meaningful_regions
            .iter()
            .map(|range| AudioAnalysisRange {
                start: (range.start - settings.speech_padding_seconds).max(0.0),
                end: (range.end + settings.speech_padding_seconds).min(duration),
            })
            .collect(),
        0.0,
    );

    // With no speech evidence, do not erase a deliberately silent visual clip.
    let cut_ranges = if speech_regions.is_empty() {
        Vec::new()
    } else {
        complement_ranges(&speech_regions, duration)
            .into_iter()
            .filter(|range| {
                range.end - range.start + EPSILON_SECONDS >= settings.min_silence_seconds
            })
            .collect::<Vec<_>>()
    };
    let original_words = transcript_words.clone();
    let refined_words =
        refine_transcript_words(transcript_words, &meaningful_regions, duration, &settings);
    let transcript_words_refined = refined_words
        .iter()
        .filter(|word| {
            original_words
                .iter()
                .find(|original| original.word_index == word.word_index)
                .is_some_and(|original| {
                    (original.start - word.start).abs() > EPSILON_SECONDS
                        || (original.end - word.end).abs() > EPSILON_SECONDS
                })
        })
        .count();

    AudioSilenceAnalysisResult {
        diagnostics: AudioSilenceAnalysisDiagnostics {
            analyzed_duration_seconds: duration,
            frames_analyzed: frames.len(),
            noise_floor,
            speech_threshold: adaptive_threshold,
            release_threshold,
            speech_region_count: speech_regions.len(),
            cut_range_count: cut_ranges.len(),
            transcript_words_refined,
        },
        cut_ranges,
        speech_regions,
        refined_words,
    }
}

fn default_min_silence_seconds() -> f64 {
    0.32
}
fn default_min_speech_seconds() -> f64 {
    0.08
}
fn default_speech_padding_seconds() -> f64 {
    0.1
}
fn default_bridge_gap_seconds() -> f64 {
    0.14
}
fn default_noise_percentile() -> f64 {
    0.2
}
fn default_min_threshold() -> f64 {
    0.0045
}
fn default_max_threshold() -> f64 {
    0.08
}
fn default_hysteresis_ratio() -> f64 {
    0.72
}
fn default_max_word_snap_seconds() -> f64 {
    0.28
}
fn default_min_word_duration_seconds() -> f64 {
    0.07
}
fn default_fast_rms_threshold() -> f64 {
    0.012
}
fn default_fast_min_silence_seconds() -> f64 {
    0.45
}
fn default_fast_padding_seconds() -> f64 {
    0.08
}

fn sanitize_settings(mut settings: AudioSilenceAnalysisSettings) -> AudioSilenceAnalysisSettings {
    let defaults = AudioSilenceAnalysisSettings::default();
    settings.min_silence_seconds =
        positive_or(settings.min_silence_seconds, defaults.min_silence_seconds);
    settings.min_speech_seconds =
        positive_or(settings.min_speech_seconds, defaults.min_speech_seconds);
    settings.speech_padding_seconds = finite_non_negative(settings.speech_padding_seconds).min(1.0);
    settings.bridge_gap_seconds = finite_non_negative(settings.bridge_gap_seconds).min(1.0);
    settings.noise_percentile = if settings.noise_percentile.is_finite() {
        settings.noise_percentile.clamp(0.0, 0.8)
    } else {
        defaults.noise_percentile
    };
    settings.min_threshold = positive_or(settings.min_threshold, defaults.min_threshold);
    settings.max_threshold =
        positive_or(settings.max_threshold, defaults.max_threshold).max(settings.min_threshold);
    settings.hysteresis_ratio = if settings.hysteresis_ratio.is_finite() {
        settings.hysteresis_ratio.clamp(0.2, 0.98)
    } else {
        defaults.hysteresis_ratio
    };
    settings.max_word_snap_seconds = finite_non_negative(settings.max_word_snap_seconds).min(1.0);
    settings.min_word_duration_seconds = positive_or(
        settings.min_word_duration_seconds,
        defaults.min_word_duration_seconds,
    )
    .min(1.0);
    settings
}

fn sanitize_frames(frames: Vec<AudioAnalysisFrame>, duration: f64) -> Vec<AudioAnalysisFrame> {
    let mut frames = frames
        .into_iter()
        .filter_map(|frame| {
            if !frame.start.is_finite() || !frame.end.is_finite() || frame.end <= frame.start {
                return None;
            }
            let start = frame.start.clamp(0.0, duration);
            let end = frame.end.clamp(start, duration);
            if end <= start {
                return None;
            }
            Some(AudioAnalysisFrame {
                start,
                end,
                rms: finite_non_negative(frame.rms),
                peak: finite_non_negative(frame.peak),
                zero_crossing_rate: finite_non_negative(frame.zero_crossing_rate).min(1.0),
            })
        })
        .collect::<Vec<_>>();
    frames.sort_by(|left, right| left.start.total_cmp(&right.start));
    frames
}

fn smoothed_activity_scores(frames: &[AudioAnalysisFrame]) -> Vec<f64> {
    let raw = frames
        .iter()
        .map(|frame| {
            let transient = (frame.peak - frame.rms).max(0.0);
            frame.rms + transient * 0.08
        })
        .collect::<Vec<_>>();
    (0..raw.len())
        .map(|index| {
            let start = index.saturating_sub(1);
            let end = (index + 1).min(raw.len() - 1);
            raw[start..=end].iter().sum::<f64>() / (end - start + 1) as f64
        })
        .collect()
}

fn transcript_anchor_frames(
    frames: &[AudioAnalysisFrame],
    words: &[TranscriptWordTiming],
    duration: f64,
) -> Vec<bool> {
    frames
        .iter()
        .map(|frame| {
            words.iter().any(|word| {
                let start = finite_non_negative(word.start).min(duration);
                let end = finite_non_negative(word.end).max(start).min(duration);
                let center = (start + end) / 2.0;
                let half_width = ((end - start) * 0.18).clamp(0.035, 0.12);
                frame.end >= center - half_width && frame.start <= center + half_width
            })
        })
        .collect()
}

fn active_regions(frames: &[AudioAnalysisFrame], active: &[bool]) -> Vec<AudioAnalysisRange> {
    let mut ranges = Vec::new();
    let mut start = None;
    let mut end = 0.0;
    for (frame, is_active) in frames.iter().zip(active) {
        if *is_active {
            start.get_or_insert(frame.start);
            end = frame.end;
        } else if let Some(region_start) = start.take() {
            ranges.push(AudioAnalysisRange {
                start: region_start,
                end,
            });
        }
    }
    if let Some(region_start) = start {
        ranges.push(AudioAnalysisRange {
            start: region_start,
            end,
        });
    }
    ranges
}

fn merge_close_ranges(
    mut ranges: Vec<AudioAnalysisRange>,
    max_gap: f64,
) -> Vec<AudioAnalysisRange> {
    ranges.sort_by(|left, right| left.start.total_cmp(&right.start));
    let mut merged = Vec::<AudioAnalysisRange>::new();
    for range in ranges {
        let Some(previous) = merged.last_mut() else {
            merged.push(range);
            continue;
        };
        if range.start <= previous.end + max_gap + EPSILON_SECONDS {
            previous.end = previous.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn complement_ranges(ranges: &[AudioAnalysisRange], duration: f64) -> Vec<AudioAnalysisRange> {
    let mut cuts = Vec::new();
    let mut cursor = 0.0;
    for range in ranges {
        if range.start > cursor + EPSILON_SECONDS {
            cuts.push(AudioAnalysisRange {
                start: cursor,
                end: range.start,
            });
        }
        cursor = cursor.max(range.end);
    }
    if cursor < duration - EPSILON_SECONDS {
        cuts.push(AudioAnalysisRange {
            start: cursor,
            end: duration,
        });
    }
    cuts
}

fn refine_transcript_words(
    words: Vec<TranscriptWordTiming>,
    speech_regions: &[AudioAnalysisRange],
    duration: f64,
    settings: &AudioSilenceAnalysisSettings,
) -> Vec<TranscriptWordTiming> {
    let mut refined = words
        .into_iter()
        .filter_map(|word| {
            if !word.start.is_finite() || !word.end.is_finite() {
                return None;
            }
            let original_start = word.start.clamp(0.0, duration);
            let original_end = word.end.max(word.start).clamp(original_start, duration);
            let search_start = (original_start - settings.max_word_snap_seconds).max(0.0);
            let search_end = (original_end + settings.max_word_snap_seconds).min(duration);
            let candidates = speech_regions
                .iter()
                .filter(|region| region.end >= search_start && region.start <= search_end)
                .collect::<Vec<_>>();
            let mut start = original_start;
            let mut end = original_end;
            if let Some(candidate) = candidates.iter().min_by(|left, right| {
                let left_distance = distance_to_range(original_start, left);
                let right_distance = distance_to_range(original_start, right);
                left_distance.total_cmp(&right_distance)
            }) {
                if (candidate.start - original_start).abs() <= settings.max_word_snap_seconds {
                    start = candidate.start;
                }
            }
            if let Some(candidate) = candidates.iter().min_by(|left, right| {
                let left_distance = distance_to_range(original_end, left);
                let right_distance = distance_to_range(original_end, right);
                left_distance.total_cmp(&right_distance)
            }) {
                if (candidate.end - original_end).abs() <= settings.max_word_snap_seconds {
                    end = candidate.end;
                }
            }
            if end < start + settings.min_word_duration_seconds {
                let center = ((start + end) / 2.0).clamp(0.0, duration);
                start = (center - settings.min_word_duration_seconds / 2.0).max(0.0);
                end = (start + settings.min_word_duration_seconds).min(duration);
                start = (end - settings.min_word_duration_seconds).max(0.0);
            }
            Some(TranscriptWordTiming {
                word_index: word.word_index,
                start,
                end,
            })
        })
        .collect::<Vec<_>>();
    refined.sort_by(|left, right| {
        left.start
            .total_cmp(&right.start)
            .then_with(|| left.word_index.cmp(&right.word_index))
    });
    remove_word_overlaps(&mut refined, settings.min_word_duration_seconds, duration);
    refined.sort_by_key(|word| word.word_index);
    refined
}

fn remove_word_overlaps(words: &mut [TranscriptWordTiming], min_duration: f64, duration: f64) {
    for index in 1..words.len() {
        let (before, after) = words.split_at_mut(index);
        let previous = &mut before[index - 1];
        let current = &mut after[0];
        if previous.end <= current.start + EPSILON_SECONDS {
            continue;
        }
        let span_start = previous.start;
        let span_end = previous.end.max(current.end).min(duration);
        let available = span_end - span_start;
        if available >= min_duration * 2.0 {
            let boundary = ((previous.end + current.start) / 2.0)
                .clamp(span_start + min_duration, span_end - min_duration);
            previous.end = boundary;
            current.start = boundary;
        } else {
            let boundary = (span_start + available / 2.0).clamp(span_start, span_end);
            previous.end = boundary;
            current.start = boundary;
            current.end = current.end.max(boundary).min(duration);
        }
    }
}

fn distance_to_range(value: f64, range: &AudioAnalysisRange) -> f64 {
    if value < range.start {
        range.start - value
    } else if value > range.end {
        value - range.end
    } else {
        0.0
    }
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let position = percentile.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        let fraction = position - lower as f64;
        sorted[lower] * (1.0 - fraction) + sorted[upper] * fraction
    }
}

fn empty_result(
    duration: f64,
    frames_analyzed: usize,
    transcript_words: Vec<TranscriptWordTiming>,
) -> AudioSilenceAnalysisResult {
    AudioSilenceAnalysisResult {
        cut_ranges: Vec::new(),
        speech_regions: Vec::new(),
        refined_words: transcript_words,
        diagnostics: AudioSilenceAnalysisDiagnostics {
            analyzed_duration_seconds: duration,
            frames_analyzed,
            noise_floor: 0.0,
            speech_threshold: 0.0,
            release_threshold: 0.0,
            speech_region_count: 0,
            cut_range_count: 0,
            transcript_words_refined: 0,
        },
    }
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn positive_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(energies: &[f64], frame_duration: f64) -> Vec<AudioAnalysisFrame> {
        energies
            .iter()
            .enumerate()
            .map(|(index, energy)| AudioAnalysisFrame {
                start: index as f64 * frame_duration,
                end: (index + 1) as f64 * frame_duration,
                rms: *energy,
                peak: *energy * 1.4,
                zero_crossing_rate: 0.1,
            })
            .collect()
    }

    #[test]
    fn adapts_to_a_noisy_recording_and_cuts_the_long_pause() {
        let mut energies = vec![0.02; 100];
        energies[10..30].fill(0.055);
        energies[65..90].fill(0.06);
        let result = analyze_audio_silence(AnalyzeAudioSilenceOptions {
            frames: frames(&energies, 0.02),
            duration_seconds: 2.0,
            transcript_words: vec![],
            settings: AudioSilenceAnalysisSettings::default(),
        });

        assert!(result.diagnostics.noise_floor >= 0.019);
        assert_eq!(result.cut_ranges.len(), 1);
        assert!(result.cut_ranges[0].start >= 0.6);
        assert!(result.cut_ranges[0].end <= 1.3);
    }

    #[test]
    fn bridges_short_dropouts_inside_speech() {
        let mut energies = vec![0.002; 60];
        energies[5..45].fill(0.05);
        energies[22..26].fill(0.001);
        let result = analyze_audio_silence(AnalyzeAudioSilenceOptions {
            frames: frames(&energies, 0.02),
            duration_seconds: 1.2,
            transcript_words: vec![],
            settings: AudioSilenceAnalysisSettings::default(),
        });

        assert_eq!(result.speech_regions.len(), 1);
    }

    #[test]
    fn refines_words_to_activity_and_keeps_them_non_overlapping() {
        let mut energies = vec![0.001; 100];
        energies[10..28].fill(0.05);
        energies[30..48].fill(0.05);
        let result = analyze_audio_silence(AnalyzeAudioSilenceOptions {
            frames: frames(&energies, 0.02),
            duration_seconds: 2.0,
            transcript_words: vec![
                TranscriptWordTiming {
                    word_index: 0,
                    start: 0.25,
                    end: 0.65,
                },
                TranscriptWordTiming {
                    word_index: 1,
                    start: 0.5,
                    end: 0.9,
                },
            ],
            settings: AudioSilenceAnalysisSettings::default(),
        });

        assert_eq!(result.refined_words.len(), 2);
        assert!(result.refined_words[0].end <= result.refined_words[1].start);
        assert!(
            result
                .refined_words
                .iter()
                .all(|word| word.end > word.start)
        );
    }

    #[test]
    fn does_not_erase_a_clip_without_any_speech_evidence() {
        let result = analyze_audio_silence(AnalyzeAudioSilenceOptions {
            frames: frames(&vec![0.001; 100], 0.02),
            duration_seconds: 2.0,
            transcript_words: vec![],
            settings: AudioSilenceAnalysisSettings::default(),
        });

        assert!(result.cut_ranges.is_empty());
    }

    #[test]
    fn fast_mode_retains_the_original_threshold_and_padding() {
        let mut energies = vec![0.001; 12];
        energies[8..].fill(0.1);
        let ranges = detect_fast_audio_silence(DetectFastAudioSilenceOptions {
            frames: frames(&energies, 0.1),
            duration_seconds: 1.2,
            settings: FastAudioSilenceSettings::default(),
        });

        assert_eq!(ranges.len(), 1);
        assert!((ranges[0].start - 0.08).abs() < EPSILON_SECONDS);
        assert!((ranges[0].end - 0.72).abs() < EPSILON_SECONDS);
    }
}
