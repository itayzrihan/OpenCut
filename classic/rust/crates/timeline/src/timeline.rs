use bridge::export;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::MediaTime;

mod captions;
mod edit_provenance;
mod silence_analysis;
mod source_document;

pub use captions::*;
pub use edit_provenance::*;
pub use silence_analysis::*;
pub use source_document::*;

const DEFAULT_RETIME_RATE: f64 = 1.0;
const MIN_RETIME_RATE: f64 = 0.01;
const MAX_RETIME_RATE: f64 = 5.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSpan {
    pub start_time: MediaTime,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start_time: MediaTime,
    pub end_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeTimelineTimeRangesOptions {
    pub ranges: Vec<TimeRange>,
}

/// Removes invalid ranges and merges overlapping or touching ranges. Results
/// are returned from latest to earliest so callers can splice original
/// timeline coordinates without rebasing every subsequent range.
#[export]
pub fn normalize_timeline_time_ranges(
    NormalizeTimelineTimeRangesOptions { ranges }: NormalizeTimelineTimeRangesOptions,
) -> Vec<TimeRange> {
    normalize_time_ranges(ranges)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedClipTiming {
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub trim_end: MediaTime,
    #[serde(default)]
    pub source_rate: Option<f64>,
    /// Clips carrying the same group are kept sequential after ripple removal.
    /// UI shells use a track ID here for text layers, whose starts may otherwise
    /// collapse beneath an earlier layer whose duration is intentionally kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collision_group: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreserveClipsDuringTimeRemovalOptions {
    pub clips: Vec<PreservedClipTiming>,
    pub removed_ranges: Vec<TimeRange>,
    pub duration_clips: Vec<TimelineSpan>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreserveClipsDuringTimeRemovalResult {
    pub clips: Vec<PreservedClipTiming>,
    pub timeline_duration: MediaTime,
}

/// Ripple companion-layer clips across removed timeline ranges without cutting
/// their content. Once all ranges are applied, only the portion past the
/// resulting visual timeline is trimmed from each clip's tail.
#[export]
pub fn preserve_clips_during_time_removal(
    PreserveClipsDuringTimeRemovalOptions {
        clips,
        removed_ranges,
        duration_clips,
    }: PreserveClipsDuringTimeRemovalOptions,
) -> PreserveClipsDuringTimeRemovalResult {
    let removed_ranges = normalize_time_ranges(removed_ranges);

    let original_duration = duration_clips
        .into_iter()
        .filter(|span| span.duration > MediaTime::ZERO)
        .map(|span| span.start_time + span.duration.max(MediaTime::ZERO))
        .max()
        .unwrap_or(MediaTime::ZERO)
        .max(MediaTime::ZERO);
    let timeline_duration = ripple_time(original_duration, &removed_ranges);

    let mut clips = clips
        .into_iter()
        .map(|clip| adjust_preserved_clip(clip, &removed_ranges))
        .collect::<Vec<_>>();
    resolve_grouped_clip_collisions(&mut clips, timeline_duration);
    for clip in &mut clips {
        trim_clip_tail_to_timeline(clip, timeline_duration);
    }

    PreserveClipsDuringTimeRemovalResult {
        clips,
        timeline_duration,
    }
}

fn normalize_time_ranges(mut ranges: Vec<TimeRange>) -> Vec<TimeRange> {
    ranges.retain(|range| range.end_time > range.start_time);
    ranges.sort_by(|left, right| {
        left.start_time
            .cmp(&right.start_time)
            .then_with(|| left.end_time.cmp(&right.end_time))
    });

    let mut merged = Vec::<TimeRange>::with_capacity(ranges.len());
    for range in ranges {
        let Some(previous) = merged.last_mut() else {
            merged.push(range);
            continue;
        };
        if range.start_time <= previous.end_time {
            previous.end_time = previous.end_time.max(range.end_time);
        } else {
            merged.push(range);
        }
    }
    merged.reverse();
    merged
}

/// Backward-compatible WASM entry point retained while web callers migrate
/// from the original audio-only planner to the generalized clip planner.
#[export]
pub fn preserve_audio_during_time_removal(
    options: PreserveClipsDuringTimeRemovalOptions,
) -> PreserveClipsDuringTimeRemovalResult {
    preserve_clips_during_time_removal(options)
}

fn adjust_preserved_clip(
    mut clip: PreservedClipTiming,
    removed_ranges: &[TimeRange],
) -> PreservedClipTiming {
    clip.start_time = ripple_time(clip.start_time, removed_ranges);
    clip.duration = clip.duration.max(MediaTime::ZERO);

    clip
}

fn resolve_grouped_clip_collisions(
    clips: &mut [PreservedClipTiming],
    timeline_duration: MediaTime,
) {
    let mut grouped_indexes = BTreeMap::<String, Vec<usize>>::new();
    for (index, clip) in clips.iter().enumerate() {
        let Some(group) = clip.collision_group.as_ref() else {
            continue;
        };
        grouped_indexes
            .entry(group.clone())
            .or_default()
            .push(index);
    }

    for indexes in grouped_indexes.values_mut() {
        indexes.sort_by(|left, right| {
            clips[*left]
                .start_time
                .cmp(&clips[*right].start_time)
                .then_with(|| left.cmp(right))
        });
        serialize_equal_start_runs(clips, indexes, timeline_duration);
        indexes.sort_by(|left, right| {
            clips[*left]
                .start_time
                .cmp(&clips[*right].start_time)
                .then_with(|| left.cmp(right))
        });
        let Some(mut previous_index) = indexes.first().copied() else {
            continue;
        };

        for current_index in indexes.iter().copied().skip(1) {
            if clips[previous_index].duration <= MediaTime::ZERO {
                previous_index = current_index;
                continue;
            }

            let previous_start = clips[previous_index].start_time;
            let previous_end = previous_start + clips[previous_index].duration;
            let current_start = clips[current_index].start_time;
            if current_start >= previous_end {
                previous_index = current_index;
                continue;
            }

            if current_start > previous_start {
                // Keep the later layer aligned to its rippled cue and end the
                // earlier static layer exactly where the later one begins.
                let removed_tail = previous_end - current_start;
                clips[previous_index].duration = current_start - previous_start;
                add_source_tail_trim(&mut clips[previous_index], removed_tail);
            } else {
                // Two starts can collapse to the exact cut boundary. Preserve
                // both layers sequentially rather than silently deleting one.
                clips[current_index].start_time = previous_end;
                trim_clip_tail_to_timeline(&mut clips[current_index], timeline_duration);
            }

            previous_index = current_index;
        }
    }
}

fn serialize_equal_start_runs(
    clips: &mut [PreservedClipTiming],
    indexes: &[usize],
    timeline_duration: MediaTime,
) {
    let initial_starts = indexes
        .iter()
        .map(|index| clips[*index].start_time)
        .collect::<Vec<_>>();
    let mut run_start = 0;
    while run_start < indexes.len() {
        let shared_start = initial_starts[run_start];
        let mut run_end = run_start + 1;
        while run_end < indexes.len() && initial_starts[run_end] == shared_start {
            run_end += 1;
        }
        if run_end - run_start < 2 {
            run_start = run_end;
            continue;
        }

        let next_distinct_start = initial_starts.get(run_end).copied();
        let horizon = next_distinct_start
            .unwrap_or(timeline_duration)
            .min(timeline_duration)
            .max(shared_start);
        let run_indexes = &indexes[run_start..run_end];
        let positive_count = run_indexes
            .iter()
            .filter(|index| clips[**index].duration > MediaTime::ZERO)
            .count() as i64;
        let minimum_span = MediaTime::from_ticks(positive_count);
        let effective_start = if horizon - shared_start < minimum_span {
            (horizon - minimum_span).max(MediaTime::ZERO)
        } else {
            shared_start
        };
        let available = horizon - effective_start;
        let desired_total = run_indexes.iter().fold(MediaTime::ZERO, |total, index| {
            total + clips[*index].duration.max(MediaTime::ZERO)
        });
        let allocations = allocate_serial_durations(
            run_indexes
                .iter()
                .map(|index| clips[*index].duration.max(MediaTime::ZERO))
                .collect(),
            available,
        );

        let mut cursor = effective_start;
        for (index, allocation) in run_indexes.iter().copied().zip(allocations) {
            let previous_duration = clips[index].duration;
            clips[index].start_time = cursor;
            clips[index].duration = allocation;
            if allocation < previous_duration {
                add_source_tail_trim(&mut clips[index], previous_duration - allocation);
            }
            cursor = cursor + allocation;
        }

        debug_assert!(desired_total <= available || cursor <= horizon);
        run_start = run_end;
    }
}

fn allocate_serial_durations(desired: Vec<MediaTime>, available: MediaTime) -> Vec<MediaTime> {
    let available_ticks = available.max(MediaTime::ZERO).as_ticks();
    let desired_ticks = desired
        .iter()
        .map(|duration| (*duration).max(MediaTime::ZERO).as_ticks())
        .collect::<Vec<_>>();
    let desired_total = desired_ticks.iter().sum::<i64>();
    if desired_total <= available_ticks {
        return desired;
    }

    let positive_count = desired_ticks
        .iter()
        .filter(|duration| **duration > 0)
        .count() as i64;
    let mut remaining_ticks = available_ticks;
    let mut remaining_weight = desired_total;
    let mut remaining_positive = positive_count;
    desired_ticks
        .into_iter()
        .map(|duration| {
            if duration <= 0 || remaining_ticks <= 0 {
                return MediaTime::ZERO;
            }
            let minimum_for_rest = (remaining_positive - 1).min(remaining_ticks - 1);
            let maximum = remaining_ticks - minimum_for_rest;
            let proportional = ((remaining_ticks as i128 * duration as i128)
                / remaining_weight.max(1) as i128) as i64;
            let allocation = proportional.max(1).min(maximum.max(1));
            remaining_ticks -= allocation;
            remaining_weight -= duration;
            remaining_positive -= 1;
            MediaTime::from_ticks(allocation)
        })
        .collect()
}

fn trim_clip_tail_to_timeline(clip: &mut PreservedClipTiming, timeline_duration: MediaTime) {
    let available_duration = (timeline_duration - clip.start_time).max(MediaTime::ZERO);
    let preserved_duration = clip.duration.min(available_duration);
    let removed_tail = clip.duration - preserved_duration;
    if removed_tail <= MediaTime::ZERO {
        return;
    }

    clip.duration = preserved_duration;
    add_source_tail_trim(clip, removed_tail);
}

fn add_source_tail_trim(clip: &mut PreservedClipTiming, removed_tail: MediaTime) {
    if let Some(source_rate) = clip.source_rate {
        clip.trim_end =
            clip.trim_end + scale_media_time(removed_tail, effective_rate(Some(source_rate)));
    }
}

fn ripple_time(mut time: MediaTime, removed_ranges: &[TimeRange]) -> MediaTime {
    time = time.max(MediaTime::ZERO);
    for range in removed_ranges {
        let removed_duration = range.end_time - range.start_time;
        if removed_duration <= MediaTime::ZERO {
            continue;
        }

        if time >= range.end_time {
            time = (time - removed_duration).max(MediaTime::ZERO);
        } else if time > range.start_time {
            time = range.start_time.max(MediaTime::ZERO);
        }
    }

    time
}

fn effective_rate(rate: Option<f64>) -> f64 {
    match rate {
        Some(rate) if rate.is_finite() && rate > 0.0 => {
            rate.clamp(MIN_RETIME_RATE, MAX_RETIME_RATE)
        }
        _ => DEFAULT_RETIME_RATE,
    }
}

fn scale_media_time(time: MediaTime, scale: f64) -> MediaTime {
    MediaTime::from_ticks(((time.as_ticks() as f64) * scale).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(ticks: i64) -> MediaTime {
        MediaTime::from_ticks(ticks)
    }

    fn clip(start_time: i64, duration: i64) -> PreservedClipTiming {
        PreservedClipTiming {
            start_time: time(start_time),
            duration: time(duration),
            trim_end: MediaTime::ZERO,
            source_rate: None,
            collision_group: None,
        }
    }

    fn preserve(
        clips: Vec<PreservedClipTiming>,
        removed_ranges: Vec<TimeRange>,
        original_duration: i64,
    ) -> PreserveClipsDuringTimeRemovalResult {
        preserve_clips_during_time_removal(PreserveClipsDuringTimeRemovalOptions {
            clips,
            removed_ranges,
            duration_clips: vec![TimelineSpan {
                start_time: MediaTime::ZERO,
                duration: time(original_duration),
            }],
        })
    }

    #[test]
    fn ripples_a_later_companion_clip_without_cutting_it() {
        let result = preserve(
            vec![clip(40, 10)],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips, vec![clip(30, 10)]);
    }

    #[test]
    fn snaps_a_companion_clip_starting_inside_a_removed_range_to_the_cut() {
        let result = preserve(
            vec![clip(25, 10)],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips, vec![clip(20, 10)]);
    }

    #[test]
    fn leaves_a_companion_clip_overlapping_a_removed_range_intact() {
        let result = preserve(
            vec![clip(15, 20)],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips, vec![clip(15, 20)]);
    }

    #[test]
    fn applies_multiple_removed_ranges_to_companion_clip_start_times() {
        let result = preserve(
            vec![clip(50, 10)],
            vec![
                TimeRange {
                    start_time: time(10),
                    end_time: time(15),
                },
                TimeRange {
                    start_time: time(30),
                    end_time: time(40),
                },
            ],
            100,
        );

        assert_eq!(result.clips, vec![clip(35, 10)]);
    }

    #[test]
    fn merges_overlapping_selected_clip_ranges_before_ripple() {
        let normalized = normalize_timeline_time_ranges(NormalizeTimelineTimeRangesOptions {
            ranges: vec![
                TimeRange {
                    start_time: time(10),
                    end_time: time(20),
                },
                TimeRange {
                    start_time: time(15),
                    end_time: time(25),
                },
                TimeRange {
                    start_time: time(30),
                    end_time: time(35),
                },
            ],
        });

        assert_eq!(
            normalized,
            vec![
                TimeRange {
                    start_time: time(30),
                    end_time: time(35),
                },
                TimeRange {
                    start_time: time(10),
                    end_time: time(25),
                },
            ]
        );

        let result = preserve(vec![clip(40, 5)], normalized, 50);
        assert_eq!(result.clips[0].start_time, time(20));
    }

    #[test]
    fn grouped_text_clips_do_not_overlap_after_ripple() {
        let mut first = clip(15, 20);
        first.collision_group = Some("caption-track".to_string());
        let mut second = clip(35, 10);
        second.collision_group = Some("caption-track".to_string());

        let result = preserve(
            vec![first, second],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips[0].start_time, time(15));
        assert_eq!(result.clips[0].duration, time(10));
        assert_eq!(result.clips[1].start_time, time(25));
        assert_eq!(result.clips[1].duration, time(10));
    }

    #[test]
    fn equal_grouped_starts_are_serialized_without_dropping_text() {
        let mut first = clip(22, 5);
        first.collision_group = Some("caption-track".to_string());
        let mut second = clip(25, 5);
        second.collision_group = Some("caption-track".to_string());

        let result = preserve(
            vec![first, second],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips[0].start_time, time(20));
        assert_eq!(result.clips[0].duration, time(5));
        assert_eq!(result.clips[1].start_time, time(25));
        assert_eq!(result.clips[1].duration, time(5));
    }

    #[test]
    fn equal_grouped_starts_share_the_remaining_tail_span() {
        let mut first = clip(95, 10);
        first.collision_group = Some("caption-track".to_string());
        let mut second = clip(96, 10);
        second.collision_group = Some("caption-track".to_string());

        let result = preserve(
            vec![first, second],
            vec![TimeRange {
                start_time: time(90),
                end_time: time(100),
            }],
            105,
        );

        assert_eq!(result.timeline_duration, time(95));
        assert_eq!(result.clips[0].start_time, time(90));
        assert!(result.clips[0].duration > MediaTime::ZERO);
        assert_eq!(
            result.clips[1].start_time,
            result.clips[0].start_time + result.clips[0].duration
        );
        assert!(result.clips[1].duration > MediaTime::ZERO);
        assert_eq!(
            result.clips[1].start_time + result.clips[1].duration,
            result.timeline_duration
        );
    }

    #[test]
    fn equal_grouped_starts_at_the_tail_reclaim_a_minimum_span() {
        let mut first = clip(100, 10);
        first.collision_group = Some("caption-track".to_string());
        let mut second = clip(100, 10);
        second.collision_group = Some("caption-track".to_string());

        let result = preserve(vec![first, second], Vec::new(), 100);

        assert_eq!(result.clips[0].start_time, time(98));
        assert_eq!(result.clips[0].duration, MediaTime::ONE_TICK);
        assert_eq!(result.clips[1].start_time, time(99));
        assert_eq!(result.clips[1].duration, MediaTime::ONE_TICK);
    }

    #[test]
    fn different_text_tracks_may_still_overlap() {
        let mut first = clip(15, 20);
        first.collision_group = Some("top-captions".to_string());
        let mut second = clip(35, 10);
        second.collision_group = Some("bottom-captions".to_string());

        let result = preserve(
            vec![first, second],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips[0].duration, time(20));
        assert_eq!(result.clips[1].start_time, time(25));
    }

    #[test]
    fn ripple_can_make_a_sound_fit_without_tail_trimming() {
        let result = preserve(
            vec![clip(80, 15)],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.clips, vec![clip(70, 15)]);
    }

    #[test]
    fn trims_only_the_tail_that_exceeds_the_visual_duration() {
        let result = preserve(vec![clip(70, 30)], vec![], 90);

        assert_eq!(
            result.clips,
            vec![PreservedClipTiming {
                start_time: time(70),
                duration: time(20),
                trim_end: MediaTime::ZERO,
                source_rate: None,
                collision_group: None,
            }]
        );
    }

    #[test]
    fn source_media_tail_trim_accounts_for_its_retime_rate() {
        let result = preserve(
            vec![PreservedClipTiming {
                source_rate: Some(2.0),
                ..clip(70, 30)
            }],
            vec![],
            90,
        );

        assert_eq!(result.clips[0].duration, time(20));
        assert_eq!(result.clips[0].trim_end, time(20));
    }

    #[test]
    fn clips_starting_after_the_visual_timeline_have_no_duration() {
        let result = preserve(vec![clip(100, 10)], vec![], 90);

        assert_eq!(result.clips[0].duration, MediaTime::ZERO);
    }

    #[test]
    fn derives_the_video_length_without_companion_clips() {
        let result = preserve_clips_during_time_removal(PreserveClipsDuringTimeRemovalOptions {
            clips: vec![clip(0, 200)],
            removed_ranges: vec![],
            duration_clips: vec![
                TimelineSpan {
                    start_time: time(10),
                    duration: time(20),
                },
                TimelineSpan {
                    start_time: time(40),
                    duration: time(10),
                },
            ],
        });

        assert_eq!(result.timeline_duration, time(50));
        assert_eq!(result.clips[0].duration, time(50));
    }

    #[test]
    fn removed_ranges_reduce_the_derived_video_length() {
        let result = preserve(
            vec![clip(0, 200)],
            vec![TimeRange {
                start_time: time(20),
                end_time: time(30),
            }],
            100,
        );

        assert_eq!(result.timeline_duration, time(90));
        assert_eq!(result.clips[0].duration, time(90));
    }
}
