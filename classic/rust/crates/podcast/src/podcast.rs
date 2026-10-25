mod camera_groups;
pub use camera_groups::*;
mod advanced;
pub use advanced::*;
mod precision;
pub use precision::*;
mod coverage;
pub use coverage::*;
mod hard_limiter;
pub use hard_limiter::*;
mod noise_reduction;
pub use noise_reduction::*;
mod group_alignment;
pub use group_alignment::*;
mod energy;
pub use energy::*;
mod alignment;
pub use alignment::*;

use bridge::export;
use serde::{Deserialize, Serialize};

const RESOLUTION_SECONDS: f64 = 0.01;
// Short evidence windows avoid the previous ~1 second late speaker changes.
const INTEGRATION_SECONDS: f64 = 0.2;
const HOLD_SECONDS: f64 = 0.8;
const CONFIRM_SECONDS: f64 = 0.15;
const ACTIVITY_FLOOR: f32 = 0.02;
const DOMINANCE_RATIO: f32 = 1.4;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastMulticamSettings {
    pub sequence_name: String,
    pub min_cut_duration: f64,
    pub max_cut_duration: f64,
    /// Brief listener shot after a long speaking turn; old projects use five seconds.
    #[serde(default = "default_reaction_duration")]
    pub reaction_duration: f64,
    pub pre_roll: f64,
    pub max_lag_seconds: f64,
    pub crosstalk_behavior: String,
    pub silence_behavior: String,
    pub anti_bleed: bool,
    pub keep_camera_mics: bool,
}

fn default_reaction_duration() -> f64 {
    5.0
}

impl PodcastMulticamSettings {
    fn defaults(quick: bool) -> Self {
        Self {
            sequence_name: "Podcast Multicam".to_owned(),
            min_cut_duration: if quick { 1.0 } else { 2.0 },
            max_cut_duration: 20.0,
            reaction_duration: default_reaction_duration(),
            pre_roll: 0.15,
            max_lag_seconds: 1200.0,
            crosstalk_behavior: "stay".to_owned(),
            silence_behavior: "stay_on_last".to_owned(),
            anti_bleed: true,
            keep_camera_mics: false,
        }
    }

    fn normalized(mut self) -> Self {
        if self.sequence_name.trim().is_empty() {
            self.sequence_name = "Podcast Multicam".to_owned();
        } else {
            self.sequence_name = self.sequence_name.trim().to_owned();
        }
        self.min_cut_duration = finite_or(self.min_cut_duration, 1.0).clamp(0.1, 10.0);
        self.max_cut_duration = finite_or(self.max_cut_duration, 20.0).clamp(0.0, 3600.0);
        if self.max_cut_duration > 0.0 {
            self.max_cut_duration = self.max_cut_duration.max(self.min_cut_duration);
        }
        let reaction_max = if self.max_cut_duration > 0.0 {
            self.max_cut_duration
        } else {
            60.0
        };
        self.reaction_duration =
            finite_or(self.reaction_duration, 5.0).clamp(self.min_cut_duration, reaction_max);
        self.pre_roll = finite_or(self.pre_roll, 0.15).clamp(0.0, 1.0);
        self.max_lag_seconds = finite_or(self.max_lag_seconds, 1200.0).clamp(1.0, 3600.0);
        if self.crosstalk_behavior != "priority" {
            self.crosstalk_behavior = "stay".to_owned();
        }
        self.silence_behavior = "stay_on_last".to_owned();
        self
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastMulticamDefaultsOptions {
    #[serde(default)]
    pub quick: bool,
}

#[export]
pub fn podcast_multicam_defaults(
    PodcastMulticamDefaultsOptions { quick }: PodcastMulticamDefaultsOptions,
) -> PodcastMulticamSettings {
    PodcastMulticamSettings::defaults(quick)
}

#[export]
pub fn normalize_podcast_multicam_settings(
    settings: PodcastMulticamSettings,
) -> PodcastMulticamSettings {
    settings.normalized()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePodcastMulticamOptions {
    pub timeline: Vec<Vec<f32>>,
    pub channel_ids: Vec<String>,
    pub duration: f64,
    pub settings: PodcastMulticamSettings,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastMulticamCut {
    pub timestamp: f64,
    pub channel_id: String,
    pub duration: f64,
}

#[export]
pub fn route_podcast_multicam(
    RoutePodcastMulticamOptions {
        timeline,
        channel_ids,
        duration,
        settings,
    }: RoutePodcastMulticamOptions,
) -> Vec<PodcastMulticamCut> {
    route_podcast_multicam_grouped(
        RoutePodcastMulticamOptions {
            timeline,
            channel_ids,
            duration,
            settings,
        },
        &[],
    )
}

pub(crate) fn route_podcast_multicam_grouped(
    o: RoutePodcastMulticamOptions,
    groups: &[PodcastAngleGroup],
) -> Vec<PodcastMulticamCut> {
    let RoutePodcastMulticamOptions {
        timeline,
        channel_ids,
        duration,
        settings,
    } = o;
    let settings = settings.normalized();
    if channel_ids.is_empty()
        || channel_ids.len() > MAX_PODCAST_CHANNELS
        || !(duration > 0.0)
        || !duration.is_finite()
        || duration > 36000.0
        || timeline.len() > 3_600_001
        || timeline
            .iter()
            .any(|r| r.len() != channel_ids.len() || r.iter().any(|v| !v.is_finite() || *v < 0.0))
    {
        return Vec::new();
    }
    let usable = timeline
        .len()
        .min((duration / RESOLUTION_SECONDS).ceil() as usize);
    let dominant = compute_dominant_track(
        &timeline[..usable],
        channel_ids.len(),
        settings.crosstalk_behavior == "priority",
    );
    let cuts = dominant_track_to_cuts(
        &dominant,
        &channel_ids,
        duration,
        settings.min_cut_duration,
        settings.pre_roll,
    );
    let smoothed = smooth_cuts(cuts, settings.min_cut_duration);
    insert_reaction_shots(smoothed, &channel_ids, &settings, &timeline, groups)
}

fn argmax(row: &[f32], num_channels: usize) -> usize {
    let mut best_index = 0;
    let mut best_value = row.first().copied().unwrap_or(0.0);
    for channel in 1..num_channels {
        let value = row.get(channel).copied().unwrap_or(0.0);
        if value > best_value {
            best_value = value;
            best_index = channel;
        }
    }
    best_index
}

fn priority_crosstalk_channel(row: &[f32], num_channels: usize) -> Option<usize> {
    let active = (0..num_channels)
        .filter(|channel| row.get(*channel).copied().unwrap_or(0.0) >= ACTIVITY_FLOOR)
        .collect::<Vec<_>>();
    if active.len() < 2 {
        return None;
    }
    let mut energies = active
        .iter()
        .map(|channel| row.get(*channel).copied().unwrap_or(0.0))
        .collect::<Vec<_>>();
    energies.sort_by(|left, right| right.total_cmp(left));
    let top = energies.first().copied().unwrap_or(0.0);
    let second = energies.get(1).copied().unwrap_or(0.0);
    if top / second.max(1e-8) < DOMINANCE_RATIO {
        active.into_iter().min()
    } else {
        None
    }
}

fn compute_dominant_track(
    timeline: &[Vec<f32>],
    num_channels: usize,
    priority_crosstalk: bool,
) -> Vec<usize> {
    let num_steps = timeline.len();
    if num_steps == 0 || num_channels == 0 {
        return Vec::new();
    }
    let integration_frames = ((INTEGRATION_SECONDS / RESOLUTION_SECONDS).round() as usize).max(1);
    let hold_frames = ((HOLD_SECONDS / RESOLUTION_SECONDS).round() as usize).max(1);
    let confirm_frames = ((CONFIRM_SECONDS / RESOLUTION_SECONDS).round() as usize).max(1);
    let mut integrated = vec![vec![0.0_f32; num_channels]; num_steps];

    for channel in 0..num_channels {
        let mut prefix = vec![0.0_f64; num_steps + 1];
        for index in 0..num_steps {
            prefix[index + 1] = prefix[index]
                + timeline
                    .get(index)
                    .and_then(|row| row.get(channel))
                    .copied()
                    .unwrap_or(0.0) as f64;
        }
        for index in 0..num_steps {
            let low = (index + 1).saturating_sub(integration_frames);
            integrated[index][channel] =
                ((prefix[index + 1] - prefix[low]) / (index + 1 - low) as f64) as f32;
        }
    }

    let init_window = num_steps.min((2.0 / RESOLUTION_SECONDS).round() as usize);
    let mut initial_energy = vec![0.0_f64; num_channels];
    for row in integrated.iter().take(init_window) {
        for channel in 0..num_channels {
            initial_energy[channel] += row[channel] as f64;
        }
    }
    let mut current_speaker = argmax(
        &initial_energy
            .iter()
            .map(|value| *value as f32)
            .collect::<Vec<_>>(),
        num_channels,
    );
    let mut challenger_counter = 0_usize;
    let mut challenger_id = None;
    let mut silence_counter = 0_usize;
    let mut dominant = vec![current_speaker; num_steps];

    for (frame, energies) in integrated.iter().enumerate() {
        let current_energy = energies.get(current_speaker).copied().unwrap_or(0.0);
        if current_energy >= ACTIVITY_FLOOR {
            silence_counter = 0;
        } else {
            silence_counter += 1;
        }

        let best_channel = if priority_crosstalk {
            priority_crosstalk_channel(energies, num_channels)
                .unwrap_or_else(|| argmax(energies, num_channels))
        } else {
            argmax(energies, num_channels)
        };
        let best_energy = energies.get(best_channel).copied().unwrap_or(0.0);
        if best_channel == current_speaker {
            challenger_counter = 0;
            challenger_id = None;
            dominant[frame] = current_speaker;
            continue;
        }

        let ratio = best_energy / current_energy.max(1e-8);
        let required_ratio = if silence_counter < hold_frames {
            DOMINANCE_RATIO * 1.5
        } else {
            DOMINANCE_RATIO
        };
        let is_priority_crosstalk = priority_crosstalk
            && priority_crosstalk_channel(energies, num_channels) == Some(best_channel);
        if (!is_priority_crosstalk && ratio < required_ratio) || best_energy < ACTIVITY_FLOOR {
            challenger_counter = 0;
            challenger_id = None;
            dominant[frame] = current_speaker;
            continue;
        }

        if challenger_id == Some(best_channel) {
            challenger_counter += 1;
        } else {
            challenger_id = Some(best_channel);
            challenger_counter = 1;
        }
        if challenger_counter >= confirm_frames {
            current_speaker = best_channel;
            challenger_counter = 0;
            challenger_id = None;
            silence_counter = 0;
        }
        dominant[frame] = current_speaker;
    }
    dominant
}

fn dominant_track_to_cuts(
    dominant: &[usize],
    channel_ids: &[String],
    duration: f64,
    min_cut_duration: f64,
    pre_roll: f64,
) -> Vec<PodcastMulticamCut> {
    if dominant.is_empty() {
        return vec![PodcastMulticamCut {
            timestamp: 0.0,
            channel_id: channel_ids.first().cloned().unwrap_or_default(),
            duration,
        }];
    }
    let mut segments = Vec::<(usize, usize, usize)>::new();
    let mut segment_start = 0;
    let mut segment_channel = dominant[0];
    for (index, channel) in dominant.iter().copied().enumerate().skip(1) {
        if channel != segment_channel {
            segments.push((segment_start, index, segment_channel));
            segment_start = index;
            segment_channel = channel;
        }
    }
    segments.push((segment_start, dominant.len(), segment_channel));

    let min_frames = ((min_cut_duration / RESOLUTION_SECONDS).round() as usize).max(1);
    loop {
        let mut changed = false;
        let mut next = Vec::<(usize, usize, usize)>::new();
        for segment in segments {
            if segment.1 - segment.0 < min_frames && !next.is_empty() {
                if let Some(previous) = next.last_mut() {
                    previous.1 = segment.1;
                }
                changed = true;
            } else {
                next.push(segment);
            }
        }
        segments = next;
        if !changed {
            break;
        }
    }

    let mut merged = Vec::<(usize, usize, usize)>::new();
    for segment in segments {
        if let Some(previous) = merged.last_mut()
            && previous.2 == segment.2
        {
            previous.1 = segment.1;
            continue;
        }
        merged.push(segment);
    }

    let mut cuts = Vec::<PodcastMulticamCut>::new();
    for (index, (start_frame, end_frame, channel_index)) in merged.iter().copied().enumerate() {
        let mut start_seconds = start_frame as f64 * RESOLUTION_SECONDS;
        let end_seconds = (end_frame as f64 * RESOLUTION_SECONDS).min(duration);
        if index > 0
            && let Some(previous) = cuts.last_mut()
        {
            start_seconds = (previous.timestamp + min_cut_duration).max(start_seconds - pre_roll);
            previous.duration = start_seconds - previous.timestamp;
        }
        let cut_duration = if index + 1 == merged.len() {
            duration - start_seconds
        } else {
            end_seconds - start_seconds
        };
        cuts.push(PodcastMulticamCut {
            timestamp: start_seconds,
            channel_id: channel_ids
                .get(channel_index)
                .or_else(|| channel_ids.first())
                .cloned()
                .unwrap_or_default(),
            duration: cut_duration.max(0.0),
        });
    }
    cuts
}

fn smooth_cuts(cuts: Vec<PodcastMulticamCut>, min_segment: f64) -> Vec<PodcastMulticamCut> {
    if cuts.len() <= 1 {
        return cuts;
    }
    let mut smoothed = Vec::<PodcastMulticamCut>::new();
    for cut in cuts {
        if cut.duration < min_segment && !smoothed.is_empty() {
            smoothed.last_mut().unwrap().duration += cut.duration;
        } else {
            smoothed.push(cut);
        }
    }
    let mut merged = Vec::<PodcastMulticamCut>::new();
    for cut in smoothed {
        if let Some(previous) = merged.last_mut()
            && previous.channel_id == cut.channel_id
        {
            previous.duration += cut.duration;
            continue;
        }
        merged.push(cut);
    }
    merged
}

/// The displayed camera has its own clock, independent of acoustic speaker changes.
/// This prevents same-camera splits, premature returns, and maximum violations when
/// a listener begins speaking during their reaction shot. Only the final tail may
/// be shorter than the minimum, as the recording can end mid-shot.
fn insert_reaction_shots(
    cuts: Vec<PodcastMulticamCut>,
    channel_ids: &[String],
    settings: &PodcastMulticamSettings,
    timeline: &[Vec<f32>],
    groups: &[PodcastAngleGroup],
) -> Vec<PodcastMulticamCut> {
    if settings.max_cut_duration <= 0.0 || channel_ids.len() < 2 || cuts.is_empty() {
        return cuts;
    }
    let duration = cuts.last().map(|c| c.timestamp + c.duration).unwrap_or(0.0);
    let minimum = (settings.min_cut_duration / RESOLUTION_SECONDS).ceil() as usize;
    let maximum = (settings.max_cut_duration / RESOLUTION_SECONDS)
        .floor()
        .max(minimum as f64) as usize;
    let reaction_length = (settings.reaction_duration / RESOLUTION_SECONDS).round() as usize;
    let mut visual = cuts[0].channel_id.clone();
    let mut start = 0usize;
    let mut source = 0usize;
    let mut reaction: Option<(String, usize)> = None;
    let mut result = Vec::new();
    for frame in 1..(duration / RESOLUTION_SECONDS).ceil() as usize {
        let time = frame as f64 * RESOLUTION_SECONDS;
        while source + 1 < cuts.len() && cuts[source + 1].timestamp <= time + 1e-8 {
            source += 1;
        }
        let speaker = &cuts[source].channel_id;
        if reaction
            .as_ref()
            .is_some_and(|(original, until)| original != speaker || frame >= *until)
        {
            reaction = None;
        }
        let elapsed = frame - start;
        let mut next = visual.clone();
        if elapsed >= minimum && reaction.is_none() {
            next = speaker.clone();
        }
        let audible = timeline
            .get(frame)
            .is_some_and(|row| row.iter().any(|v| *v >= ACTIVITY_FLOOR));
        if elapsed >= maximum && next == visual && audible {
            let index = channel_ids.iter().position(|id| id == &visual).unwrap_or(0);
            next = groups
                .iter()
                .find(|g| g.channel_ids.contains(&visual))
                .and_then(|g| g.channel_ids.iter().find(|id| **id != visual))
                .cloned()
                .unwrap_or_else(|| channel_ids[(index + 1) % channel_ids.len()].clone());
            reaction = Some((speaker.clone(), frame + reaction_length));
        }
        if next != visual {
            append_cut(
                &mut result,
                start as f64 * RESOLUTION_SECONDS,
                &visual,
                elapsed as f64 * RESOLUTION_SECONDS,
            );
            start = frame;
            visual = next;
        }
    }
    append_cut(
        &mut result,
        start as f64 * RESOLUTION_SECONDS,
        &visual,
        duration - start as f64 * RESOLUTION_SECONDS,
    );
    result
}

fn append_cut(cuts: &mut Vec<PodcastMulticamCut>, timestamp: f64, channel: &str, duration: f64) {
    if let Some(previous) = cuts.last_mut()
        && previous.channel_id == channel
        && (previous.timestamp + previous.duration - timestamp).abs() < 1e-7
    {
        previous.duration += duration;
        return;
    }
    cuts.push(PodcastMulticamCut {
        timestamp,
        channel_id: channel.into(),
        duration,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_defaults_match_quick_and_guided_paths() {
        let quick = PodcastMulticamSettings::defaults(true);
        let guided = PodcastMulticamSettings::defaults(false);
        assert_eq!(quick.min_cut_duration, 1.0);
        assert_eq!(guided.min_cut_duration, 2.0);
        assert_eq!(quick.pre_roll, 0.15);
        assert_eq!(quick.crosstalk_behavior, "stay");
        assert_eq!(quick.silence_behavior, "stay_on_last");
        assert!(quick.anti_bleed);
        assert!(!quick.keep_camera_mics);
    }

    #[test]
    fn routes_a_clear_speaker_change() {
        let mut timeline = vec![vec![1.0, 0.0]; 800];
        for row in timeline.iter_mut().skip(200) {
            *row = vec![0.0, 1.0];
        }
        let cuts = route_podcast_multicam(RoutePodcastMulticamOptions {
            timeline,
            channel_ids: vec!["one".into(), "two".into()],
            duration: 8.0,
            settings: PodcastMulticamSettings::defaults(true),
        });
        assert!(!cuts.is_empty());
        assert_eq!(cuts.first().unwrap().channel_id, "one");
        assert!(cuts.iter().any(|cut| cut.channel_id == "two"));
    }
}

#[cfg(test)]
mod routing_contract_tests {
    use super::*;
    fn plan(seconds: usize, switches: &[(usize, usize)], max: f64) -> Vec<PodcastMulticamCut> {
        let mut timeline = vec![vec![1.0, 0.0]; seconds * 100];
        for &(at, channel) in switches {
            for row in &mut timeline[at * 100..] {
                *row = if channel == 0 {
                    vec![1.0, 0.0]
                } else {
                    vec![0.0, 1.0]
                };
            }
        }
        let mut settings = PodcastMulticamSettings::defaults(true);
        settings.max_cut_duration = max;
        route_podcast_multicam(RoutePodcastMulticamOptions {
            timeline,
            channel_ids: vec!["a".into(), "b".into()],
            duration: seconds as f64,
            settings,
        })
    }
    #[test]
    fn monologue_shows_listener_then_returns() {
        let cuts = plan(70, &[], 20.0);
        assert_eq!(
            cuts.iter()
                .map(|c| (c.timestamp, c.channel_id.as_str(), c.duration))
                .collect::<Vec<_>>(),
            vec![
                (0.0, "a", 20.0),
                (20.0, "b", 5.0),
                (25.0, "a", 20.0),
                (45.0, "b", 5.0),
                (50.0, "a", 20.0)
            ]
        );
    }
    #[test]
    fn limits_apply_to_visual_camera_even_when_listener_becomes_speaker() {
        let cuts = plan(80, &[(23, 1), (63, 0)], 20.0);
        let mut end = 0.0;
        for (i, c) in cuts.iter().enumerate() {
            assert!((c.timestamp - end).abs() < 1e-8);
            assert!(c.duration > 0.0 && c.duration <= 20.0 + 1e-8);
            if i + 1 < cuts.len() {
                assert!(c.duration >= 1.0);
                assert_ne!(c.channel_id, cuts[i + 1].channel_id);
            }
            end = c.timestamp + c.duration;
        }
        assert!((end - 80.0).abs() < 1e-8);
    }
    #[test]
    fn no_reactions_with_one_camera_or_disabled_maximum() {
        assert_eq!(plan(70, &[], 0.0).len(), 1);
        let cuts = route_podcast_multicam(RoutePodcastMulticamOptions {
            timeline: vec![vec![1.0]; 7000],
            channel_ids: vec!["a".into()],
            duration: 70.0,
            settings: PodcastMulticamSettings::defaults(true),
        });
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].duration, 70.0);
    }
    #[test]
    fn preroll_moves_boundary_without_gaps_or_erasing_valid_interjection() {
        let dominant = [vec![0; 400], vec![1; 150], vec![0; 400]].concat();
        let ids = vec!["a".into(), "b".into()];
        let cuts = smooth_cuts(dominant_track_to_cuts(&dominant, &ids, 9.5, 1.0, 0.15), 1.0);
        assert_eq!(cuts.len(), 3);
        assert!((cuts[1].timestamp - 3.85).abs() < 1e-8);
        assert!((cuts[0].duration - cuts[1].timestamp).abs() < 1e-8);
    }
    #[test]
    fn invalid_limits_are_normalized() {
        let mut s = PodcastMulticamSettings::defaults(true);
        s.min_cut_duration = 4.0;
        s.max_cut_duration = 2.0;
        s.reaction_duration = 1.0;
        let s = s.normalized();
        assert_eq!(s.max_cut_duration, 4.0);
        assert_eq!(s.reaction_duration, 4.0);
    }
}
