use bridge::export;
use serde::{Deserialize, Serialize};

const RESOLUTION_SECONDS: f64 = 0.01;
const INTEGRATION_SECONDS: f64 = 1.0;
const HOLD_SECONDS: f64 = 0.8;
const CONFIRM_SECONDS: f64 = 0.5;
const ACTIVITY_FLOOR: f32 = 0.02;
const DOMINANCE_RATIO: f32 = 1.4;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastMulticamSettings {
    pub sequence_name: String,
    pub min_cut_duration: f64,
    pub max_cut_duration: f64,
    pub pre_roll: f64,
    pub max_lag_seconds: f64,
    pub crosstalk_behavior: String,
    pub silence_behavior: String,
    pub anti_bleed: bool,
    pub keep_camera_mics: bool,
}

impl PodcastMulticamSettings {
    fn defaults(quick: bool) -> Self {
        Self {
            sequence_name: "Podcast Multicam".to_owned(),
            min_cut_duration: if quick { 1.0 } else { 2.0 },
            max_cut_duration: 0.0,
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
        self.max_cut_duration = finite_or(self.max_cut_duration, 0.0).max(0.0);
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
#[derive(Clone, Debug, PartialEq, Serialize)]
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
    let settings = settings.normalized();
    if channel_ids.is_empty() || !(duration > 0.0) || !duration.is_finite() {
        return Vec::new();
    }
    let dominant = compute_dominant_track(
        &timeline,
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
    split_long_cuts(smoothed, settings.max_cut_duration)
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
            start_seconds = (previous.timestamp + previous.duration).max(start_seconds - pre_roll);
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
    let bounce_threshold = min_segment * 2.5;
    loop {
        if smoothed.len() < 3 {
            break;
        }
        let mut changed = false;
        let mut next = vec![smoothed[0].clone()];
        let mut index = 1;
        while index + 1 < smoothed.len() {
            let current = &smoothed[index];
            let following = &smoothed[index + 1];
            if following.channel_id == next.last().unwrap().channel_id
                && current.duration < bounce_threshold
            {
                next.last_mut().unwrap().duration += current.duration + following.duration;
                index += 2;
                changed = true;
            } else {
                next.push(current.clone());
                index += 1;
            }
        }
        if index < smoothed.len() {
            next.push(smoothed[index].clone());
        }
        smoothed = next;
        if !changed {
            break;
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

fn split_long_cuts(
    cuts: Vec<PodcastMulticamCut>,
    max_cut_duration: f64,
) -> Vec<PodcastMulticamCut> {
    if !(max_cut_duration > 0.0) {
        return cuts;
    }
    let mut result = Vec::new();
    for cut in cuts {
        let mut remaining = cut.duration;
        let mut timestamp = cut.timestamp;
        while remaining > max_cut_duration {
            result.push(PodcastMulticamCut {
                timestamp,
                channel_id: cut.channel_id.clone(),
                duration: max_cut_duration,
            });
            timestamp += max_cut_duration;
            remaining -= max_cut_duration;
        }
        if remaining > 0.0 {
            result.push(PodcastMulticamCut {
                timestamp,
                channel_id: cut.channel_id,
                duration: remaining,
            });
        }
    }
    result
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
