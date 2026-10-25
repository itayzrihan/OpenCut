//! Conservative camera/person filename evidence; synchronization always uses sound.
use bridge::export;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedPodcastSource {
    pub id: String,
    pub name: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastCameraSuggestionsOptions {
    pub cameras: Vec<NamedPodcastSource>,
    #[serde(default)]
    pub microphone_labels: Vec<NamedPodcastSource>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodcastAngleGroup {
    pub id: String,
    pub channel_ids: Vec<String>,
    pub preferred_channel_id: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastCameraSuggestion {
    pub camera_ids: Vec<String>,
    pub preferred_camera_id: String,
    pub microphone_ids: Vec<String>,
    pub evidence: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastCameraSuggestions {
    pub groups: Vec<PodcastCameraSuggestion>,
    pub issues: Vec<String>,
}
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<_> = b.chars().collect();
    let mut row: Vec<_> = (0..=b.len()).collect();
    for (i, x) in a.chars().enumerate() {
        let mut next = vec![i + 1];
        for (j, y) in b.iter().enumerate() {
            next.push(
                (row[j + 1] + 1)
                    .min(next[j] + 1)
                    .min(row[j] + usize::from(x != *y)),
            );
        }
        row = next;
    }
    row[b.len()]
}
fn words(name: &str) -> Vec<String> {
    let stem = name.rsplit_once('.').map_or(name, |p| p.0).to_lowercase();
    let s = stem.trim_start_matches(|c: char| c.is_ascii_digit() || !c.is_alphanumeric());
    let prefix = s.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let s = if prefix <= 4 && s.chars().nth(prefix).is_some_and(|c| c.is_ascii_digit()) {
        s[prefix..].trim_start_matches(|c: char| c.is_ascii_digit() || !c.is_alphanumeric())
    } else {
        s
    };
    s.split(|c: char| !c.is_alphabetic())
        .filter_map(|word| {
            let mut w = word.to_owned();
            // Split a misspelled angle suffix even when joined to the subject.
            if let Some((at, _)) = word
                .char_indices()
                .skip(3)
                .filter_map(|(at, _)| {
                    let suffix = &word[at..];
                    let d = distance(suffix, "angle");
                    ((4..=6).contains(&suffix.len()) && d <= 2).then_some((at, d))
                })
                .min_by_key(|(_, d)| *d)
            {
                w = word[..at].into();
            }
            if w.chars().count() < 3
                || [
                    "main", "camera", "video", "front", "wide", "close", "shot", "primary", "cam",
                    "audio", "mic",
                ]
                .contains(&w.as_str())
                || (w.len() <= 6 && distance(&w, "angle") <= 2)
            {
                return None;
            }
            if ["שלישיה", "שלישייה", "shlishya", "shlishiya", "shlishia"].contains(&w.as_str())
            {
                w = "trio".into();
            }
            Some(w)
        })
        .collect()
}
fn affinity(a: &str, b: &str) -> Option<String> {
    for x in words(a) {
        for y in words(b) {
            let length = x.chars().count().max(y.chars().count());
            if x == y || (length >= 5 && distance(&x, &y) <= if length >= 9 { 2 } else { 1 }) {
                return Some(format!("Shared person/group name: {x} / {y}"));
            }
        }
    }
    None
}
fn main_angle(name: &str) -> bool {
    name.to_lowercase()
        .split(|c: char| !c.is_alphabetic())
        .any(|w| {
            w == "main"
                || w == "primary"
                || w == "ראשית"
                || w == "ראשי"
                || w.starts_with("mainangle")
        })
}
#[export]
pub fn suggest_podcast_camera_groups(
    o: PodcastCameraSuggestionsOptions,
) -> PodcastCameraSuggestions {
    let mut result = PodcastCameraSuggestions {
        groups: vec![],
        issues: vec![],
    };
    if o.cameras.is_empty()
        || o.cameras.len() > 32
        || o.microphone_labels.len() > 4
        || o.cameras
            .iter()
            .any(|c| c.id.is_empty() || c.name.len() > 1024)
        || o.cameras
            .iter()
            .map(|c| &c.id)
            .collect::<HashSet<_>>()
            .len()
            != o.cameras.len()
    {
        result
            .issues
            .push("Choose 1..32 unique physical cameras and up to four microphone labels".into());
        return result;
    }
    let mut groups: Vec<Vec<&NamedPodcastSource>> = vec![];
    for camera in &o.cameras {
        let candidates: Vec<_> = groups
            .iter()
            .enumerate()
            .filter(|(_, group)| {
                group
                    .iter()
                    .all(|c| affinity(&c.name, &camera.name).is_some())
            })
            .map(|(i, _)| i)
            .collect();
        if candidates.len() == 1 {
            groups[candidates[0]].push(camera);
        } else {
            groups.push(vec![camera]);
        }
    }
    for group in groups {
        let mains: Vec<_> = group.iter().filter(|c| main_angle(&c.name)).collect();
        let preferred = if mains.len() == 1 { mains[0] } else { group[0] };
        let microphones = o
            .microphone_labels
            .iter()
            .filter(|m| group.iter().all(|c| affinity(&c.name, &m.name).is_some()))
            .map(|m| m.id.clone())
            .collect();
        let evidence = if group.len() > 1 {
            affinity(&group[0].name, &group[1].name).unwrap()
        } else {
            "Single camera; no related angle inferred".into()
        };
        result.groups.push(PodcastCameraSuggestion {
            camera_ids: group.iter().map(|c| c.id.clone()).collect(),
            preferred_camera_id: preferred.id.clone(),
            microphone_ids: microphones,
            evidence,
        });
    }
    // A microphone matching several groups has no unambiguous automatic binding.
    let all: Vec<_> = result
        .groups
        .iter()
        .flat_map(|g| g.microphone_ids.clone())
        .collect();
    for group in &mut result.groups {
        group
            .microphone_ids
            .retain(|id| all.iter().filter(|x| *x == id).count() == 1);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    fn source(id: &str, name: &str) -> NamedPodcastSource {
        NamedPodcastSource {
            id: id.into(),
            name: name.into(),
        }
    }
    #[test]
    fn real_names_ignore_numeric_prefixes_and_angle_spelling() {
        let r = suggest_podcast_camera_groups(PodcastCameraSuggestionsOptions {
            cameras: vec![
                source("alt", "C7458Shlishiyaangle1.MP4"),
                source("main", "C7458Shlishya Main Angle.MP4"),
                source("single", "C7460Avihay.MP4"),
            ],
            microphone_labels: vec![source("mic1", "Shlishya1"), source("mic4", "Avihay")],
        });
        assert!(r.issues.is_empty());
        assert_eq!(r.groups.len(), 2);
        assert_eq!(r.groups[0].camera_ids, vec!["alt", "main"]);
        assert_eq!(r.groups[0].preferred_camera_id, "main");
        assert_eq!(r.groups[0].microphone_ids, vec!["mic1"]);
        assert_eq!(r.groups[1].microphone_ids, vec!["mic4"]);
    }
    #[test]
    fn generic_camera_words_and_shared_clip_numbers_never_group_strangers() {
        let r = suggest_podcast_camera_groups(PodcastCameraSuggestionsOptions {
            cameras: vec![
                source("a", "C7458Alice Main Angle.MP4"),
                source("b", "C7458Robert Angel.MP4"),
                source("c", "Camera 3.MP4"),
            ],
            microphone_labels: vec![],
        });
        assert_eq!(r.groups.len(), 3);
    }
}

#[cfg(test)]
mod angle_routing_tests {
    #[test]
    fn main_dominates_but_a_shared_alternate_breaks_a_long_turn() {
        let options = serde_json::json!({"envelopes":[vec![0.8;6500],vec![0.0;6500]],"channelIds":["alt","single","main"],"duration":65.,"settings":crate::podcast_multicam_defaults(crate::PodcastMulticamDefaultsOptions{quick:true}),"advanced":{"microphoneIds":["trio","host"],"cameras":[{"channelId":"alt","microphoneIds":["trio"]},{"channelId":"main","microphoneIds":["trio"]},{"channelId":"single","microphoneIds":["host"]}],"angleGroups":[{"id":"trio-angles","channelIds":["main","alt"],"preferredChannelId":"main"}]}});
        let cuts = crate::analyze_podcast_multicam(serde_json::from_value(options).unwrap());
        assert_eq!(
            cuts.iter()
                .map(|c| c.channel_id.as_str())
                .collect::<Vec<_>>(),
            vec!["main", "alt", "main", "alt", "main"]
        );
        assert_eq!(cuts[0].duration, 20.);
        assert_eq!(cuts[1].duration, 5.);
    }
}
