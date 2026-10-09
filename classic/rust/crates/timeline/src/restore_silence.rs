//! Classic-only source-gap restoration. One full-fidelity source transaction
//! keeps the selected video, caption timing and all companion layers together.
use crate::{
    CanonicalizeTimelineSourceDocumentOptions, ClipAudioTimingOptions,
    canonicalize_timeline_source_document, resolve_clip_audio_timing,
};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
const TICKS: f64 = 120_000.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSilenceOptions {
    pub source_json: String,
    pub track_id: String,
    pub element_ids: Vec<String>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSilenceResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub restored_duration: i64,
    pub restored_gap_count: usize,
    pub restored_intervals: Vec<RestoredSilenceInterval>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSilenceInterval {
    pub track_id: String,
    pub element_id: String,
    pub media_id: String,
    pub start_time: i64,
    pub end_time: i64,
    pub source_start: i64,
    pub source_end: i64,
    pub playback_rate: f64,
    #[serde(default)]
    pub audio_source_start: Option<i64>,
    #[serde(default)]
    pub audio_source_end: Option<i64>,
    #[serde(default)]
    pub audio_start_time: Option<i64>,
}
#[export]
pub fn restore_silence(options: RestoreSilenceOptions) -> RestoreSilenceResult {
    match compile(options) {
        Ok(result) => result,
        Err(error) => RestoreSilenceResult {
            valid: false,
            source_json: String::new(),
            error,
            restored_duration: 0,
            restored_gap_count: 0,
            restored_intervals: Vec::new(),
        },
    }
}
fn ticks(v: &Value, key: &str) -> Result<i64, String> {
    v[key]
        .as_i64()
        .filter(|n| *n >= 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn rate(v: &Value) -> Result<f64, String> {
    let r = &v["retime"];
    // Variable speed/freeze/reverse has no single invertible source gap.
    if r.is_object()
        && r.as_object()
            .unwrap()
            .iter()
            .any(|(k, v)| k != "rate" && k != "maintainPitch" && !v.is_null() && v != &json!(false))
    {
        return Err("Restore silence requires constant forward playback".into());
    }
    let rate = r["rate"].as_f64().unwrap_or(1.0);
    if !rate.is_finite() || rate <= 0.0 || rate > 5.0 {
        return Err("Invalid playback rate".into());
    }
    Ok(rate)
}
fn compile(options: RestoreSilenceOptions) -> Result<RestoreSilenceResult, String> {
    let canonical =
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: options.source_json,
        });
    if !canonical.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value =
        serde_json::from_str(&canonical.formatted_json).map_err(|e| e.to_string())?;
    let ids: HashSet<_> = options.element_ids.iter().cloned().collect();
    if ids.len() < 2 || ids.len() != options.element_ids.len() {
        return Err("Select at least two adjacent video clips".into());
    }
    let tracks = doc["scene"]["tracks"].as_array().ok_or("Missing tracks")?;
    let track = tracks
        .iter()
        .find(|t| t["id"] == options.track_id)
        .ok_or("Track not found")?;
    if track["type"] != "video" || track["locked"] == true {
        return Err("Select clips on one unlocked video track".into());
    }
    let mut elements: Vec<_> = track["elements"]
        .as_array()
        .ok_or("Missing elements")?
        .iter()
        .collect();
    elements.sort_by_key(|e| e["startTime"].as_i64().unwrap_or(0));
    let selected: Vec<_> = elements
        .iter()
        .enumerate()
        .filter(|(_, e)| e["id"].as_str().is_some_and(|id| ids.contains(id)))
        .collect();
    if selected.len() != ids.len() {
        return Err("Some selected clips no longer exist".into());
    }
    let mut edits = Vec::new();
    let mut restored_intervals = Vec::new();
    let mut accumulated = 0i64;
    for pair in selected.windows(2) {
        let (li, l) = pair[0];
        let (ri, r) = pair[1];
        if ri != li + 1 || l["type"] != "video" || r["type"] != "video" {
            return Err("Select consecutive video clips on one track".into());
        }
        if l["mediaId"].as_str().is_none() || l["mediaId"] != r["mediaId"] {
            return Err("Selected clips must come from the same source video".into());
        }
        let cut = ticks(l, "startTime")?
            .checked_add(ticks(l, "duration")?)
            .ok_or("Time overflow")?;
        if (cut - ticks(r, "startTime")?).abs() > 1 {
            return Err("Selected clips must touch without gaps or overlaps".into());
        }
        let lr = rate(l)?;
        let rr = rate(r)?;
        if (lr - rr).abs() > 1e-9 {
            return Err("Selected clips must have the same playback rate".into());
        }
        let source_end =
            ticks(l, "trimStart")? + (ticks(l, "duration")? as f64 * lr).round() as i64;
        let gap = ticks(r, "trimStart")? - source_end;
        if gap < -1 {
            return Err("Selected source ranges overlap or run backwards".into());
        }
        if gap <= 1 {
            continue;
        }
        if ticks(l, "trimEnd")? + 1 < gap {
            return Err("The source media has insufficient trim handles".into());
        }
        let inserted = (gap as f64 / lr).round() as i64;
        if inserted <= 0 {
            continue;
        }
        edits.push((
            cut,
            inserted,
            gap,
            l["id"].as_str().ok_or("Missing clip id")?.to_owned(),
        ));
        let start_time = cut.checked_add(accumulated).ok_or("Time overflow")?;
        let audio = resolve_clip_audio_timing(ClipAudioTimingOptions {
            start_time: start_time as f64 / TICKS,
            duration: inserted as f64 / TICKS,
            trim_start: source_end as f64 / TICKS,
            rate: lr,
            offset_seconds: l["params"]["audioSyncOffset"].as_f64().unwrap_or(0.0),
        });
        restored_intervals.push(RestoredSilenceInterval {
            track_id: options.track_id.clone(),
            element_id: l["id"].as_str().unwrap().to_owned(),
            media_id: l["mediaId"].as_str().unwrap().to_owned(),
            start_time,
            end_time: start_time.checked_add(inserted).ok_or("Time overflow")?,
            source_start: source_end,
            source_end: source_end.checked_add(gap).ok_or("Time overflow")?,
            playback_rate: lr,
            audio_source_start: Some((audio.trim_start * TICKS).round() as i64),
            audio_source_end: Some(
                ((audio.trim_start + audio.duration * lr) * TICKS).round() as i64
            ),
            audio_start_time: Some((audio.start_time * TICKS).round() as i64),
        });
        accumulated = accumulated.checked_add(inserted).ok_or("Time overflow")?;
    }
    if edits.is_empty() {
        return Err("No removed source time between the selected clips".into());
    }
    let restored_duration = edits
        .iter()
        .try_fold(0i64, |s, e| s.checked_add(e.1))
        .ok_or("Time overflow")?;
    // Reverse order keeps every insertion in the original timeline coordinates.
    for (cut, inserted, gap, left_id) in edits.iter().rev() {
        for track in doc["scene"]["tracks"].as_array_mut().unwrap() {
            for e in track["elements"].as_array_mut().ok_or("Missing elements")? {
                let start = ticks(e, "startTime")?;
                let duration = ticks(e, "duration")?;
                let end = start.checked_add(duration).ok_or("Time overflow")?;
                let left = e["id"] == *left_id;
                let new_start = map(start, *cut, *inserted, true)?;
                let new_end = if duration == 0 {
                    new_start
                } else if left {
                    end.checked_add(*inserted).ok_or("Time overflow")?
                } else {
                    map(end, *cut, *inserted, false)?
                };
                // Map timed text and keyframes in absolute time, then back to local time.
                if let Some(words) = e.get_mut("wordRuns").and_then(Value::as_array_mut) {
                    for w in words {
                        for (key, right) in [("startTime", true), ("endTime", false)] {
                            if let Some(t) = w[key].as_i64() {
                                w[key] = json!(map(start + t, *cut, *inserted, right)? - new_start);
                            }
                        }
                    }
                }
                if let Some(animations) = e.get_mut("animations") {
                    map_keys(animations, start, new_start, *cut, *inserted, end > *cut)?;
                }
                if let Some(effects) = e.get_mut("effects").and_then(Value::as_array_mut) {
                    for effect in effects {
                        if let Some(animations) = effect.get_mut("animations") {
                            map_keys(animations, start, new_start, *cut, *inserted, end > *cut)?;
                        }
                    }
                }
                e["startTime"] = json!(new_start);
                e["duration"] = json!(new_end - new_start);
                if left {
                    e["trimEnd"] = json!((ticks(e, "trimEnd")? - gap).max(0));
                }
            }
            if let Some(words) = track
                .get_mut("captionSource")
                .and_then(|s| s.get_mut("words"))
                .and_then(Value::as_array_mut)
            {
                for w in words {
                    for (key, right) in [("start", true), ("end", false)] {
                        let seconds = w[key].as_f64().ok_or("Invalid caption time")?;
                        if !seconds.is_finite() || seconds < 0.0 {
                            return Err("Invalid caption time".into());
                        }
                        w[key] = json!(
                            map((seconds * TICKS).round() as i64, *cut, *inserted, right)? as f64
                                / TICKS
                        );
                    }
                }
            }
        }
        if let Some(bookmarks) = doc["scene"]["bookmarks"].as_array_mut() {
            for b in bookmarks {
                let start = ticks(b, "time")?;
                let new_start = map(start, *cut, *inserted, true)?;
                if let Some(d) = b["duration"].as_i64() {
                    b["duration"] = json!(if d == 0 {
                        0
                    } else {
                        map(start + d, *cut, *inserted, false)? - new_start
                    });
                }
                b["time"] = json!(new_start);
            }
        }
    }
    let result = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: doc.to_string(),
    });
    if !result.valid {
        return Err("Restored timeline failed validation".into());
    }
    Ok(RestoreSilenceResult {
        valid: true,
        source_json: result.formatted_json,
        error: String::new(),
        restored_duration,
        restored_gap_count: edits.len(),
        restored_intervals,
    })
}
fn map(t: i64, cut: i64, delta: i64, right: bool) -> Result<i64, String> {
    let n = if t > cut || (right && t == cut) {
        t.checked_add(delta).ok_or("Time overflow")?
    } else {
        t
    };
    if n < 0 || n > 9_007_199_254_740_991 {
        return Err("Time overflow".into());
    }
    Ok(n)
}
fn map_keys(
    v: &mut Value,
    old_start: i64,
    new_start: i64,
    cut: i64,
    delta: i64,
    spans: bool,
) -> Result<(), String> {
    match v {
        Value::Object(o) => {
            if let Some(keys) = o.get_mut("keys").and_then(Value::as_array_mut) {
                for key in keys {
                    let t = ticks(key, "time")?;
                    key["time"] = json!(map(old_start + t, cut, delta, spans)? - new_start);
                }
            } else {
                for child in o.values_mut() {
                    map_keys(child, old_start, new_start, cut, delta, spans)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clip(id: &str, start: i64, source: i64) -> Value {
        json!({"id":id,"name":id,"type":"video","mediaId":"media","startTime":start*120000,"duration":120000,"trimStart":source*120000,"trimEnd":(20-source-1)*120000,"params":{"scale":1.7}})
    }
    fn source() -> Value {
        json!({"schemaVersion":2,"scene":{"id":"s","bookmarks":[{"time":240000,"note":"cue"}],"tracks":[
        {"id":"main","type":"video","area":"main","elements":[clip("a",0,1),clip("b",1,3),clip("c",2,6),clip("d",3,8),clip("e",4,10)]},
        {"id":"text","type":"text","area":"overlay","captionSource":{"words":[{"text":"one","start":0.8,"end":1.0},{"text":"two","start":1.0,"end":1.5},{"text":"three","start":2.0,"end":2.5}],"settings":{}},"elements":[
        {"id":"caption","type":"text","startTime":0,"duration":360000,"trimStart":0,"trimEnd":0,"wordRuns":[{"text":"one","startTime":96000,"endTime":120000},{"text":"two","startTime":120000,"endTime":180000}],"animations":{"opacity":{"keys":[{"id":"k","time":240000,"value":1}]}},"params":{"content":"one two"}},
        {"id":"later","type":"text","startTime":480000,"duration":120000,"trimStart":0,"trimEnd":0,"params":{"content":"later"}}
        ]},
        {"id":"effect","type":"effect","area":"overlay","elements":[{"id":"fx","type":"effect","startTime":0,"duration":600000,"trimStart":0,"trimEnd":0}]},
        {"id":"audio","type":"audio","area":"audio","elements":[{"id":"sound","type":"audio","startTime":240000,"duration":120000,"trimStart":0,"trimEnd":600000}]}
        ]}})
    }
    fn run(doc: Value, ids: &[&str]) -> RestoreSilenceResult {
        restore_silence(RestoreSilenceOptions {
            source_json: doc.to_string(),
            track_id: "main".into(),
            element_ids: ids.iter().map(|s| s.to_string()).collect(),
        })
    }
    #[test]
    fn restores_only_internal_gap_and_preserves_source_positions() {
        let original = source();
        let result = run(original.clone(), &["b", "a"]);
        assert!(result.valid, "{}", result.error);
        assert_eq!(result.restored_duration, 120000);
        assert_eq!(result.restored_gap_count, 1);
        let d: Value = serde_json::from_str(&result.source_json).unwrap();
        let v = &d["scene"]["tracks"][0]["elements"];
        assert_eq!(v[0]["startTime"], 0);
        assert_eq!(v[0]["trimStart"], 120000);
        assert_eq!(v[0]["duration"], 240000);
        assert_eq!(v[0]["trimEnd"], 2040000);
        assert_eq!(v[1]["startTime"], 240000);
        assert_eq!(v[1]["trimStart"], 360000);
        assert_eq!(v[1]["duration"], 120000);
        assert_eq!(v[2]["startTime"], 360000);
        assert_eq!(v[2]["trimStart"], 720000);
        assert!(v[0].get("animations").is_none());
        assert!(d["scene"]["tracks"][0].get("captionSource").is_none());
    }
    #[test]
    fn restores_four_adjacent_clips_in_one_mapping() {
        let r = run(source(), &["a", "b", "c", "d"]);
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.restored_duration, 480000);
        assert_eq!(r.restored_gap_count, 3);
        assert_eq!(
            r.restored_intervals
                .iter()
                .map(|g| (g.start_time, g.end_time, g.source_start, g.source_end))
                .collect::<Vec<_>>(),
            vec![
                (120000, 240000, 240000, 360000),
                (360000, 600000, 480000, 720000),
                (720000, 840000, 840000, 960000)
            ]
        );
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        let tracks = &d["scene"]["tracks"];
        let v = &tracks[0]["elements"];
        assert_eq!(v[0]["duration"], 240000);
        assert_eq!(v[1]["startTime"], 240000);
        assert_eq!(v[1]["duration"], 360000);
        assert_eq!(v[2]["startTime"], 600000);
        assert_eq!(v[3]["startTime"], 840000);
        assert_eq!(v[4]["startTime"], 960000);
        let text = &tracks[1];
        assert_eq!(text["captionSource"]["words"][0]["end"], 1.0);
        assert_eq!(text["captionSource"]["words"][1]["start"], 2.0);
        assert_eq!(text["captionSource"]["words"][2]["start"], 5.0);
        assert_eq!(text["elements"][0]["wordRuns"][0]["endTime"], 120000);
        assert_eq!(text["elements"][0]["wordRuns"][1]["startTime"], 240000);
        assert_eq!(
            text["elements"][0]["animations"]["opacity"]["keys"][0]["time"],
            600000
        );
        assert_eq!(tracks[2]["elements"][0]["duration"], 1080000);
        assert_eq!(tracks[3]["elements"][0]["startTime"], 600000);
        assert_eq!(d["scene"]["bookmarks"][0]["time"], 600000);
    }
    #[test]
    fn rejects_invalid_selections_atomically() {
        for ids in [
            vec!["a"],
            vec!["a", "c"],
            vec!["a", "missing"],
            vec!["a", "a"],
        ] {
            let r = run(source(), &ids);
            assert!(!r.valid);
            assert!(r.source_json.is_empty());
        }
        for (key, value) in [
            ("mediaId", json!("other")),
            ("startTime", json!(130000)),
            ("trimStart", json!(100000)),
        ] {
            let mut d = source();
            d["scene"]["tracks"][0]["elements"][1][key] = value;
            assert!(!run(d, &["a", "b"]).valid);
        }
    }
    #[test]
    fn supports_constant_speed_and_rejects_missing_handles() {
        let mut d = source();
        for e in d["scene"]["tracks"][0]["elements"].as_array_mut().unwrap() {
            e["retime"] = json!({"rate":0.5,"maintainPitch":true});
        }
        let r = run(d, &["a", "b"]);
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.restored_duration, 360000);
        let mut d = source();
        d["scene"]["tracks"][0]["elements"][0]["trimEnd"] = json!(0);
        assert!(!run(d, &["a", "b"]).valid);
    }
    #[test]
    fn restored_audio_bounds_use_sync_offset_and_pad_missing_source() {
        let mut d = source();
        d["scene"]["tracks"][0]["elements"][0]["params"]["audioSyncOffset"] = json!(-0.25);
        let r = run(d, &["a", "b"]);
        assert!(r.valid);
        let gap = &r.restored_intervals[0];
        assert_eq!(gap.source_start, 240000);
        assert_eq!(gap.audio_source_start, Some(270000));
        assert_eq!(gap.audio_source_end, Some(390000));
        assert_eq!(gap.audio_start_time, Some(120000));
        let mut d = source();
        d["scene"]["tracks"][0]["elements"][0]["params"]["audioSyncOffset"] = json!(2.5);
        let r = run(d, &["a", "b"]);
        assert!(r.valid);
        let gap = &r.restored_intervals[0];
        assert_eq!(gap.audio_start_time, Some(180000));
        assert_eq!(gap.audio_source_start, Some(0));
        assert_eq!(gap.audio_source_end, Some(60000));
    }
    #[test]
    fn repeated_restore_is_a_no_op_and_keeps_outer_trim() {
        let r = run(source(), &["b", "c", "d"]);
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        assert_eq!(
            d["scene"]["tracks"][0]["elements"][0],
            source()["scene"]["tracks"][0]["elements"][0]
        );
        let again = run(d, &["b", "c", "d"]);
        assert!(!again.valid);
        assert!(again.error.contains("No removed"));
    }
}
