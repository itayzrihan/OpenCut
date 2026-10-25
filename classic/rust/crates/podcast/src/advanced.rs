//! Segmented wireless microphone provenance. Filenames are evidence, not a hardware serial.
use bridge::export;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodcastRecording {
    pub media_id: String,
    pub name: String,
    pub duration: f64,
    pub binding_revision: u64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodcastRecordingSegment {
    pub recording: PodcastRecording,
    pub sequence: u32,
    pub start: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodcastMicrophone {
    pub id: String,
    pub name: String,
    pub recorder_token: String,
    pub date: String,
    pub duration: f64,
    pub segments: Vec<PodcastRecordingSegment>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPodcastRecordingsOptions {
    pub recordings: Vec<PodcastRecording>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastRecordingGroups {
    pub microphones: Vec<PodcastMicrophone>,
    pub issues: Vec<String>,
}
// Observed MAX 2 export: YYYYMMDD_HHMM_NNNN_32Float_XXXX.wav.
// Keep tokens intact (including digits); never group by counter or file order.
fn identity(name: &str) -> Option<(String, String, u32, u32)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !ext.eq_ignore_ascii_case("wav") {
        return None;
    }
    let p: Vec<_> = stem.splitn(5, '_').collect();
    if p.len() != 5
        || p[0].len() != 8
        || p[1].len() != 4
        || p[2].len() != 4
        || ![p[0], p[1], p[2]]
            .iter()
            .all(|s| s.bytes().all(|b| b.is_ascii_digit()))
        || !["32Float", "24bit"]
            .iter()
            .any(|s| p[3].eq_ignore_ascii_case(s))
        || p[4].len() < 4
        || p[4].len() > 100
        || !p[4].as_bytes()[..4]
            .iter()
            .all(|b| b.is_ascii_alphanumeric())
        || !p[4][4..]
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ' '))
    {
        return None;
    }
    let year: u32 = p[0][..4].parse().ok()?;
    let month: u32 = p[0][4..6].parse().ok()?;
    let day: u32 = p[0][6..8].parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    let hour: u32 = p[1][..2].parse().ok()?;
    let minute: u32 = p[1][2..].parse().ok()?;
    if year < 2000 || day == 0 || day > days || hour > 23 || minute > 59 {
        return None;
    }
    Some((
        p[0].into(),
        p[4][..4].to_ascii_uppercase(),
        p[2].parse().ok()?,
        hour * 60 + minute,
    ))
}
#[export]
pub fn group_podcast_recordings(o: GroupPodcastRecordingsOptions) -> PodcastRecordingGroups {
    let mut result = PodcastRecordingGroups {
        microphones: vec![],
        issues: vec![],
    };
    if o.recordings.is_empty() || o.recordings.len() > 512 {
        result
            .issues
            .push("Choose 1..512 completed microphone recordings".into());
        return result;
    }
    let mut groups = BTreeMap::<(String, String), Vec<(u32, u32, PodcastRecording)>>::new();
    let mut ids = HashSet::new();
    for r in o.recordings {
        if r.media_id.trim().is_empty()
            || !ids.insert(r.media_id.clone())
            || !r.duration.is_finite()
            || r.duration <= 0.0
            || r.duration > 36000.0
        {
            result
                .issues
                .push(format!("Invalid or duplicate recording: {}", r.name));
            continue;
        }
        if let Some((date, token, seq, minute)) = identity(&r.name) {
            groups
                .entry((date, token))
                .or_default()
                .push((seq, minute, r));
        } else {
            result
                .issues
                .push(format!("Unrecognized recorder filename: {}", r.name));
        }
    }
    if groups.len() > 4 {
        result.issues.push(
            "Advanced Podcast supports at most four microphone streams from one session".into(),
        );
    }
    for ((date, token), mut recordings) in groups {
        recordings.sort_by_key(|r| r.0);
        let mut segments = vec![];
        let mut start = 0.0;
        for (i, (seq, minute, r)) in recordings.iter().enumerate() {
            if i > 0 {
                let (prev_seq, prev_minute, prev) = &recordings[i - 1];
                if *seq != prev_seq + 1 {
                    result.issues.push(format!(
                        "{token}: duplicate or missing segment between {prev_seq:04} and {seq:04}"
                    ));
                }
                // A stopped/restarted take is not a continuous split. Minute precision
                // can only reject clearly inconsistent clocks, never establish sync.
                let elapsed = (*minute as f64 - *prev_minute as f64) * 60.0;
                if (elapsed - prev.duration).abs() > 61.0 || (prev.duration - 1800.0).abs() > 2.0 {
                    result.issues.push(format!(
                        "{token}: continuity needs review before {}",
                        r.name
                    ));
                }
            }
            segments.push(PodcastRecordingSegment {
                recording: r.clone(),
                sequence: *seq,
                start,
            });
            start += r.duration;
        }
        if start > 36000.0 {
            result
                .issues
                .push(format!("{token}: recording exceeds ten hours"));
        }
        let name = format!("Microphone {} · {}", result.microphones.len() + 1, token);
        result.microphones.push(PodcastMicrophone {
            id: format!("{date}-{token}"),
            name,
            recorder_token: token,
            date,
            duration: start,
            segments,
        });
    }
    let dates: HashSet<_> = result.microphones.iter().map(|m| &m.date).collect();
    if dates.len() > 1 {
        result
            .issues
            .push("Multiple recording dates require separate sessions".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rec(token: &str, seq: u32, minute: &str, duration: f64) -> PodcastRecording {
        PodcastRecording {
            media_id: format!("{token}-{seq}"),
            name: format!("20260720_{minute}_{seq:04}_32Float_{token}.wav"),
            duration,
            binding_revision: 0,
        }
    }
    #[test]
    fn independent_counters_and_exact_continuity() {
        let r = group_podcast_recordings(GroupPodcastRecordingsOptions {
            recordings: vec![
                rec("AX5F", 4, "1705", 1800.15),
                rec("9P8H", 5, "1634", 1800.15),
                rec("AX5F", 3, "1635", 1800.15),
                rec("9P8H", 6, "1704", 1800.15),
            ],
        });
        assert!(r.issues.is_empty(), "{:?}", r.issues);
        assert_eq!(r.microphones.len(), 2);
        for m in r.microphones {
            assert_eq!(m.segments[1].start, 1800.15);
            assert_eq!(m.duration, 3600.3);
        }
    }
    #[test]
    fn missing_duplicate_and_restarted_segments_fail_closed() {
        for recordings in [
            vec![
                rec("AX5F", 3, "1635", 1800.15),
                rec("AX5F", 5, "1735", 500.),
            ],
            vec![
                rec("AX5F", 3, "1635", 1800.15),
                rec("AX5F", 3, "1635", 1800.15),
            ],
            vec![rec("AX5F", 3, "1635", 30.), rec("AX5F", 4, "1705", 500.)],
        ] {
            assert!(
                !group_podcast_recordings(GroupPodcastRecordingsOptions { recordings })
                    .issues
                    .is_empty()
            );
        }
    }
    #[test]
    fn appended_person_labels_do_not_change_recorder_identity() {
        for suffix in ["Shlishya1", "Avihay", "_אביחי", "-Host"] {
            let mut r = rec("BCZ9", 3, "1635", 1800.15);
            r.name = r.name.replace("BCZ9.wav", &format!("BCZ9{suffix}.wav"));
            let result = group_podcast_recordings(GroupPodcastRecordingsOptions {
                recordings: vec![r],
            });
            assert!(result.issues.is_empty());
            assert_eq!(result.microphones[0].recorder_token, "BCZ9");
        }
    }
    #[test]
    fn invalid_dates_and_unrecognized_names_are_not_guessed() {
        assert!(identity("20260230_1634_0005_32Float_9P8H.wav").is_none());
        assert!(identity("recording.wav").is_none());
        assert!(identity("20260720_2561_0005_32Float_9P8H.wav").is_none());
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodcastCameraMicrophones {
    pub channel_id: String,
    pub microphone_ids: Vec<String>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvancedPodcastRouting {
    pub microphone_ids: Vec<String>,
    pub cameras: Vec<PodcastCameraMicrophones>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub angle_groups: Vec<crate::PodcastAngleGroup>,
}
impl AdvancedPodcastRouting {
    pub fn validate(&self, camera_ids: &[String]) -> bool {
        let unique: HashSet<_> = self.microphone_ids.iter().collect();
        let mut grouped = HashSet::new();
        let groups_valid = self.angle_groups.len() <= 16
            && self.angle_groups.iter().all(|g| {
                (2..=32).contains(&g.channel_ids.len())
                    && !g.id.trim().is_empty()
                    && g.channel_ids.contains(&g.preferred_channel_id)
                    && g.channel_ids
                        .iter()
                        .all(|id| camera_ids.contains(id) && grouped.insert(id))
                    && g.channel_ids
                        .iter()
                        .filter_map(|id| self.cameras.iter().find(|c| c.channel_id == *id))
                        .map(|c| c.microphone_ids.iter().collect::<HashSet<_>>())
                        .all(|m| {
                            self.cameras
                                .iter()
                                .find(|c| c.channel_id == g.preferred_channel_id)
                                .is_some_and(|c| {
                                    c.microphone_ids.iter().collect::<HashSet<_>>() == m
                                })
                        })
            });
        groups_valid
            && !unique.is_empty()
            && unique.len() <= 4
            && unique.len() == self.microphone_ids.len()
            && !self.microphone_ids.iter().any(|id| id.trim().is_empty())
            && self.cameras.len() == camera_ids.len()
            && self
                .cameras
                .iter()
                .map(|c| &c.channel_id)
                .collect::<HashSet<_>>()
                .len()
                == camera_ids.len()
            && self.cameras.iter().all(|c| {
                camera_ids.contains(&c.channel_id)
                    && !c.microphone_ids.is_empty()
                    && c.microphone_ids.iter().collect::<HashSet<_>>().len()
                        == c.microphone_ids.len()
                    && c.microphone_ids
                        .iter()
                        .all(|id| self.microphone_ids.contains(id))
            })
            && self
                .microphone_ids
                .iter()
                .all(|id| self.cameras.iter().any(|c| c.microphone_ids.contains(id)))
    }
}
// Preserve relative local dominance instead of interpreting strong room bleed as
// simultaneous speakers. A robust per-recorder peak reference compensates gain;
// close energy ties retain the current owner. This is acoustic evidence, not diarization.
pub(crate) fn advanced_camera_timeline(
    envelopes: &[Vec<f32>],
    mapping: &AdvancedPodcastRouting,
    camera_ids: &[String],
    frames: usize,
) -> Vec<Vec<f32>> {
    let scales: Vec<_> = envelopes
        .iter()
        .map(|e| {
            let mut active: Vec<_> = e[..frames].iter().copied().filter(|v| *v > 1e-9).collect();
            if active.is_empty() {
                return 1.0;
            }
            let i = ((active.len() - 1) as f64 * 0.95).round() as usize;
            active.select_nth_unstable_by(i, f32::total_cmp);
            active[i].max(1e-9)
        })
        .collect();
    let mut owner = 0;
    (0..frames)
        .map(|frame| {
            let energy: Vec<_> = envelopes
                .iter()
                .zip(&scales)
                .map(|(e, s)| e[frame] / s)
                .collect();
            let best = energy
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|x| x.0)
                .unwrap_or(0);
            if energy[best] > 0.05 && (energy[owner] < 0.05 || energy[best] > energy[owner] * 1.12)
            {
                owner = best;
            }
            camera_ids
                .iter()
                .map(|id| {
                    if energy[owner] > 0.05
                        && mapping.cameras.iter().any(|c| {
                            &c.channel_id == id
                                && c.microphone_ids.contains(&mapping.microphone_ids[owner])
                        })
                    {
                        if mapping
                            .angle_groups
                            .iter()
                            .any(|g| g.channel_ids.contains(id) && g.preferred_channel_id != *id)
                        {
                            0.8
                        } else {
                            1.0
                        }
                    } else {
                        0.0
                    }
                })
                .collect()
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct AdvancedPodcastCameraClockOptions {
    pub sources: Vec<crate::CameraSource>,
    pub microphones: Vec<crate::CameraSource>,
}
/// Omit camera-only leader/tail; keep early/later participants on a shared clock.
#[export]
pub fn advanced_podcast_camera_clock(
    o: AdvancedPodcastCameraClockOptions,
) -> Option<crate::CameraClock> {
    let mut clock = crate::podcast_camera_clock(crate::CameraClockOptions { sources: o.sources })?;
    if o.microphones.is_empty()
        || o.microphones.len() > 4
        || o.microphones.iter().any(|s| {
            s.id.is_empty()
                || !s.start.is_finite()
                || !s.duration.is_finite()
                || s.duration <= 0.0
                || s.duration > 36000.0
                || s.start.abs() > 36000.0
        })
    {
        return None;
    }
    let start = o
        .microphones
        .iter()
        .map(|s| s.start)
        .min_by(f64::total_cmp)?
        .max(clock.origin);
    let end = o
        .microphones
        .iter()
        .map(|s| s.start + s.duration)
        .max_by(f64::total_cmp)?
        .min(clock.origin + clock.duration);
    if end <= start {
        return None;
    }
    clock.origin = start;
    clock.duration = end - start;
    Some(clock)
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    fn source(id: &str, start: f64, duration: f64) -> crate::CameraSource {
        crate::CameraSource {
            id: id.into(),
            start,
            duration,
            binding_revision: 0,
        }
    }
    #[test]
    fn camera_only_leader_is_not_a_silent_podcast_intro() {
        let c = advanced_podcast_camera_clock(AdvancedPodcastCameraClockOptions {
            sources: vec![source("cam", 0., 4445.28)],
            microphones: vec![
                source("9P8H", 230.97, 4225.54),
                source("AHQC", 274.24, 4181.76),
            ],
        })
        .unwrap();
        assert!((c.origin - 230.97).abs() < 1e-6);
        assert!((c.duration - 4214.31).abs() < 1e-6);
        assert!(
            advanced_podcast_camera_clock(AdvancedPodcastCameraClockOptions {
                sources: vec![source("cam", 0., 100.)],
                microphones: vec![source("mic", 200., 100.)]
            })
            .is_none()
        );
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    #[test]
    fn four_high_bleed_mics_can_share_two_cameras_and_use_a_third() {
        let microphone_ids: Vec<String> = (1..=4).map(|i| format!("mic{i}")).collect();
        let cameras = vec![
            PodcastCameraMicrophones {
                channel_id: "wide1".into(),
                microphone_ids: microphone_ids[..3].to_vec(),
            },
            PodcastCameraMicrophones {
                channel_id: "wide2".into(),
                microphone_ids: microphone_ids[..3].to_vec(),
            },
            PodcastCameraMicrophones {
                channel_id: "single".into(),
                microphone_ids: vec!["mic4".into()],
            },
        ];
        let mut envelopes = vec![vec![0.65; 1600]; 4];
        for mic in 0..4 {
            for v in &mut envelopes[mic][mic * 400..(mic + 1) * 400] {
                *v = 0.8;
            }
        }
        // Different recorder gain must not become a permanent speaker bias.
        for v in &mut envelopes[1] {
            *v *= 4.0;
        }
        let cuts = crate::analyze_podcast_multicam(crate::AnalyzePodcastOptions {
            envelopes,
            channel_ids: vec!["wide1".into(), "wide2".into(), "single".into()],
            duration: 16.,
            settings: crate::podcast_multicam_defaults(crate::PodcastMulticamDefaultsOptions {
                quick: true,
            }),
            camera_windows: vec![],
            advanced: Some(AdvancedPodcastRouting {
                microphone_ids,
                cameras,
                angle_groups: vec![],
            }),
        });
        assert_eq!(
            cuts.len(),
            2,
            "Shared microphones should not force extra camera switches"
        );
        assert_eq!(cuts[0].channel_id, "wide1");
        assert_eq!(cuts[1].channel_id, "single");
        assert!((cuts.iter().map(|c| c.duration).sum::<f64>() - 16.).abs() < 1e-6);
    }
}
