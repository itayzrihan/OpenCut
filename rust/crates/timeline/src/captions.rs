use std::collections::HashSet;

use bridge::export;
use serde::{Deserialize, Serialize};
use time::{MediaTime, TICKS_PER_SECOND};

const MIN_WORD_DURATION_TICKS: i64 = TICKS_PER_SECOND / 100;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionWordSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub track_id: String,
    pub element_id: String,
    pub word_index: usize,
    #[serde(default)]
    pub word_id: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub source: Option<CaptionWordSource>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayerWordInput {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub line_index: usize,
    #[serde(default)]
    pub start_time: Option<MediaTime>,
    #[serde(default)]
    pub end_time: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayerWordsInput {
    pub track_id: String,
    pub element_id: String,
    pub start_time: MediaTime,
    pub duration: MediaTime,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub word_runs: Vec<TextLayerWordInput>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeTextLayerWordIdsOptions {
    pub word_runs: Vec<TextLayerWordInput>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTextLayerWordId {
    pub previous_word_index: usize,
    pub id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayerDurationForWordsOptions {
    pub duration: MediaTime,
    pub word_runs: Vec<TextLayerWordInput>,
}

/// Ensures a text layer covers every explicitly timed word. Word insertion can
/// append a run at the old layer boundary, so the owner must grow with it.
#[export]
pub fn text_layer_duration_for_words(
    TextLayerDurationForWordsOptions {
        duration,
        word_runs,
    }: TextLayerDurationForWordsOptions,
) -> MediaTime {
    word_runs
        .into_iter()
        .filter_map(|word| match (word.start_time, word.end_time) {
            (Some(start), Some(end)) => Some(end.max(start)),
            _ => None,
        })
        .max()
        .unwrap_or(MediaTime::ZERO)
        .max(duration)
        .max(MediaTime::ZERO)
}

/// Gives every word run inside one text layer a stable, unique ID. This repairs
/// merged and legacy layers where several runs may all be named `word-0`.
#[export]
pub fn normalize_text_layer_word_ids(
    NormalizeTextLayerWordIdsOptions { word_runs }: NormalizeTextLayerWordIdsOptions,
) -> Vec<NormalizedTextLayerWordId> {
    let mut used_ids = HashSet::new();
    word_runs
        .into_iter()
        .enumerate()
        .map(|(previous_word_index, word)| {
            let id = if !word.id.trim().is_empty() && used_ids.insert(word.id.clone()) {
                word.id
            } else {
                unique_word_id(previous_word_index, &mut used_ids)
            };
            NormalizedTextLayerWordId {
                previous_word_index,
                id,
            }
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileTextContentWordsOptions {
    pub content: String,
    pub duration: MediaTime,
    pub previous_words: Vec<TextLayerWordInput>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledTextContentWord {
    pub id: String,
    pub text: String,
    pub line_index: usize,
    pub previous_word_index: Option<usize>,
    pub start_time: Option<MediaTime>,
    pub end_time: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitTextLayerWordsToSpanOptions {
    pub previous_start_time: MediaTime,
    pub next_start_time: MediaTime,
    pub next_duration: MediaTime,
    pub word_runs: Vec<TextLayerWordInput>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FittedTextLayerWord {
    pub previous_word_index: usize,
    pub line_index: usize,
    pub start_time: Option<MediaTime>,
    pub end_time: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCaptionWordsOptions {
    pub words: Vec<CaptionWord>,
    pub text_layers: Vec<TextLayerWordsInput>,
}

/// Rebuilds every text-layer-owned word from the layers that actually exist.
/// Generated transcript words are preserved, while stale ownership records,
/// duplicate entries, and words outside their owner layer are removed.
#[export]
pub fn reconcile_caption_words(
    ReconcileCaptionWordsOptions { words, text_layers }: ReconcileCaptionWordsOptions,
) -> Vec<CaptionWord> {
    let mut reconciled = words
        .into_iter()
        .filter(|word| {
            word.source
                .as_ref()
                .is_none_or(|source| source.source_type != "text-layer")
        })
        .collect::<Vec<_>>();
    let mut seen_layers = HashSet::new();

    for layer in text_layers {
        let layer_key = (layer.track_id.clone(), layer.element_id.clone());
        if !seen_layers.insert(layer_key) {
            continue;
        }
        reconciled.extend(build_text_layer_caption_words(layer));
    }

    sort_caption_words(&mut reconciled);
    reconciled
}

/// Keeps word identity and timing attached to the same text when layer content
/// is edited. Exact words are matched with an LCS; unmatched words inside each
/// edit gap are paired positionally so ordinary replacements keep their style.
#[export]
pub fn reconcile_text_content_words(
    ReconcileTextContentWordsOptions {
        content,
        duration,
        previous_words,
    }: ReconcileTextContentWordsOptions,
) -> Vec<ReconciledTextContentWord> {
    let content_words = content_words_with_lines(&content);
    if content_words.is_empty() {
        return Vec::new();
    }

    let exact_matches = longest_common_subsequence_matches(&previous_words, &content_words);
    let mut previous_indexes = vec![None; content_words.len()];
    let mut previous_anchor = 0;
    let mut content_anchor = 0;

    for &(previous_index, content_index) in exact_matches.iter().chain(std::iter::once(&(
        previous_words.len(),
        content_words.len(),
    ))) {
        let previous_gap = previous_index.saturating_sub(previous_anchor);
        let content_gap = content_index.saturating_sub(content_anchor);
        for gap_index in 0..previous_gap.min(content_gap) {
            previous_indexes[content_anchor + gap_index] = Some(previous_anchor + gap_index);
        }

        if previous_index < previous_words.len() && content_index < content_words.len() {
            previous_indexes[content_index] = Some(previous_index);
            previous_anchor = previous_index + 1;
            content_anchor = content_index + 1;
        }
    }

    let is_timed = previous_words
        .iter()
        .any(|word| word.start_time.is_some() && word.end_time.is_some());
    let mut used_ids = HashSet::new();
    let duration = duration.max(MediaTime::ZERO);

    content_words
        .into_iter()
        .enumerate()
        .map(|(content_index, (text, line_index))| {
            let previous_word_index = previous_indexes[content_index];
            let previous = previous_word_index.and_then(|index| previous_words.get(index));
            let id = previous
                .map(|word| word.id.clone())
                .filter(|id| !id.trim().is_empty() && used_ids.insert(id.clone()))
                .unwrap_or_else(|| unique_word_id(content_index, &mut used_ids));
            let fallback_start = proportional_time(duration, content_index, previous_indexes.len());
            let fallback_end =
                proportional_time(duration, content_index + 1, previous_indexes.len());

            ReconciledTextContentWord {
                id,
                text,
                line_index,
                previous_word_index,
                start_time: previous
                    .and_then(|word| word.start_time)
                    .or(is_timed.then_some(fallback_start)),
                end_time: previous
                    .and_then(|word| word.end_time)
                    .or(is_timed.then_some(fallback_end)),
            }
        })
        .collect()
}

/// Clips timed runs to a trimmed text-layer span and rebases them to the new
/// layer start. Presentation-only runs stay untimed and remain in the layer.
#[export]
pub fn fit_text_layer_words_to_span(
    FitTextLayerWordsToSpanOptions {
        previous_start_time,
        next_start_time,
        next_duration,
        word_runs,
    }: FitTextLayerWordsToSpanOptions,
) -> Vec<FittedTextLayerWord> {
    let next_duration = next_duration.max(MediaTime::ZERO);
    let next_end_time = next_start_time + next_duration;
    let mut line_indexes = Vec::new();

    word_runs
        .into_iter()
        .enumerate()
        .filter_map(|(previous_word_index, word)| {
            let (start_time, end_time) = match (word.start_time, word.end_time) {
                (Some(start_time), Some(end_time)) => {
                    let absolute_start = previous_start_time + start_time;
                    let absolute_end = previous_start_time + end_time.max(start_time);
                    if absolute_end <= next_start_time || absolute_start >= next_end_time {
                        return None;
                    }
                    let clipped_start = absolute_start.max(next_start_time);
                    let clipped_end = absolute_end.min(next_end_time);
                    if clipped_end <= clipped_start {
                        return None;
                    }
                    (
                        Some(clipped_start - next_start_time),
                        Some(clipped_end - next_start_time),
                    )
                }
                _ => (None, None),
            };
            let line_index = normalized_line_index(word.line_index, &mut line_indexes);
            Some(FittedTextLayerWord {
                previous_word_index,
                line_index,
                start_time,
                end_time,
            })
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCaptionWordTimeRangesOptions {
    pub words: Vec<CaptionWord>,
    pub ranges: Vec<CaptionTimeRange>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTimeRange {
    pub start: f64,
    pub end: f64,
}

/// Applies ripple time removals to transcript words. Fully removed words are
/// dropped, partial words are clipped, and later words move to the cut point.
#[export]
pub fn remove_caption_word_time_ranges(
    RemoveCaptionWordTimeRangesOptions { words, mut ranges }: RemoveCaptionWordTimeRangesOptions,
) -> Vec<CaptionWord> {
    ranges.retain(|range| {
        range.start.is_finite() && range.end.is_finite() && range.end > range.start
    });
    ranges.sort_by(|left, right| {
        right
            .start
            .total_cmp(&left.start)
            .then_with(|| right.end.total_cmp(&left.end))
    });

    let mut next_words = words;
    for range in ranges {
        next_words = next_words
            .into_iter()
            .filter_map(|mut word| {
                let (start, end) =
                    remove_time_range_from_span(word.start, word.end.max(word.start), range)?;
                word.start = round_seconds(start.max(0.0));
                word.end = round_seconds(end.max(word.start + 0.001));
                Some(word)
            })
            .collect();
    }
    sort_caption_words(&mut next_words);
    next_words
}

/// Applies finalized timeline cuts to transcript words and removes residual
/// Whisper timing overlap. Later word starts are treated as the stronger
/// speech anchor; an earlier word end is clipped to that start whenever it can
/// retain a positive duration. Words with identical starts are split across
/// their shared span so caption cues never render simultaneously by accident.
#[export]
pub fn realign_caption_words_after_time_removal(
    options: RemoveCaptionWordTimeRangesOptions,
) -> Vec<CaptionWord> {
    let mut words = remove_caption_word_time_ranges(options);
    remove_adjacent_caption_word_overlaps(&mut words);
    words
}

fn remove_adjacent_caption_word_overlaps(words: &mut [CaptionWord]) {
    const MIN_DURATION_SECONDS: f64 = 0.001;

    for current_index in 1..words.len() {
        let (previous_words, current_words) = words.split_at_mut(current_index);
        let previous = &mut previous_words[current_index - 1];
        let current = &mut current_words[0];
        if previous.end <= current.start {
            continue;
        }

        if current.start - previous.start >= MIN_DURATION_SECONDS {
            previous.end = current.start;
            continue;
        }

        // Equal or near-equal starts can be emitted around a cut boundary.
        // Serialize the two words inside their combined span instead of
        // choosing one and discarding transcript content.
        // `previous.start` may already have been moved by an earlier equal-start
        // repair, so never move it backward beneath the word before it.
        let sequence_start = previous.start;
        let mut sequence_end = previous.end.max(current.end);
        sequence_end = sequence_end.max(sequence_start + 2.0 * MIN_DURATION_SECONDS);
        let boundary = ((sequence_start + sequence_end) / 2.0).clamp(
            sequence_start + MIN_DURATION_SECONDS,
            sequence_end - MIN_DURATION_SECONDS,
        );
        previous.end = round_seconds(boundary);
        current.start = round_seconds(boundary);
        current.end = round_seconds(sequence_end.max(boundary + MIN_DURATION_SECONDS));
    }
}

fn build_text_layer_caption_words(layer: TextLayerWordsInput) -> Vec<CaptionWord> {
    let duration = layer.duration.max(MediaTime::ZERO);
    if duration <= MediaTime::ZERO {
        return Vec::new();
    }

    let runs = if layer.word_runs.is_empty() {
        words_from_content(&layer.content)
    } else {
        layer.word_runs
    };
    let word_count = runs.len();
    if word_count == 0 {
        return Vec::new();
    }

    runs.into_iter()
        .enumerate()
        .filter_map(|(word_index, run)| {
            if run.text.trim().is_empty() {
                return None;
            }
            let fallback_start = proportional_time(duration, word_index, word_count);
            let fallback_end = proportional_time(duration, word_index + 1, word_count);
            let has_explicit_timing = run.start_time.is_some() && run.end_time.is_some();
            let raw_start = run.start_time.unwrap_or(fallback_start);
            let raw_end = run.end_time.unwrap_or(fallback_end);

            if has_explicit_timing && (raw_end <= MediaTime::ZERO || raw_start >= duration) {
                return None;
            }

            let start = raw_start.clamp(MediaTime::ZERO, duration);
            let mut end = raw_end.clamp(MediaTime::ZERO, duration);
            if end <= start {
                end = (start + MediaTime::from_ticks(MIN_WORD_DURATION_TICKS)).min(duration);
            }
            if end <= start {
                return None;
            }

            let absolute_start = layer.start_time + start;
            let absolute_end = layer.start_time + end;
            Some(CaptionWord {
                text: run.text,
                start: round_seconds(absolute_start.to_seconds_f64()),
                end: round_seconds(absolute_end.to_seconds_f64()),
                source: Some(CaptionWordSource {
                    source_type: "text-layer".to_string(),
                    track_id: layer.track_id.clone(),
                    element_id: layer.element_id.clone(),
                    word_index,
                    word_id: Some(run.id),
                }),
            })
        })
        .collect()
}

fn words_from_content(content: &str) -> Vec<TextLayerWordInput> {
    content_words_with_lines(content)
        .into_iter()
        .enumerate()
        .map(|(word_index, (text, line_index))| TextLayerWordInput {
            id: format!("word-{word_index}"),
            text,
            line_index,
            start_time: None,
            end_time: None,
        })
        .collect()
}

fn content_words_with_lines(content: &str) -> Vec<(String, usize)> {
    content
        .lines()
        .enumerate()
        .flat_map(|(line_index, line)| {
            line.split_whitespace()
                .map(move |text| (text.to_string(), line_index))
        })
        .collect()
}

fn longest_common_subsequence_matches(
    previous_words: &[TextLayerWordInput],
    content_words: &[(String, usize)],
) -> Vec<(usize, usize)> {
    let mut lengths = vec![vec![0usize; content_words.len() + 1]; previous_words.len() + 1];
    for previous_index in (0..previous_words.len()).rev() {
        for content_index in (0..content_words.len()).rev() {
            lengths[previous_index][content_index] =
                if previous_words[previous_index].text == content_words[content_index].0 {
                    1 + lengths[previous_index + 1][content_index + 1]
                } else {
                    lengths[previous_index + 1][content_index]
                        .max(lengths[previous_index][content_index + 1])
                };
        }
    }

    let mut matches = Vec::new();
    let mut previous_index = 0;
    let mut content_index = 0;
    while previous_index < previous_words.len() && content_index < content_words.len() {
        if previous_words[previous_index].text == content_words[content_index].0 {
            matches.push((previous_index, content_index));
            previous_index += 1;
            content_index += 1;
        } else if lengths[previous_index + 1][content_index]
            >= lengths[previous_index][content_index + 1]
        {
            previous_index += 1;
        } else {
            content_index += 1;
        }
    }
    matches
}

fn unique_word_id(index: usize, used_ids: &mut HashSet<String>) -> String {
    let base = format!("word-{index}");
    if used_ids.insert(base.clone()) {
        return base;
    }
    let mut suffix = 1;
    loop {
        let candidate = format!("{base}-{suffix}");
        if used_ids.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}

fn normalized_line_index(line_index: usize, line_indexes: &mut Vec<usize>) -> usize {
    if let Some(index) = line_indexes
        .iter()
        .position(|candidate| *candidate == line_index)
    {
        return index;
    }
    line_indexes.push(line_index);
    line_indexes.len() - 1
}

fn proportional_time(duration: MediaTime, index: usize, count: usize) -> MediaTime {
    if count == 0 {
        return MediaTime::ZERO;
    }
    MediaTime::from_ticks(((duration.as_ticks() as i128 * index as i128) / count as i128) as i64)
}

fn remove_time_range_from_span(
    start: f64,
    end: f64,
    range: CaptionTimeRange,
) -> Option<(f64, f64)> {
    let removed_duration = range.end - range.start;
    if end <= range.start {
        return Some((start, end));
    }
    if start >= range.end {
        return Some((start - removed_duration, end - removed_duration));
    }
    if start >= range.start && end <= range.end {
        return None;
    }
    if start < range.start && end > range.end {
        return Some((start, end - removed_duration));
    }
    if start < range.start {
        return (range.start > start).then_some((start, range.start));
    }

    let shifted_end = end - removed_duration;
    (shifted_end > range.start).then_some((range.start, shifted_end))
}

fn sort_caption_words(words: &mut [CaptionWord]) {
    words.sort_by(|left, right| {
        left.start
            .total_cmp(&right.start)
            .then_with(|| left.end.total_cmp(&right.end))
    });
}

fn round_seconds(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(seconds: f64) -> MediaTime {
        MediaTime::from_seconds_f64(seconds).expect("finite test time")
    }

    fn generated_word(text: &str, start: f64, end: f64) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start,
            end,
            source: None,
        }
    }

    fn owned_word(
        text: &str,
        start: f64,
        end: f64,
        track_id: &str,
        element_id: &str,
        word_index: usize,
    ) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start,
            end,
            source: Some(CaptionWordSource {
                source_type: "text-layer".to_string(),
                track_id: track_id.to_string(),
                element_id: element_id.to_string(),
                word_index,
                word_id: Some(format!("word-{word_index}")),
            }),
        }
    }

    fn layer(
        track_id: &str,
        element_id: &str,
        start: f64,
        duration: f64,
        content: &str,
    ) -> TextLayerWordsInput {
        TextLayerWordsInput {
            track_id: track_id.to_string(),
            element_id: element_id.to_string(),
            start_time: time(start),
            duration: time(duration),
            content: content.to_string(),
            word_runs: Vec::new(),
        }
    }

    #[test]
    fn rebuilds_owned_words_and_drops_orphans_and_duplicates() {
        let result = reconcile_caption_words(ReconcileCaptionWordsOptions {
            words: vec![
                generated_word("spoken", 0.0, 1.0),
                owned_word("stale", 2.0, 3.0, "old-track", "title", 0),
                owned_word("duplicate", 2.0, 3.0, "old-track", "title", 0),
                owned_word("orphan", 5.0, 6.0, "missing", "missing", 0),
            ],
            text_layers: vec![layer("new-track", "title", 2.0, 2.0, "Fresh title")],
        });

        assert_eq!(
            result
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            vec!["spoken", "Fresh", "title"]
        );
        assert_eq!(result[1].source.as_ref().unwrap().track_id, "new-track");
        assert_eq!(result[1].start, 2.0);
        assert_eq!(result[2].end, 4.0);
    }

    #[test]
    fn repairs_duplicate_and_empty_word_run_ids() {
        let word = |id: &str, text: &str| TextLayerWordInput {
            id: id.to_string(),
            text: text.to_string(),
            line_index: 0,
            start_time: None,
            end_time: None,
        };
        let result = normalize_text_layer_word_ids(NormalizeTextLayerWordIdsOptions {
            word_runs: vec![
                word("word-0", "first"),
                word("word-0", "second"),
                word("", "third"),
            ],
        });

        assert_eq!(
            result
                .iter()
                .map(|word| word.id.as_str())
                .collect::<Vec<_>>(),
            vec!["word-0", "word-1", "word-2"]
        );
    }

    #[test]
    fn extends_a_text_layer_to_cover_an_inserted_word() {
        let result = text_layer_duration_for_words(TextLayerDurationForWordsOptions {
            duration: time(2.0),
            word_runs: vec![TextLayerWordInput {
                id: "inserted".to_string(),
                text: "inserted".to_string(),
                line_index: 0,
                start_time: Some(time(2.0)),
                end_time: Some(time(2.01)),
            }],
        });

        assert_eq!(result, time(2.01));
    }

    #[test]
    fn uses_fallback_timing_for_untimed_runs_and_clamps_partial_runs() {
        let result = reconcile_caption_words(ReconcileCaptionWordsOptions {
            words: Vec::new(),
            text_layers: vec![TextLayerWordsInput {
                word_runs: vec![
                    TextLayerWordInput {
                        id: "first".to_string(),
                        text: "first".to_string(),
                        line_index: 0,
                        start_time: None,
                        end_time: None,
                    },
                    TextLayerWordInput {
                        id: "second".to_string(),
                        text: "second".to_string(),
                        line_index: 0,
                        start_time: Some(time(1.5)),
                        end_time: Some(time(3.0)),
                    },
                    TextLayerWordInput {
                        id: "outside".to_string(),
                        text: "outside".to_string(),
                        line_index: 0,
                        start_time: Some(time(3.0)),
                        end_time: Some(time(4.0)),
                    },
                ],
                ..layer("manual", "title", 10.0, 2.0, "")
            }],
        });

        assert_eq!(result.len(), 2);
        assert_eq!((result[0].start, result[0].end), (10.0, 10.667));
        assert_eq!((result[1].start, result[1].end), (11.5, 12.0));
    }

    #[test]
    fn applies_ripple_cuts_to_words() {
        let result = remove_caption_word_time_ranges(RemoveCaptionWordTimeRangesOptions {
            words: vec![
                generated_word("before", 0.0, 1.0),
                generated_word("left", 1.5, 2.5),
                generated_word("gone", 2.1, 2.9),
                generated_word("right", 2.5, 3.5),
                generated_word("across", 1.5, 3.5),
                generated_word("after", 4.0, 5.0),
            ],
            ranges: vec![CaptionTimeRange {
                start: 2.0,
                end: 3.0,
            }],
        });

        assert_eq!(
            result
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![
                ("before", 0.0, 1.0),
                ("left", 1.5, 2.0),
                ("across", 1.5, 2.5),
                ("right", 2.0, 2.5),
                ("after", 3.0, 4.0),
            ]
        );
    }

    #[test]
    fn realigns_overlapping_whisper_words_after_a_ripple_cut() {
        let result = realign_caption_words_after_time_removal(RemoveCaptionWordTimeRangesOptions {
            words: vec![
                generated_word("first", 0.0, 1.1),
                generated_word("second", 1.0, 1.5),
            ],
            ranges: vec![CaptionTimeRange {
                start: 0.4,
                end: 0.6,
            }],
        });

        assert_eq!(
            result
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("first", 0.0, 0.8), ("second", 0.8, 1.3)]
        );
    }

    #[test]
    fn serializes_words_collapsed_to_the_same_cut_boundary() {
        let result = realign_caption_words_after_time_removal(RemoveCaptionWordTimeRangesOptions {
            words: vec![
                generated_word("first", 0.9, 1.4),
                generated_word("second", 1.0, 1.5),
                generated_word("third", 1.1, 1.6),
            ],
            ranges: vec![CaptionTimeRange {
                start: 0.0,
                end: 1.0,
            }],
        });

        assert_eq!(
            result
                .iter()
                .map(|word| (word.start, word.end))
                .collect::<Vec<_>>(),
            vec![(0.0, 0.25), (0.25, 0.425), (0.425, 0.6)]
        );
        assert!(result.windows(2).all(|pair| pair[0].end <= pair[1].start));
    }

    #[test]
    fn keeps_transcript_order_when_word_timings_are_identical() {
        let result = remove_caption_word_time_ranges(RemoveCaptionWordTimeRangesOptions {
            words: vec![
                generated_word("Zulu", 1.0, 1.5),
                generated_word("Alpha", 1.0, 1.5),
                generated_word("Middle", 1.0, 1.5),
            ],
            ranges: Vec::new(),
        });

        assert_eq!(
            result
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Zulu", "Alpha", "Middle"]
        );
    }

    #[test]
    fn reconciles_content_edits_without_duplicating_word_identity() {
        let previous_words = vec![
            TextLayerWordInput {
                id: "one-id".to_string(),
                text: "one".to_string(),
                line_index: 0,
                start_time: Some(time(0.0)),
                end_time: Some(time(1.0)),
            },
            TextLayerWordInput {
                id: "two-id".to_string(),
                text: "two".to_string(),
                line_index: 0,
                start_time: Some(time(1.0)),
                end_time: Some(time(2.0)),
            },
            TextLayerWordInput {
                id: "three-id".to_string(),
                text: "three".to_string(),
                line_index: 0,
                start_time: Some(time(2.0)),
                end_time: Some(time(3.0)),
            },
        ];

        let result = reconcile_text_content_words(ReconcileTextContentWordsOptions {
            content: "one replacement\nthree added".to_string(),
            duration: time(4.0),
            previous_words,
        });

        assert_eq!(
            result
                .iter()
                .map(|word| (
                    word.id.as_str(),
                    word.text.as_str(),
                    word.line_index,
                    word.previous_word_index,
                ))
                .collect::<Vec<_>>(),
            vec![
                ("one-id", "one", 0, Some(0)),
                ("two-id", "replacement", 0, Some(1)),
                ("three-id", "three", 1, Some(2)),
                ("word-3", "added", 1, None),
            ]
        );
        assert_eq!(result[1].start_time, Some(time(1.0)));
        assert_eq!(result[3].start_time, Some(time(3.0)));
        assert_eq!(result[3].end_time, Some(time(4.0)));
    }

    #[test]
    fn clips_and_rebases_timed_words_when_a_layer_is_trimmed() {
        let result = fit_text_layer_words_to_span(FitTextLayerWordsToSpanOptions {
            previous_start_time: time(10.0),
            next_start_time: time(11.5),
            next_duration: time(1.0),
            word_runs: vec![
                TextLayerWordInput {
                    id: "gone".to_string(),
                    text: "gone".to_string(),
                    line_index: 0,
                    start_time: Some(time(0.0)),
                    end_time: Some(time(1.0)),
                },
                TextLayerWordInput {
                    id: "clipped".to_string(),
                    text: "clipped".to_string(),
                    line_index: 2,
                    start_time: Some(time(1.0)),
                    end_time: Some(time(2.0)),
                },
                TextLayerWordInput {
                    id: "kept".to_string(),
                    text: "kept".to_string(),
                    line_index: 2,
                    start_time: Some(time(2.0)),
                    end_time: Some(time(3.0)),
                },
                TextLayerWordInput {
                    id: "presentation".to_string(),
                    text: "presentation".to_string(),
                    line_index: 4,
                    start_time: None,
                    end_time: None,
                },
            ],
        });

        assert_eq!(
            result,
            vec![
                FittedTextLayerWord {
                    previous_word_index: 1,
                    line_index: 0,
                    start_time: Some(time(0.0)),
                    end_time: Some(time(0.5)),
                },
                FittedTextLayerWord {
                    previous_word_index: 2,
                    line_index: 0,
                    start_time: Some(time(0.5)),
                    end_time: Some(time(1.0)),
                },
                FittedTextLayerWord {
                    previous_word_index: 3,
                    line_index: 1,
                    start_time: None,
                    end_time: None,
                },
            ]
        );
    }
}
