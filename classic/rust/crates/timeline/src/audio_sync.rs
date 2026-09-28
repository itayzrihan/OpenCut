//! Classic-only per-element audio timing, shared by playback and export.
use bridge::export;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAudioTimingOptions {
    pub start_time: f64,
    pub duration: f64,
    pub trim_start: f64,
    pub rate: f64,
    /// Timeline seconds: negative advances sound, positive delays it.
    pub offset_seconds: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAudioTiming {
    pub start_time: f64,
    pub duration: f64,
    pub trim_start: f64,
}

#[export]
pub fn resolve_clip_audio_timing(o: ClipAudioTimingOptions) -> ClipAudioTiming {
    let rate = if o.rate.is_finite() && o.rate > 0.0 {
        o.rate.clamp(0.01, 5.0)
    } else {
        1.0
    };
    let offset = if o.offset_seconds.is_finite() {
        o.offset_seconds.clamp(-5.0, 5.0)
    } else {
        0.0
    };
    let source_start = o.trim_start - offset * rate;
    // Missing source before time zero is silence, never a shifted video edit.
    let leading_silence = (-source_start / rate).max(0.0).min(o.duration.max(0.0));
    ClipAudioTiming {
        start_time: o.start_time + leading_silence,
        duration: (o.duration - leading_silence).max(0.0),
        trim_start: source_start.max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn timing(trim: f64, offset: f64, rate: f64) -> ClipAudioTiming {
        resolve_clip_audio_timing(ClipAudioTimingOptions {
            start_time: 10.0,
            duration: 2.0,
            trim_start: trim,
            rate,
            offset_seconds: offset,
        })
    }
    #[test]
    fn advance_reads_later_source_without_moving_clip() {
        let t = timing(4.0, -0.3, 1.0);
        assert_eq!((t.start_time, t.duration, t.trim_start), (10.0, 2.0, 4.3));
    }
    #[test]
    fn advance_preserves_even_a_clip_shorter_than_the_offset() {
        let t = resolve_clip_audio_timing(ClipAudioTimingOptions {
            start_time: 3.0,
            duration: 0.08,
            trim_start: 4.2,
            rate: 1.0,
            offset_seconds: -0.1,
        });
        assert_eq!(t.start_time, 3.0);
        assert_eq!(t.duration, 0.08);
        assert!((t.trim_start - 4.3).abs() < 1e-9);
        // The whole audible interval is beyond the original 4.28s cut.
        assert!(t.trim_start > 4.28);
        assert!((t.trim_start + t.duration - 4.38).abs() < 1e-9);
    }
    #[test]
    fn delay_pads_missing_source_instead_of_clamping_sync() {
        let t = timing(0.1, 0.3, 1.0);
        assert!((t.start_time - 10.2).abs() < 1e-9);
        assert!((t.duration - 1.8).abs() < 1e-9);
        assert_eq!(t.trim_start, 0.0);
    }
    #[test]
    fn offset_is_in_timeline_seconds_at_double_speed() {
        assert_eq!(timing(4.0, -0.3, 2.0).trim_start, 4.6);
    }
    #[test]
    fn zero_offset_and_invalid_offset_preserve_timing() {
        for offset in [0.0, f64::NAN] {
            let t = timing(4.0, offset, 1.0);
            assert_eq!((t.start_time, t.duration, t.trim_start), (10.0, 2.0, 4.0));
        }
        assert_eq!(timing(0.0, 5.0, 1.0).duration, 0.0);
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSyncRetrimOptions {
    pub trim_start: f64,
    pub trim_end: f64,
    pub rate: f64,
    pub requested_offset: f64,
    pub applied_offset: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSyncRetrim {
    pub trim_start: f64,
    pub trim_end: f64,
    pub offset: f64,
}

/// Slip the video source window along with sync, preserving timeline duration.
/// applied_offset tracks the retrim already performed (legacy clips use zero).
#[export]
pub fn resolve_audio_sync_retrim(o: AudioSyncRetrimOptions) -> AudioSyncRetrim {
    let rate = if o.rate.is_finite() && o.rate > 0.0 {
        o.rate.clamp(0.01, 5.0)
    } else {
        1.0
    };
    let requested = if o.requested_offset.is_finite() {
        o.requested_offset.clamp(-5.0, 5.0)
    } else {
        0.0
    };
    let applied = if o.applied_offset.is_finite() {
        o.applied_offset
    } else {
        0.0
    };
    let delta = ((requested - applied) * rate).clamp(-o.trim_start.max(0.0), o.trim_end.max(0.0));
    AudioSyncRetrim {
        trim_start: o.trim_start + delta,
        trim_end: o.trim_end - delta,
        offset: applied + delta / rate,
    }
}

#[cfg(test)]
mod retrim_tests {
    use super::*;
    fn slip(start: f64, end: f64, applied: f64, requested: f64) -> AudioSyncRetrim {
        resolve_audio_sync_retrim(AudioSyncRetrimOptions {
            trim_start: start,
            trim_end: end,
            rate: 1.0,
            requested_offset: requested,
            applied_offset: applied,
        })
    }
    #[test]
    fn advance_adds_head_removes_tail_and_preserves_audio_source() {
        let r = slip(4.0, 2.0, 0.0, -0.1);
        assert!((r.trim_start - 3.9).abs() < 1e-9);
        assert!((r.trim_end - 2.1).abs() < 1e-9);
        assert!((r.trim_start - r.offset - 4.0).abs() < 1e-9);
        let same = slip(r.trim_start, r.trim_end, r.offset, -0.1);
        assert_eq!(same.trim_start, r.trim_start);
        let reset = slip(r.trim_start, r.trim_end, r.offset, 0.0);
        assert!((reset.trim_start - 4.0).abs() < 1e-9);
        assert!((reset.trim_end - 2.0).abs() < 1e-9);
    }
    #[test]
    fn source_boundary_limits_both_offset_and_retrim() {
        let r = slip(0.04, 2.0, 0.0, -0.1);
        assert_eq!(r.trim_start, 0.0);
        assert_eq!(r.offset, -0.04);
    }
}
