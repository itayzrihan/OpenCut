//! Conservative, classic-only audio silence analysis. This is deliberately a
//! separate policy from the existing audio/fast analyzers. Compact acoustic
//! features cannot prove that a quiet sound is not a word; uncertain recordings
//! are retained, and supplied transcript intervals are unconditional keep zones.
use crate::{AudioAnalysisFrame, AudioAnalysisRange, TranscriptWordTiming};
use bridge::export;
use serde::{Deserialize, Serialize};

const TIME_EPSILON: f64 = 0.000_01;
const MAX_FRAME_SECONDS: f64 = 0.04;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAudioSilenceSettings {
    #[serde(default = "default_min_silence_seconds")]
    pub min_silence_seconds: f64,
    #[serde(default = "default_padding_seconds")]
    pub speech_padding_seconds: f64,
    #[serde(default = "default_bridge_gap_seconds")]
    pub bridge_gap_seconds: f64,
}

impl Default for SmartAudioSilenceSettings {
    fn default() -> Self {
        Self {
            min_silence_seconds: default_min_silence_seconds(),
            speech_padding_seconds: default_padding_seconds(),
            bridge_gap_seconds: default_bridge_gap_seconds(),
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSmartAudioSilenceOptions {
    pub frames: Vec<AudioAnalysisFrame>,
    pub duration_seconds: f64,
    #[serde(default)]
    pub transcript_words: Vec<TranscriptWordTiming>,
    #[serde(default)]
    pub settings: SmartAudioSilenceSettings,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAudioSilenceAnalysisDiagnostics {
    pub analyzed_duration_seconds: f64,
    pub frames_analyzed: usize,
    /// Duration-weighted mean frame RMS over the entire selected audio span.
    pub average_rms: f64,
    pub noise_floor: f64,
    pub silence_threshold: f64,
    pub speech_region_count: usize,
    pub cut_range_count: usize,
    pub transcript_words_protected: usize,
    pub safety_hold_reason: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAudioSilenceAnalysisResult {
    pub cut_ranges: Vec<AudioAnalysisRange>,
    /// Acoustic activity, ambiguous audio, and transcript keep zones, padded.
    pub speech_regions: Vec<AudioAnalysisRange>,
    /// Kept for analyzer interoperability. Word boundaries are never narrowed.
    pub refined_words: Vec<TranscriptWordTiming>,
    pub diagnostics: SmartAudioSilenceAnalysisDiagnostics,
}

/// Removes only sustained, low-energy, stable noise with ample separation from
/// whole-clip energy. There is no absolute amplitude floor: multiplying every
/// sample by the same gain must not turn a whispered phrase into silence.
#[export]
pub fn analyze_smart_audio_silence(
    AnalyzeSmartAudioSilenceOptions {
        mut frames,
        duration_seconds,
        transcript_words,
        settings,
    }: AnalyzeSmartAudioSilenceOptions,
) -> SmartAudioSilenceAnalysisResult {
    let duration = if duration_seconds.is_finite() {
        duration_seconds.max(0.0)
    } else {
        0.0
    };
    let mut result = SmartAudioSilenceAnalysisResult {
        cut_ranges: Vec::new(),
        speech_regions: Vec::new(),
        refined_words: transcript_words,
        diagnostics: SmartAudioSilenceAnalysisDiagnostics {
            analyzed_duration_seconds: duration,
            frames_analyzed: frames.len(),
            average_rms: 0.0,
            noise_floor: 0.0,
            silence_threshold: 0.0,
            speech_region_count: 0,
            cut_range_count: 0,
            transcript_words_protected: 0,
            safety_hold_reason: None,
        },
    };
    if duration <= TIME_EPSILON {
        return hold(result, "invalid-duration");
    }
    frames.sort_by(|left, right| left.start.total_cmp(&right.start));
    if let Some(reason) = invalid_coverage(&frames, duration) {
        return hold(result, reason);
    }
    if result
        .refined_words
        .iter()
        .any(|word| !word.start.is_finite() || !word.end.is_finite() || word.end <= word.start)
    {
        return hold(result, "invalid-word-timings");
    }
    let words = merge_ranges(
        result
            .refined_words
            .iter()
            .filter_map(|word| {
                let start = word.start.clamp(0.0, duration);
                let end = word.end.clamp(0.0, duration);
                (end > start).then_some(AudioAnalysisRange { start, end })
            })
            .collect(),
        0.0,
    );
    result.diagnostics.transcript_words_protected = result
        .refined_words
        .iter()
        .filter(|word| word.start < duration && word.end > 0.0)
        .count();
    let average_rms = frames
        .iter()
        .map(|frame| frame.rms * (frame.end.min(duration) - frame.start))
        .sum::<f64>()
        / duration;
    let noise_floor = weighted_quantile(&frames, 0.1, |frame| frame.rms);
    let upper_energy = weighted_quantile(&frames, 0.95, |frame| frame.rms);
    result.diagnostics.average_rms = average_rms;
    result.diagnostics.noise_floor = noise_floor;
    if upper_energy <= 0.0 || !average_rms.is_finite() {
        return hold(result, "no-speech-evidence");
    }
    // The mean is a ceiling, never a raised gate that can erase softer speech.
    // Only the stable bottom of a well-separated distribution may be removed.
    let silence_threshold = (noise_floor * 1.2)
        .min(average_rms * 0.12)
        .min(upper_energy * 0.04);
    result.diagnostics.silence_threshold = silence_threshold;
    if noise_floor >= upper_energy * 0.04 || (noise_floor > 0.0 && silence_threshold < noise_floor)
    {
        return hold(result, "insufficient-noise-separation");
    }
    let quiet_frames = frames
        .iter()
        .copied()
        .filter(|frame| frame.rms <= silence_threshold)
        .collect::<Vec<_>>();
    if quiet_frames.is_empty() {
        return hold(result, "no-confident-silence");
    }
    let noise_peak = weighted_quantile(&quiet_frames, 0.5, |frame| frame.peak);
    let noise_zcr = weighted_quantile(&quiet_frames, 0.5, |frame| frame.zero_crossing_rate);
    let noise_zcr_spread = weighted_quantile(&quiet_frames, 0.9, |frame| frame.zero_crossing_rate)
        - weighted_quantile(&quiet_frames, 0.1, |frame| frame.zero_crossing_rate);
    // Ten-millisecond noise frames naturally vary in zero-crossing rate. Learn
    // that variability, but cap it so a mixed noise/whisper pool cannot widen
    // the keep gate arbitrarily.
    let zcr_tolerance = (noise_zcr_spread * 1.5).clamp(0.08, 0.14);
    let peak_limit = noise_peak * 1.5;
    let mut active = frames
        .iter()
        .map(|frame| {
            // Unsmoothened peaks preserve very short consonants and syllables.
            frame.rms > silence_threshold
                || frame.peak > peak_limit
                || (frame.zero_crossing_rate - noise_zcr).abs() > zcr_tolerance
        })
        .collect::<Vec<_>>();
    // A quiet phrase may sit near the noise floor, but its envelope can still
    // change. Retain the entire ambiguous quiet run, including all its tails.
    protect_variable_quiet_runs(
        &frames,
        &mut active,
        (noise_zcr_spread * 1.5).clamp(0.06, 0.14),
    );

    let settings = sanitize_settings(settings);
    let mut regions = activity_regions(&frames, &active);
    regions.extend(words);
    let regions = merge_ranges(regions, settings.bridge_gap_seconds);
    if regions.is_empty() {
        return hold(result, "no-speech-evidence");
    }
    let edge_padding = regions
        .iter()
        .map(|region| {
            (
                quiet_edge_padding(
                    &frames,
                    region.start,
                    region.end.min(region.start + 0.2),
                    average_rms,
                    settings.speech_padding_seconds,
                ),
                quiet_edge_padding(
                    &frames,
                    region.start.max(region.end - 0.2),
                    region.end,
                    average_rms,
                    settings.speech_padding_seconds,
                ),
            )
        })
        .collect::<Vec<_>>();
    let padded_regions = merge_ranges(
        regions
            .iter()
            .zip(&edge_padding)
            .map(|(range, (before, after))| AudioAnalysisRange {
                start: (range.start - before).max(0.0),
                end: (range.end + after).min(duration),
            })
            .collect(),
        0.0,
    );
    // Qualify the original pause before retaining protection at both edges.
    // A 300 ms pause with 120 ms on each edge can still remove its middle 60 ms.
    for index in 0..=regions.len() {
        let gap_start = if index == 0 {
            0.0
        } else {
            regions[index - 1].end
        };
        let gap_end = if index == regions.len() {
            duration
        } else {
            regions[index].start
        };
        if gap_end - gap_start + TIME_EPSILON < settings.min_silence_seconds {
            continue;
        }
        let start = gap_start
            + if index == 0 {
                0.0
            } else {
                edge_padding[index - 1].1
            };
        let end = gap_end
            - if index == regions.len() {
                0.0
            } else {
                edge_padding[index].0
            };
        if end > start + TIME_EPSILON {
            result.cut_ranges.push(AudioAnalysisRange { start, end });
        }
    }
    result.diagnostics.cut_range_count = result.cut_ranges.len();
    result.diagnostics.speech_region_count = padded_regions.len();
    result.speech_regions = padded_regions;
    result
}

fn default_min_silence_seconds() -> f64 {
    0.3
}
fn default_padding_seconds() -> f64 {
    0.12
}
fn default_bridge_gap_seconds() -> f64 {
    0.18
}

fn sanitize_settings(settings: SmartAudioSilenceSettings) -> SmartAudioSilenceSettings {
    fn bounded(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
        if value.is_finite() && value > 0.0 {
            value.clamp(min, max)
        } else {
            fallback
        }
    }
    SmartAudioSilenceSettings {
        min_silence_seconds: bounded(settings.min_silence_seconds, 0.3, 0.01, 60.0),
        // The smart route always keeps a safety margin, even for malformed input.
        speech_padding_seconds: bounded(settings.speech_padding_seconds, 0.12, 0.08, 1.0),
        bridge_gap_seconds: bounded(settings.bridge_gap_seconds, 0.18, 0.06, 1.0),
    }
}

fn invalid_coverage(frames: &[AudioAnalysisFrame], duration: f64) -> Option<&'static str> {
    if frames.is_empty() {
        return Some("missing-audio-frames");
    }
    let mut cursor = 0.0;
    for frame in frames {
        if !frame.start.is_finite()
            || !frame.end.is_finite()
            || frame.start < 0.0
            || frame.end <= frame.start
            || !frame.rms.is_finite()
            || !frame.peak.is_finite()
            || !frame.zero_crossing_rate.is_finite()
            || frame.rms < 0.0
            || frame.peak < frame.rms * 0.999_9
            || !(0.0..=1.0).contains(&frame.zero_crossing_rate)
        {
            return Some("invalid-audio-features");
        }
        if frame.end - frame.start > MAX_FRAME_SECONDS + TIME_EPSILON {
            return Some("coarse-audio-frames");
        }
        // Feature buffers are contiguous by construction. Do not manufacture
        // silence from dropped frames, truncated decoding, or overlaps.
        if (frame.start - cursor).abs() > TIME_EPSILON {
            return Some("incomplete-audio-coverage");
        }
        cursor = frame.end;
    }
    // Extraction rounds the last sample upward, so a tiny overhang is valid.
    if cursor + TIME_EPSILON < duration || cursor > duration + 0.002 {
        return Some("incomplete-audio-coverage");
    }
    None
}

fn weighted_quantile(
    frames: &[AudioAnalysisFrame],
    quantile: f64,
    value: impl Fn(&AudioAnalysisFrame) -> f64,
) -> f64 {
    let mut distribution = frames
        .iter()
        .map(|frame| (value(frame), frame.end - frame.start))
        .collect::<Vec<_>>();
    distribution.sort_by(|left, right| left.0.total_cmp(&right.0));
    let target = distribution.iter().map(|item| item.1).sum::<f64>() * quantile;
    let mut elapsed = 0.0;
    for (value, weight) in &distribution {
        elapsed += weight;
        if elapsed >= target {
            return *value;
        }
    }
    distribution.last().map_or(0.0, |item| item.0)
}

fn protect_variable_quiet_runs(
    frames: &[AudioAnalysisFrame],
    active: &mut [bool],
    max_zcr_spread: f64,
) {
    let mut start = 0;
    while start < frames.len() {
        if active[start] {
            start += 1;
            continue;
        }
        let end = (start..frames.len())
            .find(|index| active[*index])
            .unwrap_or(frames.len());
        let run = &frames[start..end];
        let lower = weighted_quantile(run, 0.1, |frame| frame.rms);
        let upper = weighted_quantile(run, 0.9, |frame| frame.rms);
        let lower_zcr = weighted_quantile(run, 0.1, |frame| frame.zero_crossing_rate);
        let upper_zcr = weighted_quantile(run, 0.9, |frame| frame.zero_crossing_rate);
        if upper > lower * 1.15 || upper_zcr - lower_zcr > max_zcr_spread {
            active[start..end].fill(true);
        }
        start = end;
    }
}

fn activity_regions(frames: &[AudioAnalysisFrame], active: &[bool]) -> Vec<AudioAnalysisRange> {
    merge_ranges(
        frames
            .iter()
            .zip(active)
            .filter(|(_, active)| **active)
            .map(|(frame, _)| AudioAnalysisRange {
                start: frame.start,
                end: frame.end,
            })
            .collect(),
        0.0,
    )
}

fn merge_ranges(mut ranges: Vec<AudioAnalysisRange>, bridge: f64) -> Vec<AudioAnalysisRange> {
    ranges.sort_by(|left, right| left.start.total_cmp(&right.start));
    let mut merged = Vec::<AudioAnalysisRange>::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut()
            && range.start <= previous.end + bridge + TIME_EPSILON
        {
            previous.end = previous.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn quiet_edge_padding(
    frames: &[AudioAnalysisFrame],
    start: f64,
    end: f64,
    average_rms: f64,
    base_padding: f64,
) -> f64 {
    let first = frames.partition_point(|frame| frame.end <= start + TIME_EPSILON);
    let local_peak_rms = frames[first..]
        .iter()
        .take_while(|frame| frame.start < end - TIME_EPSILON)
        .map(|frame| frame.rms)
        .fold(0.0, f64::max);
    // Noise can hide the onset or decay of a very quiet phrase. Give those
    // edges more breathing room; normal speech retains the requested padding.
    if local_peak_rms < average_rms * 0.18 {
        base_padding.max(0.25)
    } else {
        base_padding
    }
}

fn hold(
    mut result: SmartAudioSilenceAnalysisResult,
    reason: &str,
) -> SmartAudioSilenceAnalysisResult {
    result.diagnostics.safety_hold_reason = Some(reason.to_owned());
    if result.diagnostics.analyzed_duration_seconds > 0.0 {
        result.speech_regions = vec![AudioAnalysisRange {
            start: 0.0,
            end: result.diagnostics.analyzed_duration_seconds,
        }];
        result.diagnostics.speech_region_count = 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_SECONDS: f64 = 0.01;

    fn frames(energies: &[f64]) -> Vec<AudioAnalysisFrame> {
        energies
            .iter()
            .enumerate()
            .map(|(index, rms)| AudioAnalysisFrame {
                start: index as f64 * FRAME_SECONDS,
                end: (index + 1) as f64 * FRAME_SECONDS,
                rms: *rms,
                peak: rms * 2.0,
                zero_crossing_rate: 0.1,
            })
            .collect()
    }

    fn analyze(energies: &[f64]) -> SmartAudioSilenceAnalysisResult {
        analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
            frames: frames(energies),
            duration_seconds: energies.len() as f64 * FRAME_SECONDS,
            transcript_words: vec![],
            settings: SmartAudioSilenceSettings::default(),
        })
    }

    fn assert_preserved(result: &SmartAudioSilenceAnalysisResult, start: f64, end: f64) {
        assert!(
            result
                .cut_ranges
                .iter()
                .all(|cut| cut.end <= start + TIME_EPSILON || cut.start >= end - TIME_EPSILON),
            "cuts {:?} overlap protected interval {start}..{end}",
            result.cut_ranges
        );
    }

    #[test]
    fn default_300ms_pause_qualifies_before_padding() {
        let mut energies = vec![0.05; 130];
        energies[50..80].fill(0.001);
        let result = analyze(&energies);
        assert_eq!(result.cut_ranges.len(), 1);
        assert!((result.cut_ranges[0].start - 0.62).abs() < TIME_EPSILON);
        assert!((result.cut_ranges[0].end - 0.68).abs() < TIME_EPSILON);
        assert!((result.diagnostics.average_rms - (0.05 + 0.0003) / 1.3).abs() < TIME_EPSILON);
    }

    #[test]
    fn configurable_duration_keeps_shorter_pauses() {
        let mut energies = vec![0.05; 130];
        energies[50..80].fill(0.001);
        let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
            frames: frames(&energies),
            duration_seconds: 1.3,
            transcript_words: vec![],
            settings: SmartAudioSilenceSettings {
                min_silence_seconds: 0.4,
                ..SmartAudioSilenceSettings::default()
            },
        });
        assert!(result.cut_ranges.is_empty());
    }

    #[test]
    fn retains_whispered_words_and_long_tails_next_to_loud_speech() {
        let mut energies = vec![0.0001; 300];
        energies[0..50].fill(0.1);
        energies[50..90].fill(0.0006);
        energies[145..185].fill(0.0004);
        energies[240..300].fill(0.08);
        let result = analyze(&energies);
        assert_eq!(result.cut_ranges.len(), 2);
        assert_preserved(&result, 0.0, 0.9);
        assert_preserved(&result, 1.45, 1.85);
        assert_preserved(&result, 2.4, 3.0);
        assert!(result.cut_ranges[0].start >= 1.02 - TIME_EPSILON);
        assert!(result.cut_ranges[0].end <= 1.33 + TIME_EPSILON);
    }

    #[test]
    fn uniform_gain_changes_never_erase_a_quiet_phrase() {
        let mut energies = vec![0.001; 300];
        energies[0..50].fill(0.1);
        energies[140..180].fill(0.004);
        energies[240..300].fill(0.1);
        let original = analyze(&energies);
        for gain in [0.000_001, 0.001, 10.0] {
            let scaled = energies
                .iter()
                .map(|energy| energy * gain)
                .collect::<Vec<_>>();
            let result = analyze(&scaled);
            assert_eq!(result.cut_ranges, original.cut_ranges);
            assert_preserved(&result, 1.4, 1.8);
        }
        assert!(!original.cut_ranges.is_empty());
    }

    #[test]
    fn full_words_are_hard_keep_zones_even_at_exact_noise_energy() {
        let mut energies = vec![0.001; 400];
        energies[0..50].fill(0.05);
        energies[350..400].fill(0.05);
        let words = vec![TranscriptWordTiming {
            word_index: 4,
            start: 1.5,
            end: 2.5,
        }];
        let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
            frames: frames(&energies),
            duration_seconds: 4.0,
            transcript_words: words.clone(),
            settings: SmartAudioSilenceSettings::default(),
        });
        assert_eq!(result.cut_ranges.len(), 2);
        assert_preserved(&result, 1.38, 2.62);
        assert_eq!(result.refined_words, words);
        assert_eq!(result.diagnostics.transcript_words_protected, 1);
    }

    #[test]
    fn protects_quiet_phrases_with_different_zero_crossings_and_consonant_peaks() {
        let mut energies = vec![0.001; 300];
        energies[0..50].fill(0.05);
        energies[250..300].fill(0.05);
        let mut audio = frames(&energies);
        for frame in &mut audio[120..140] {
            frame.zero_crossing_rate = 0.3;
        }
        audio[160].peak = 0.01;
        let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
            frames: audio,
            duration_seconds: 3.0,
            transcript_words: vec![],
            settings: SmartAudioSilenceSettings::default(),
        });
        assert_preserved(&result, 1.2, 1.4);
        assert_preserved(&result, 1.6, 1.61);
        assert!(!result.cut_ranges.is_empty());
    }

    #[test]
    fn retains_a_near_noise_phrase_with_an_ambiguous_envelope() {
        let mut energies = vec![0.001; 300];
        energies[0..50].fill(0.05);
        energies[130..170].fill(0.00119);
        energies[250..300].fill(0.05);
        let result = analyze(&energies);
        assert!(result.cut_ranges.is_empty());
    }

    #[test]
    fn bridges_word_internal_dropouts_without_pruning_short_syllables() {
        let mut energies = vec![0.05; 300];
        energies[50..200].fill(0.001);
        energies[90..92].fill(0.004);
        energies[105..108].fill(0.003);
        let result = analyze(&energies);
        assert_preserved(&result, 0.9, 1.08);
        assert!(
            result
                .cut_ranges
                .iter()
                .any(|cut| cut.start >= 1.2 - TIME_EPSILON)
        );
    }

    #[test]
    fn no_speech_or_no_separation_holds_the_entire_recording() {
        for energies in [vec![0.0; 200], vec![0.05; 200], vec![0.02; 200]] {
            let result = analyze(&energies);
            assert!(result.cut_ranges.is_empty());
            assert!(result.diagnostics.safety_hold_reason.is_some());
        }
        let mut noisy = vec![0.02; 300];
        noisy[50..100].fill(0.06);
        noisy[200..250].fill(0.05);
        let result = analyze(&noisy);
        assert!(result.cut_ranges.is_empty());
        assert_eq!(
            result.diagnostics.safety_hold_reason.as_deref(),
            Some("insufficient-noise-separation")
        );
    }

    #[test]
    fn all_speech_with_a_whispered_phrase_does_not_manufacture_silence() {
        let mut energies = vec![0.06; 250];
        energies[50..100].fill(0.004);
        energies[100..150].fill(0.005);
        let result = analyze(&energies);
        assert!(result.cut_ranges.is_empty());
    }

    #[test]
    fn digital_silence_keeps_arbitrarily_soft_nonzero_tails() {
        let mut energies = vec![0.0; 300];
        energies[0..50].fill(0.05);
        energies[50..100].fill(0.000_000_001);
        energies[250..300].fill(0.05);
        let result = analyze(&energies);
        assert_eq!(result.cut_ranges.len(), 1);
        assert_preserved(&result, 0.0, 1.0);
        assert!(result.cut_ranges[0].start >= 1.12 - TIME_EPSILON);
    }

    #[test]
    fn invalid_missing_overlapping_and_coarse_frames_never_become_silence() {
        let mut energies = vec![0.05; 300];
        energies[50..200].fill(0.001);
        let valid = frames(&energies);
        let mut missing = valid.clone();
        missing.remove(100);
        let mut invalid = valid.clone();
        invalid[100].rms = f64::NAN;
        let mut overlapping = valid.clone();
        overlapping[100].start -= 0.005;
        let mut coarse = valid.clone();
        coarse[100].end += 0.1;
        for input in [missing, invalid, overlapping, coarse, valid[..290].to_vec()] {
            let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
                frames: input,
                duration_seconds: 3.0,
                transcript_words: vec![],
                settings: SmartAudioSilenceSettings::default(),
            });
            assert!(result.cut_ranges.is_empty());
            assert!(result.diagnostics.safety_hold_reason.is_some());
        }
    }

    #[test]
    fn malformed_word_timing_cannot_silently_drop_word_protection() {
        let mut energies = vec![0.001; 300];
        energies[0..50].fill(0.05);
        energies[250..300].fill(0.05);
        let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
            frames: frames(&energies),
            duration_seconds: 3.0,
            transcript_words: vec![TranscriptWordTiming {
                word_index: 0,
                start: 1.5,
                end: f64::NAN,
            }],
            settings: SmartAudioSilenceSettings::default(),
        });
        assert!(result.cut_ranges.is_empty());
        assert_eq!(
            result.diagnostics.safety_hold_reason.as_deref(),
            Some("invalid-word-timings")
        );
    }

    fn recorded_samples() -> (Vec<f64>, f64) {
        // Existing tracked mono PCM fixture, also used by browser transcription.
        let bytes = include_bytes!("../../../../apps/web/public/transcription-check.wav");
        assert_eq!(&bytes[..4], b"RIFF");
        let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as f64;
        assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
        let mut offset = 12;
        while offset + 8 < bytes.len() {
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &bytes[offset..offset + 4] == b"data" {
                let samples = bytes[offset + 8..offset + 8 + length]
                    .chunks_exact(2)
                    .map(|sample| i16::from_le_bytes(sample.try_into().unwrap()) as f64 / 32768.0)
                    .collect();
                return (samples, sample_rate);
            }
            offset += 8 + length + length % 2;
        }
        panic!("recording fixture has no PCM data");
    }

    fn sample_frames(samples: &[f64], sample_rate: f64) -> Vec<AudioAnalysisFrame> {
        let frame_size = (sample_rate * FRAME_SECONDS).round() as usize;
        samples
            .chunks(frame_size)
            .enumerate()
            .map(|(index, samples)| AudioAnalysisFrame {
                start: (index * frame_size) as f64 / sample_rate,
                end: (index * frame_size + samples.len()) as f64 / sample_rate,
                rms: (samples.iter().map(|sample| sample * sample).sum::<f64>()
                    / samples.len() as f64)
                    .sqrt(),
                peak: samples
                    .iter()
                    .map(|sample| sample.abs())
                    .fold(0.0, f64::max),
                zero_crossing_rate: samples
                    .windows(2)
                    .filter(|pair| (pair[0] < 0.0) != (pair[1] < 0.0))
                    .count() as f64
                    / samples.len().saturating_sub(1).max(1) as f64,
            })
            .collect()
    }

    #[test]
    fn real_recording_keeps_every_nonzero_sample_with_quiet_phrases_and_noise() {
        let (original, sample_rate) = recorded_samples();
        let mut clean_cuts = Vec::new();
        for variant in 0..4 {
            let mut random = 12_u64;
            let samples = original
                .iter()
                .enumerate()
                .map(|(index, sample)| {
                    let timestamp = index as f64 / sample_rate;
                    let gain = if variant == 1 {
                        0.000_001
                    } else if variant >= 2 && (2.0..=4.6).contains(&timestamp) {
                        0.003
                    } else {
                        1.0
                    };
                    random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let noise = if variant == 3 {
                        ((random >> 32) as f64 / u32::MAX as f64 * 2.0 - 1.0) * 0.0001
                    } else {
                        0.0
                    };
                    sample * gain + noise
                })
                .collect::<Vec<_>>();
            let result = analyze_smart_audio_silence(AnalyzeSmartAudioSilenceOptions {
                frames: sample_frames(&samples, sample_rate),
                duration_seconds: original.len() as f64 / sample_rate,
                transcript_words: vec![],
                settings: SmartAudioSilenceSettings::default(),
            });
            for cut in &result.cut_ranges {
                let start = (cut.start * sample_rate).ceil() as usize;
                let end = (cut.end * sample_rate).floor() as usize;
                assert!(
                    original[start..end].iter().all(|sample| *sample == 0.0),
                    "variant {variant} removes recording content at {cut:?}"
                );
            }
            if variant == 0 {
                assert_eq!(result.cut_ranges.len(), 3);
                clean_cuts = result.cut_ranges;
            } else if variant == 1 {
                assert_eq!(result.cut_ranges, clean_cuts);
            }
        }
    }
}
