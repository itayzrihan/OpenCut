//! Place chronological audio on the same clock as waveform-connected cameras.
use bridge::export;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderedPodcastClockOptions {
    /// Audio sources come first, in the user's order, followed by video sources.
    pub durations: Vec<f64>,
    pub audio_count: usize,
    /// A minimum gap before each audio file. The first entry is always zero.
    pub minimum_gaps: Vec<f64>,
    pub components: Vec<usize>,
    pub offsets: Vec<f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderedPodcastClock {
    pub starts: Vec<f64>,
    pub duration: f64,
}

#[export]
pub fn order_podcast_clock(options: OrderedPodcastClockOptions) -> Option<OrderedPodcastClock> {
    let OrderedPodcastClockOptions {
        durations,
        audio_count,
        minimum_gaps,
        components,
        offsets,
    } = options;
    let count = durations.len();
    if !(1..=32).contains(&audio_count)
        || count <= audio_count
        || count > 64
        || offsets.len() != count
        || components.len() != count
        || minimum_gaps.len() != audio_count
        || minimum_gaps[0] != 0.0
        || durations
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.0 || *v > 36000.0)
        || offsets.iter().any(|v| !v.is_finite() || v.abs() > 36000.0)
        || minimum_gaps
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0 || *v > 36000.0)
        || components
            .iter()
            .any(|&id| id >= count || !components[..audio_count].contains(&id))
    {
        return None;
    }

    let mut shifts = vec![0.0_f64; count];
    let first = components[0];
    shifts[first] = -offsets[0];
    let constraints: Vec<_> = (1..audio_count)
        .filter_map(|i| {
            let a = components[i - 1];
            let b = components[i];
            let distance = offsets[i - 1] + durations[i - 1] + minimum_gaps[i] - offsets[i];
            (a != b).then_some((a, b, distance))
        })
        .collect();
    // A disconnected take has no measured wall-clock gap. Choose the earliest
    // placement consistent with chronology and every connected camera bridge.
    let mut assigned = vec![false; count];
    assigned[first] = true;
    for _ in 0..count {
        let mut changed = false;
        for &(a, b, distance) in &constraints {
            if assigned[a] && (!assigned[b] || shifts[a] + distance > shifts[b] + 1e-7) {
                if b == first {
                    return None;
                }
                shifts[b] = shifts[a] + distance;
                assigned[b] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    if constraints
        .iter()
        .any(|&(a, b, distance)| shifts[a] + distance > shifts[b] + 1e-7)
    {
        return None;
    }
    let mut starts: Vec<_> = offsets
        .iter()
        .zip(components.iter())
        .map(|(offset, &id)| offset + shifts[id])
        .collect();
    starts[0] = 0.0;
    for i in 1..audio_count {
        let minimum = starts[i - 1] + durations[i - 1] + minimum_gaps[i];
        // Coarse audio matches use a 10 ms grid. Remove tiny overlaps without
        // discarding original audio. Larger conflicts need corrected input.
        if starts[i] < minimum - 0.035 {
            return None;
        }
        starts[i] = starts[i].max(minimum);
    }
    let duration = starts[audio_count - 1] + durations[audio_count - 1];
    (duration <= 36000.0).then_some(OrderedPodcastClock { starts, duration })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(
        components: Vec<usize>,
        offsets: Vec<f64>,
        minimum: f64,
    ) -> Option<OrderedPodcastClock> {
        order_podcast_clock(OrderedPodcastClockOptions {
            durations: vec![12.0, 10.0, 25.0, 4.0],
            audio_count: 2,
            minimum_gaps: vec![0.0, minimum],
            components,
            offsets,
        })
    }

    #[test]
    fn a_continuous_camera_preserves_the_measured_gap() {
        let clock = clock(vec![0, 0, 0, 0], vec![3.0, 19.5, 0.0, 22.0], 0.0).unwrap();
        assert_eq!(clock.starts, [0.0, 16.5, -3.0, 19.0]);
        assert_eq!(clock.duration, 26.5);
    }

    #[test]
    fn unconnected_takes_use_chronology_and_an_explicit_gap() {
        let clock = clock(vec![0, 1, 0, 1], vec![0.0, 4.0, -2.0, 5.0], 2.5).unwrap();
        assert_eq!(clock.starts, [0.0, 14.5, -2.0, 15.5]);
    }

    #[test]
    fn rejects_reversed_recordings_and_cameras_without_a_reference() {
        assert!(clock(vec![0, 0, 0, 0], vec![16.5, 0.0, -3.0, 0.0], 0.0).is_none());
        assert!(clock(vec![0, 0, 0, 3], vec![0.0, 16.5, -3.0, 0.0], 0.0).is_none());
    }
}
