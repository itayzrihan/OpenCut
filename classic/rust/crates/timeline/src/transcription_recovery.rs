//! Bounded acoustic coverage audit. A retry is evidence gathering, never deletion.
use crate::{AudioAnalysisFrame, AudioAnalysisRange, TranscriptWordTiming};
use bridge::export;
use serde::{Deserialize, Serialize};
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRecoveryOptions {
    pub frames: Vec<AudioAnalysisFrame>,
    pub words: Vec<TranscriptWordTiming>,
    pub duration: f64,
}
#[export]
pub fn transcript_recovery_windows(options: TranscriptRecoveryOptions) -> Vec<AudioAnalysisRange> {
    let mut words = options.words;
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    let max_rms = options
        .frames
        .iter()
        .filter(|f| f.rms.is_finite())
        .map(|f| f.rms)
        .fold(0.0, f64::max);
    if max_rms <= 0.00001 || !options.duration.is_finite() {
        return vec![];
    }
    let mut cursor: f64 = 0.0;
    let mut windows = vec![];
    for word in words.iter().chain(std::iter::once(&TranscriptWordTiming {
        word_index: 0,
        start: options.duration,
        end: options.duration,
    })) {
        let end = word.start.min(options.duration);
        if end - cursor >= 1.2 {
            // A repeated performance may have been omitted by ASR. Recheck only
            // uncovered audio with sustained activity, using a bounded context.
            let activity: f64 = options
                .frames
                .iter()
                .filter(|f| f.rms > max_rms * 0.04)
                .map(|f| (f.end.min(end - 0.1) - f.start.max(cursor + 0.1)).max(0.0))
                .sum();
            if activity >= 0.35 {
                let mut from = cursor;
                while from < end && windows.len() < 8 {
                    let to = (from + 20.0).min(end);
                    windows.push(AudioAnalysisRange {
                        start: from,
                        end: to,
                    });
                    from = to;
                }
            }
        }
        cursor = cursor.max(word.end);
    }
    windows
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RecoveryWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct MergeRecoveryOptions {
    pub words: Vec<RecoveryWord>,
    pub recovered: Vec<RecoveryWord>,
    pub start: f64,
    pub end: f64,
}
#[export]
pub fn merge_recovered_transcript(mut input: MergeRecoveryOptions) -> Vec<RecoveryWord> {
    for mut w in input.recovered {
        w.start += input.start;
        w.end += input.start;
        if !w.start.is_finite()
            || !w.end.is_finite()
            || w.end <= w.start
            || w.text.trim().is_empty()
        {
            continue;
        }
        if w.start < input.start || w.end > input.end + 0.001 {
            continue;
        }
        if input
            .words
            .iter()
            .any(|old| w.start < old.end && w.end > old.start)
        {
            continue;
        }
        // Identity is temporal. Identical words recorded later are real takes.
        input.words.push(w);
    }
    input.words.sort_by(|a, b| a.start.total_cmp(&b.start));
    input.words
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_repeated_hook_is_retried_but_quiet_gap_is_not() {
        let frames = (0..2400)
            .map(|i| {
                let start = i as f64 / 100.0;
                let active = (2.0..6.0).contains(&start)
                    || (9.0..14.0).contains(&start)
                    || (21.0..23.0).contains(&start);
                AudioAnalysisFrame {
                    start,
                    end: start + 0.01,
                    rms: if active { 0.1 } else { 0.0001 },
                    peak: 0.1,
                    zero_crossing_rate: 0.1,
                }
            })
            .collect();
        let windows = transcript_recovery_windows(TranscriptRecoveryOptions {
            frames,
            words: vec![
                TranscriptWordTiming {
                    word_index: 0,
                    start: 2.0,
                    end: 6.0,
                },
                TranscriptWordTiming {
                    word_index: 1,
                    start: 21.0,
                    end: 23.0,
                },
            ],
            duration: 24.0,
        });
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].start, 6.0);
        assert_eq!(windows[0].end, 21.0);
        let words = merge_recovered_transcript(MergeRecoveryOptions {
            words: vec![RecoveryWord {
                text: "same hook".into(),
                start: 2.0,
                end: 6.0,
            }],
            recovered: vec![RecoveryWord {
                text: "same hook".into(),
                start: 3.0,
                end: 8.0,
            }],
            start: 6.0,
            end: 21.0,
        });
        assert_eq!(words.len(), 2);
        assert_eq!(words[1].start, 9.0);
    }
}
