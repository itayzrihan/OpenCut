//! Additive gap transcription. The browser supplies source-time words; Rust
//! decides membership, deduplicates and carries the nearby caption treatment.
use crate::{
    CanonicalizeTimelineSourceDocumentOptions, CaptionWord, RemoveCaptionWordTimeRangesOptions,
    RestoredSilenceInterval, canonicalize_timeline_source_document,
    realign_caption_words_after_time_removal,
};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;
const TICKS: f64 = 120_000.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSilenceCaptionsOptions {
    pub source_json: String,
    pub intervals_json: String,
    pub transcripts_json: String,
    pub id_prefix: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSilenceCaptionsResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub inserted_word_count: usize,
    pub inserted_caption_count: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    interval_index: usize,
    words: Vec<Word>,
}
#[derive(Clone, Deserialize)]
struct Word {
    text: String,
    start: f64,
    end: f64,
}

#[export]
pub fn restore_silence_captions(
    options: RestoreSilenceCaptionsOptions,
) -> RestoreSilenceCaptionsResult {
    match compile(options) {
        Ok(result) => result,
        Err(error) => RestoreSilenceCaptionsResult {
            valid: false,
            source_json: String::new(),
            error,
            inserted_word_count: 0,
            inserted_caption_count: 0,
        },
    }
}
fn canonical(source: String) -> Result<Value, String> {
    let r = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: source,
    });
    if !r.valid {
        return Err("Invalid timeline source".into());
    }
    serde_json::from_str(&r.formatted_json).map_err(|e| e.to_string())
}
fn span(e: &Value) -> (i64, i64) {
    let start = e["startTime"].as_i64().unwrap_or(0);
    (start, start + e["duration"].as_i64().unwrap_or(0))
}
fn distance(e: &Value, at: i64) -> i64 {
    let (s, e) = span(e);
    if at < s {
        s - at
    } else if at > e {
        at - e
    } else {
        0
    }
}
fn same_source(a: &Value, b: &Value) -> bool {
    if a["sourceId"].is_string() || b["sourceId"].is_string() {
        a["sourceId"] == b["sourceId"]
    } else {
        a["words"] == b["words"] && a["settings"] == b["settings"]
    }
}
fn display_word(text: &str, hide: bool) -> String {
    if !hide {
        return text.trim().to_owned();
    }
    static PUNCTUATION: OnceLock<regex::Regex> = OnceLock::new();
    PUNCTUATION
        .get_or_init(|| {
            regex::Regex::new(r"[\p{P}&&[^?¿؟？]]").expect("constant Unicode punctuation pattern")
        })
        .replace_all(text, "")
        .trim()
        .to_owned()
}
fn rescale_keys(v: &mut Value, old: i64, new: i64, prefix: &str) {
    match v {
        Value::Object(o) => {
            if let Some(keys) = o.get_mut("keys").and_then(Value::as_array_mut) {
                for (i, key) in keys.iter_mut().enumerate() {
                    if let Some(t) = key["time"].as_i64() {
                        key["time"] = json!(
                            ((t as f64 * new as f64 / old.max(1) as f64).round() as i64)
                                .clamp(0, new)
                        );
                    }
                    key["id"] = json!(format!("{prefix}:key:{i}"));
                    for side in ["leftHandle", "rightHandle"] {
                        if let Some(dt) = key[side]["dt"].as_f64() {
                            key[side]["dt"] = json!(dt * new as f64 / old.max(1) as f64);
                        }
                    }
                }
            } else {
                for child in o.values_mut() {
                    rescale_keys(child, old, new, prefix);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                rescale_keys(item, old, new, prefix);
            }
        }
        _ => {}
    }
}
// Insert a scalar boundary without changing the curve on either side. Bezier
// handles use time/value offsets, so de Casteljau preserves custom opacity edits.
fn opacity_boundary(
    keys: &mut Vec<Value>,
    time: i64,
    fallback: f64,
    id: &str,
    extrapolation: &Value,
) {
    keys.sort_by_key(|k| k["time"].as_i64().unwrap_or(0));
    if keys.iter().any(|k| k["time"] == time) {
        return;
    }
    let right = keys
        .iter()
        .position(|k| k["time"].as_i64().unwrap_or(0) > time)
        .unwrap_or(keys.len());
    let mut boundary = json!({"id":id,"time":time,"value":fallback,"segmentToNext":"linear","tangentMode":"broken"});
    if right == 0 {
        boundary["value"] = keys
            .first()
            .map(|k| k["value"].clone())
            .unwrap_or(json!(fallback));
        if extrapolation["before"] == "linear" && keys.len() > 1 {
            let a = &keys[0];
            let b = &keys[1];
            let at = a["time"].as_f64().unwrap();
            let bt = b["time"].as_f64().unwrap();
            let av = a["value"].as_f64().unwrap_or(fallback);
            let bv = b["value"].as_f64().unwrap_or(fallback);
            boundary["value"] = json!(av + (time as f64 - at) / (bt - at) * (bv - av));
        }
    } else if right == keys.len() {
        boundary["value"] = keys[right - 1]["value"].clone();
        if extrapolation["after"] == "linear" && keys.len() > 1 {
            let a = &keys[right - 1];
            let b = &keys[right - 2];
            let at = a["time"].as_f64().unwrap();
            let bt = b["time"].as_f64().unwrap();
            let av = a["value"].as_f64().unwrap_or(fallback);
            let bv = b["value"].as_f64().unwrap_or(fallback);
            boundary["value"] = json!(av + (time as f64 - at) / (bt - at) * (bv - av));
        }
    } else {
        let left = keys[right - 1].clone();
        let next = keys[right].clone();
        let x0 = left["time"].as_f64().unwrap();
        let x3 = next["time"].as_f64().unwrap();
        let y0 = left["value"].as_f64().unwrap_or(fallback);
        let y3 = next["value"].as_f64().unwrap_or(fallback);
        let mode = left["segmentToNext"].as_str().unwrap_or("linear");
        boundary["segmentToNext"] = json!(mode);
        if mode == "step" {
            boundary["value"] = json!(y0);
        } else if mode == "bezier" {
            let p0 = (x0, y0);
            let p3 = (x3, y3);
            let p1 = (
                x0 + left["rightHandle"]["dt"]
                    .as_f64()
                    .unwrap_or((x3 - x0) / 3.0)
                    .clamp(0.0, x3 - x0),
                y0 + left["rightHandle"]["dv"]
                    .as_f64()
                    .unwrap_or((y3 - y0) / 3.0),
            );
            let p2 = (
                x3 + next["leftHandle"]["dt"]
                    .as_f64()
                    .unwrap_or(-(x3 - x0) / 3.0)
                    .clamp(-(x3 - x0), 0.0),
                y3 + next["leftHandle"]["dv"]
                    .as_f64()
                    .unwrap_or(-(y3 - y0) / 3.0),
            );
            let mix = |a: (f64, f64), b: (f64, f64), u: f64| {
                (a.0 + (b.0 - a.0) * u, a.1 + (b.1 - a.1) * u)
            };
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..40 {
                let u = (lo + hi) * 0.5;
                let a = mix(p0, p1, u);
                let b = mix(p1, p2, u);
                let c = mix(p2, p3, u);
                let d = mix(a, b, u);
                let e = mix(b, c, u);
                if mix(d, e, u).0 < time as f64 {
                    lo = u;
                } else {
                    hi = u;
                }
            }
            let u = (lo + hi) * 0.5;
            let a = mix(p0, p1, u);
            let b = mix(p1, p2, u);
            let c = mix(p2, p3, u);
            let d = mix(a, b, u);
            let e = mix(b, c, u);
            let p = mix(d, e, u);
            let handle =
                |a: (f64, f64), b: (f64, f64)| json!({"dt":(a.0-b.0).round() as i64,"dv":a.1-b.1});
            keys[right - 1]["rightHandle"] = handle(a, p0);
            keys[right]["leftHandle"] = handle(c, p3);
            boundary["leftHandle"] = handle(d, p);
            boundary["rightHandle"] = handle(e, p);
            boundary["value"] = json!(p.1);
        } else {
            boundary["value"] = json!(y0 + (y3 - y0) * (time as f64 - x0) / (x3 - x0));
        }
    }
    keys.insert(right, boundary);
}
fn hide_existing_caption_in_gap(element: &mut Value, start: i64, end: i64, id: &str) {
    let (old_start, old_end) = span(element);
    if old_end <= start || old_start >= end {
        return;
    }
    let from = (start - old_start).max(0);
    let to = (end - old_start).min(old_end - old_start);
    let opacity = element["params"]["opacity"].as_f64().unwrap_or(1.0);
    if !element["animations"].is_object() {
        element["animations"] = json!({});
    }
    if !element["animations"]["opacity"].is_object() {
        element["animations"]["opacity"] = json!({"keys":[]});
    }
    let channel = &mut element["animations"]["opacity"];
    if !channel["keys"].is_array() {
        channel["keys"] = json!([]);
    }
    let extrapolation = channel["extrapolation"].clone();
    let keys = channel["keys"].as_array_mut().unwrap();
    // Anchor both clip edges before inserting the hole. Otherwise the new zero
    // key would change the slope used by linear extrapolation outside the gap.
    opacity_boundary(
        keys,
        0,
        opacity,
        &format!("{id}:clip-start"),
        &extrapolation,
    );
    opacity_boundary(
        keys,
        old_end - old_start,
        opacity,
        &format!("{id}:clip-end"),
        &extrapolation,
    );
    if from > 0 {
        opacity_boundary(
            keys,
            from - 1,
            opacity,
            &format!("{id}:before"),
            &extrapolation,
        );
    }
    opacity_boundary(keys, to, opacity, &format!("{id}:after"), &extrapolation);
    keys.retain(|k| {
        let t = k["time"].as_i64().unwrap_or(0);
        t < from || t >= to
    });
    if let Some(key) = keys.iter_mut().find(|k| k["time"] == from - 1) {
        key["segmentToNext"] = json!("step");
    }
    keys.push(json!({"id":format!("{id}:hidden"),"time":from,"value":0,"segmentToNext":"step","tangentMode":"broken"}));
    keys.sort_by_key(|k| k["time"].as_i64().unwrap_or(0));
}
fn prepare_caption(
    template: &Value,
    words: &[Word],
    start: i64,
    end: i64,
    words_per_row: usize,
    hide: bool,
    id: &str,
) -> Value {
    let mut e = template.clone();
    let old_duration = e["duration"].as_i64().unwrap_or(1).max(1);
    let duration = end - start;
    e["id"] = json!(id);
    e["startTime"] = json!(start);
    e["duration"] = json!(duration);
    e["trimStart"] = json!(0);
    e["trimEnd"] = json!(0);
    let rendered: Vec<_> = words.iter().map(|w| display_word(&w.text, hide)).collect();
    let content = rendered
        .chunks(words_per_row)
        .map(|line| line.join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    e["params"]["content"] = json!(content);
    e["name"] = json!(content);
    if e["responsiveText"].is_object() {
        e["responsiveText"]["sourceContent"] = json!(content);
        e["responsiveText"]["generatedContent"] = json!(content);
    }
    let old_runs = template["wordRuns"].as_array();
    e["wordRuns"] = json!(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let mut run = old_runs
                    .and_then(|r| r.get(i).or(r.first()))
                    .cloned()
                    .unwrap_or(json!({}));
                run["id"] = json!(format!("{id}:word:{i}"));
                run["text"] = json!(rendered[i]);
                run["lineIndex"] = json!(i / words_per_row);
                run["startTime"] =
                    json!(((w.start * TICKS).round() as i64 - start).clamp(0, duration));
                run["endTime"] = json!(((w.end * TICKS).round() as i64 - start).clamp(0, duration));
                run
            })
            .collect::<Vec<_>>()
    );
    for key in ["animations", "effects", "loop"] {
        if let Some(v) = e.get_mut(key) {
            rescale_keys(v, old_duration, duration, id);
        }
    }
    for side in ["in", "out"] {
        if let Some(t) = e.get_mut("transitions").and_then(|v| v.get_mut(side)) {
            let old = t["duration"].as_i64().unwrap_or(0);
            let d = ((old as f64 * duration as f64 / old_duration as f64).round() as i64)
                .clamp(0, duration / 2);
            t["id"] = json!(format!("{id}:{side}"));
            t["duration"] = json!(d);
            t["startTime"] = json!(if side == "out" { duration - d } else { 0 });
        }
    }
    // This is a new caption using the chosen treatment, not the original AI operation.
    e.as_object_mut()
        .unwrap()
        .remove("automaticTextTransitions");
    e.as_object_mut().unwrap().remove("automaticWordAnimation");
    e
}
fn compile(options: RestoreSilenceCaptionsOptions) -> Result<RestoreSilenceCaptionsResult, String> {
    if options.id_prefix.is_empty() || options.id_prefix.len() > 120 {
        return Err("Invalid caption request ID".into());
    }
    let mut doc = canonical(options.source_json)?;
    let intervals: Vec<RestoredSilenceInterval> =
        serde_json::from_str(&options.intervals_json).map_err(|e| e.to_string())?;
    let transcripts: Vec<Transcript> =
        serde_json::from_str(&options.transcripts_json).map_err(|e| e.to_string())?;
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;
    // Treatment selection is based on the pre-repair edit, so a visibility mask
    // inserted for one gap cannot be copied into a caption for a later gap.
    let style_tracks = tracks.clone();
    let mut inserted_word_count = 0;
    let mut inserted_caption_count = 0;
    for transcript in transcripts {
        let gap = intervals
            .get(transcript.interval_index)
            .ok_or("Unknown restored interval")?;
        if gap.start_time < 0
            || gap.end_time <= gap.start_time
            || gap.source_start < 0
            || gap.source_end <= gap.source_start
            || !gap.playback_rate.is_finite()
            || gap.playback_rate <= 0.0
        {
            return Err("Invalid restored interval".into());
        }
        let source_clip = tracks
            .iter()
            .find(|t| t["id"] == gap.track_id)
            .and_then(|t| t["elements"].as_array())
            .and_then(|es| es.iter().find(|e| e["id"] == gap.element_id))
            .ok_or("Restored clip no longer exists")?;
        let (clip_start, clip_end) = span(source_clip);
        if source_clip["mediaId"] != gap.media_id
            || clip_start > gap.start_time
            || clip_end < gap.end_time
        {
            return Err("Restored interval no longer matches its clip".into());
        }
        let (target_index, template) = style_tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                t["type"] == "text"
                    && t["locked"] != true
                    && t["hidden"] != true
                    && t["captionSource"].is_object()
            })
            .flat_map(|(i, t)| {
                t["elements"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|e| e["hidden"] != true)
                    .map(move |e| (i, e))
            })
            .min_by_key(|(_, e)| distance(e, gap.start_time))
            .map(|(i, e)| (i, e.clone()))
            .ok_or("No existing caption style is available for this scene")?;
        let source = tracks[target_index]["captionSource"].clone();
        let settings = &source["settings"];
        let words_per_row = settings["wordsPerRow"].as_u64().unwrap_or(4).clamp(1, 12) as usize;
        let rows = settings["rows"].as_u64().unwrap_or(1).clamp(1, 4) as usize;
        let hide = settings["hidePunctuation"].as_bool().unwrap_or(true);
        let family: Vec<_> = tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t["type"] == "text" && same_source(&t["captionSource"], &source))
            .map(|(i, _)| i)
            .collect();
        if family.iter().any(|i| tracks[*i]["locked"] == true) {
            return Err("Unlock the caption tracks before filling restored speech".into());
        }
        let mut existing = source["words"].as_array().cloned().unwrap_or_default();
        let existing_spans: Vec<_> = existing
            .iter()
            .filter_map(|w| w["start"].as_f64().zip(w["end"].as_f64()))
            .collect();
        let mut words = Vec::new();
        let audio_start = gap.audio_source_start.unwrap_or(gap.source_start);
        let audio_end = gap.audio_source_end.unwrap_or(gap.source_end);
        let audio_at = gap.audio_start_time.unwrap_or(gap.start_time);
        if audio_start < 0
            || audio_end < audio_start
            || audio_at < gap.start_time
            || audio_at > gap.end_time
        {
            return Err("Invalid restored audio interval".into());
        }
        for word in transcript.words {
            if !word.start.is_finite()
                || !word.end.is_finite()
                || word.end <= word.start
                || word.text.trim().is_empty()
            {
                continue;
            }
            let center = (word.start + word.end) * 0.5 * TICKS;
            if center < audio_start as f64 || center >= audio_end as f64 {
                continue;
            }
            let start = (audio_at as f64
                + (word.start * TICKS - audio_start as f64) / gap.playback_rate)
                .max(audio_at as f64)
                / TICKS;
            let end = (audio_at as f64
                + (word.end * TICKS - audio_start as f64) / gap.playback_rate)
                .min(gap.end_time as f64)
                / TICKS;
            if end <= start || display_word(&word.text, hide).is_empty() {
                continue;
            }
            // Existing words win, including manual corrections and timing changes.
            if existing_spans.iter().any(|(s, e)| start < *e && end > *s)
                || words
                    .iter()
                    .any(|w: &Word| w.text == word.text.trim() && start < w.end && end > w.start)
            {
                continue;
            }
            let word = Word {
                text: word.text.trim().into(),
                start,
                end,
            };
            words.push(word);
        }
        words = realign_caption_words_after_time_removal(RemoveCaptionWordTimeRangesOptions {
            words: words
                .into_iter()
                .map(|w| CaptionWord {
                    text: w.text,
                    start: w.start,
                    end: w.end,
                    source: None,
                })
                .collect(),
            ranges: Vec::new(),
        })
        .into_iter()
        .map(|w| Word {
            text: w.text,
            start: w.start,
            end: w.end,
        })
        .collect();
        if words.is_empty() {
            continue;
        }
        for word in &words {
            if word.start < audio_at as f64 / TICKS
                || word.end > gap.end_time as f64 / TICKS
                || existing_spans
                    .iter()
                    .any(|(s, e)| word.start < *e && word.end > *s)
            {
                return Err("Overlapping transcription timings could not be placed safely; existing captions were preserved".into());
            }
            existing.push(json!({"text":word.text,"start":word.start,"end":word.end}));
        }
        inserted_word_count += words.len();
        let mut chunks: Vec<Vec<Word>> = Vec::new();
        for word in words {
            let split = chunks.last().is_none_or(|chunk| {
                chunk.len() >= words_per_row * rows
                    || chunk.last().is_some_and(|last| {
                        existing_spans
                            .iter()
                            .any(|(s, e)| *s < word.start && *e > last.end)
                    })
            });
            if split {
                chunks.push(Vec::new());
            }
            chunks.last_mut().unwrap().push(word);
        }
        // Do not regenerate old captions: their content, local edits and keyframes survive.
        for (chunk_index, chunk) in chunks.iter().enumerate() {
            let first = chunk.first().unwrap();
            let last = chunk.last().unwrap();
            let raw_duration = last.end - first.start;
            let padding_in = settings["inPaddingPercent"]
                .as_f64()
                .unwrap_or(0.0)
                .clamp(0.0, 100.0)
                / 100.0;
            let padding_out = settings["outPaddingPercent"]
                .as_f64()
                .unwrap_or(0.0)
                .clamp(0.0, 100.0)
                / 100.0;
            let previous_end = existing_spans
                .iter()
                .filter(|(_, e)| *e <= first.start)
                .map(|(_, e)| (*e * TICKS).round() as i64)
                .max()
                .unwrap_or(gap.start_time);
            let next_start = existing_spans
                .iter()
                .filter(|(s, _)| *s >= last.end)
                .map(|(s, _)| (*s * TICKS).round() as i64)
                .min()
                .unwrap_or(gap.end_time);
            let previous_new_end = chunk_index
                .checked_sub(1)
                .and_then(|i| chunks[i].last())
                .map(|w| (w.end * TICKS).round() as i64)
                .unwrap_or(gap.start_time);
            let next_new_start = chunks
                .get(chunk_index + 1)
                .and_then(|c| c.first())
                .map(|w| (w.start * TICKS).round() as i64)
                .unwrap_or(gap.end_time);
            let start = (((first.start - raw_duration * padding_in) * TICKS).round() as i64)
                .max(gap.start_time)
                .max(previous_end)
                .max(previous_new_end);
            let end = (((last.end + raw_duration * padding_out) * TICKS).round() as i64)
                .min(gap.end_time)
                .min(next_start)
                .min(next_new_start);
            let id = format!(
                "{}:{}:{chunk_index}",
                options.id_prefix, transcript.interval_index
            );
            if end <= start {
                return Err("Invalid caption timing; existing captions were preserved".into());
            }
            let caption = prepare_caption(&template, chunk, start, end, words_per_row, hide, &id);
            let template_start = span(&template).0;
            let template_duration = template["duration"].as_i64().unwrap_or(1).max(1);
            // Preserve matched transition sounds already chosen for this caption.
            let mut typing_copied = false;
            for (audio_track_index, track) in tracks
                .iter_mut()
                .enumerate()
                .filter(|(_, t)| t["type"] == "audio" && t["locked"] != true)
            {
                let elements = track["elements"]
                    .as_array_mut()
                    .ok_or("Missing audio elements")?;
                let sounds: Vec<_> = elements
                    .iter()
                    .filter(|s| {
                        s["params"]["opencut.textTransitionSfx.textElementId"] == template["id"]
                            || s["params"]["opencut.typingRevealSfx.textElementId"]
                                == template["id"]
                    })
                    .cloned()
                    .collect();
                for (sound_index, mut sound) in sounds.into_iter().enumerate() {
                    if sound["params"]["opencut.typingRevealSfx.textElementId"] == template["id"] {
                        if typing_copied {
                            continue;
                        }
                        typing_copied = true;
                        let source_duration =
                            sound["sourceDuration"].as_i64().unwrap_or_else(|| {
                                sound["trimStart"].as_i64().unwrap_or(0)
                                    + sound["duration"].as_i64().unwrap_or(0)
                                    + sound["trimEnd"].as_i64().unwrap_or(0)
                            });
                        if source_duration <= 0 {
                            continue;
                        }
                        for (word_index, run) in caption["wordRuns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .enumerate()
                        {
                            let row_mode = caption["textRowOverrides"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .find(|row| row["lineIndex"] == run["lineIndex"])
                                .and_then(|row| row["revealMode"].as_str());
                            let reveal = run["revealMode"]
                                .as_str()
                                .or(row_mode)
                                .or(caption["captionRevealMode"].as_str());
                            if reveal != Some("letter-by-letter") {
                                continue;
                            }
                            let mut at = start + run["startTime"].as_i64().unwrap_or(0);
                            let until = (start + run["endTime"].as_i64().unwrap_or(0)).min(end);
                            let mut segment = 0;
                            while at < until {
                                let duration = (until - at).min(source_duration);
                                let mut typing = sound.clone();
                                typing["id"] = json!(format!(
                                    "{id}:typing:{audio_track_index}:{word_index}:{segment}"
                                ));
                                typing["startTime"] = json!(at);
                                typing["duration"] = json!(duration);
                                typing["trimStart"] = json!(0);
                                typing["trimEnd"] = json!(source_duration - duration);
                                typing["params"]["opencut.typingRevealSfx.textElementId"] =
                                    json!(id);
                                typing["params"]["opencut.typingRevealSfx.segmentIndex"] =
                                    json!(segment);
                                typing
                                    .as_object_mut()
                                    .unwrap()
                                    .remove("automaticWordAnimationOwner");
                                elements.push(typing);
                                at += duration;
                                segment += 1;
                            }
                        }
                        continue;
                    }
                    let (old_start, old_end) = span(&sound);
                    let desired = start
                        + ((old_start - template_start) as f64 * (end - start) as f64
                            / template_duration as f64)
                            .round() as i64;
                    let sound_start = desired.max(gap.start_time);
                    let sound_end = (desired + old_end - old_start).min(gap.end_time);
                    if sound_end <= sound_start {
                        continue;
                    }
                    sound["id"] = json!(format!("{id}:sfx:{audio_track_index}:{sound_index}"));
                    sound["startTime"] = json!(sound_start);
                    sound["duration"] = json!(sound_end - sound_start);
                    sound["trimStart"] =
                        json!(sound["trimStart"].as_i64().unwrap_or(0) + sound_start - desired);
                    sound["trimEnd"] = json!(
                        sound["trimEnd"].as_i64().unwrap_or(0)
                            + (desired + old_end - old_start - sound_end)
                    );
                    sound["params"]["opencut.textTransitionSfx.textElementId"] = json!(id);
                    sound
                        .as_object_mut()
                        .unwrap()
                        .remove("automaticTextTransitionsOwner");
                    elements.push(sound);
                }
            }
            // Restoration can stretch a row-mode caption over the returned gap.
            // Hide only that blank portion; keep its words, style and animation
            // curves outside the new caption intact instead of rebuilding it.
            for index in &family {
                for element in tracks[*index]["elements"]
                    .as_array_mut()
                    .ok_or("Missing caption elements")?
                {
                    if !element["id"]
                        .as_str()
                        .is_some_and(|s| s.starts_with(&options.id_prefix))
                    {
                        hide_existing_caption_in_gap(element, start, end, &id);
                    }
                }
            }
            // Pick a free existing layer where possible. No existing layer is overwritten.
            let target = family
                .iter()
                .copied()
                .find(|i| {
                    if tracks[*i]["hidden"] == true || tracks[*i]["locked"] == true {
                        return false;
                    }
                    tracks[*i]["elements"].as_array().is_some_and(|es| {
                        es.iter().all(|e| {
                            let (s, e) = span(e);
                            e <= start || s >= end
                        })
                    })
                })
                .unwrap_or(target_index);
            tracks[target]["elements"]
                .as_array_mut()
                .ok_or("Missing caption elements")?
                .push(caption);
            inserted_caption_count += 1;
        }
        existing.sort_by(|a, b| {
            a["start"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["start"].as_f64().unwrap_or(0.0))
        });
        for index in family {
            tracks[index]["captionSource"]["words"] = json!(existing);
        }
    }
    let source = canonical(doc.to_string())?;
    Ok(RestoreSilenceCaptionsResult {
        valid: true,
        source_json: source.to_string(),
        error: String::new(),
        inserted_word_count,
        inserted_caption_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"schemaVersion":2,"scene":{"id":"scene","tracks":[
            {"id":"video","type":"video","area":"main","elements":[{"id":"clip","type":"video","mediaId":"media","startTime":0,"duration":360000,"trimStart":120000,"trimEnd":0}]},
            {"id":"captions","type":"text","area":"overlay","captionSource":{"sourceId":"source","settings":{"wordsPerRow":2,"rows":1,"hidePunctuation":true,"transitionIn":"blur","wordAnimationId":"zoom","wordDirection":"rtl"},"words":[{"text":"edited","start":0.2,"end":0.8,"excludeFromPunctuationHiding":true},{"text":"after","start":2.2,"end":2.8}]},"elements":[{"id":"original","type":"text","startTime":0,"duration":360000,"trimStart":0,"trimEnd":0,"params":{"content":"edited after","fontFamily":"Assistant","fontSize":7,"color":"#abc123","opacity":0.8},"captionRevealMode":"row","captionWordAnimationId":"zoom","captionGlowerEnabled":true,"captionTransitionIn":"blur","captionWordDirection":"rtl","wordRuns":[{"id":"a","text":"edited","startTime":24000,"endTime":96000,"style":{"fontWeight":"bold"}},{"id":"b","text":"after","startTime":264000,"endTime":336000}],"transitions":{"in":{"id":"ti","presetId":"zoom","placement":"in","duration":36000,"startTime":0}},"animations":{"transform.scaleX":{"keys":[{"id":"k","time":180000,"value":1.2,"segmentToNext":"linear"}]}}}]},
            {"id":"sound","type":"audio","area":"audio","elements":[{"id":"sfx","type":"audio","sourceType":"library","libraryAssetId":"whoosh","startTime":0,"duration":12000,"trimStart":0,"trimEnd":12000,"params":{"opencut.textTransitionSfx.textElementId":"original","volume":-24}}]}
        ]}})
    }
    fn gap() -> Value {
        json!([{"trackId":"video","elementId":"clip","mediaId":"media","startTime":120000,"endTime":240000,"sourceStart":240000,"sourceEnd":360000,"playbackRate":1}])
    }
    fn run(source: Value, words: Value) -> RestoreSilenceCaptionsResult {
        restore_silence_captions(RestoreSilenceCaptionsOptions {
            source_json: source.to_string(),
            intervals_json: gap().to_string(),
            transcripts_json: json!([{"intervalIndex":0,"words":words}]).to_string(),
            id_prefix: "restore-caption-test".into(),
        })
    }
    #[test]
    fn fills_only_gap_and_keeps_manual_words_style_features_and_matched_sound() {
        let before = fixture();
        let r = run(
            before.clone(),
            json!([{"text":"context before","start":1.0,"end":1.9},{"text":"missing,","start":2.1,"end":2.4},{"text":"quiet","start":2.5,"end":2.8},{"text":"context after","start":3.1,"end":3.4}]),
        );
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.inserted_word_count, 2);
        assert_eq!(r.inserted_caption_count, 1);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        let tracks = &d["scene"]["tracks"];
        assert_eq!(tracks[0], before["scene"]["tracks"][0]);
        let text = &tracks[1];
        let old = &text["elements"][0];
        let new = &text["elements"][1];
        assert_eq!(
            old["params"],
            before["scene"]["tracks"][1]["elements"][0]["params"]
        );
        assert_eq!(
            old["wordRuns"],
            before["scene"]["tracks"][1]["elements"][0]["wordRuns"]
        );
        assert_eq!(
            text["captionSource"]["words"][0],
            before["scene"]["tracks"][1]["captionSource"]["words"][0]
        );
        assert_eq!(
            text["captionSource"]["settings"],
            before["scene"]["tracks"][1]["captionSource"]["settings"]
        );
        assert_eq!(new["params"]["content"], "missing quiet");
        assert_eq!(new["params"]["color"], "#abc123");
        assert_eq!(new["captionGlowerEnabled"], true);
        assert_eq!(new["captionWordAnimationId"], "zoom");
        assert_eq!(new["transitions"]["in"]["presetId"], "zoom");
        assert_eq!(new["transitions"]["in"]["duration"], 8400);
        assert_eq!(
            new["animations"]["transform.scaleX"]["keys"][0]["time"],
            42000
        );
        assert_eq!(new["wordRuns"][0]["style"]["fontWeight"], "bold");
        assert_eq!(tracks[2]["elements"].as_array().unwrap().len(), 2);
        assert_eq!(
            tracks[2]["elements"][1]["params"]["opencut.textTransitionSfx.textElementId"],
            new["id"]
        );
        assert!(
            old["animations"]["opacity"]["keys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["time"] == 132000 && k["value"] == 0)
        );
        let again = run(
            d,
            json!([{"text":"missing","start":2.1,"end":2.4},{"text":"quiet","start":2.5,"end":2.8}]),
        );
        assert!(again.valid);
        assert_eq!(again.inserted_word_count, 0);
    }
    #[test]
    fn maps_speed_and_clips_boundary_words_without_adding_context_or_replacing_existing_words() {
        let mut doc = fixture();
        doc["scene"]["tracks"][1]["captionSource"]["words"]
            .as_array_mut()
            .unwrap()
            .push(json!({"text":"manual","start":1.5,"end":1.8}));
        let mut intervals = gap();
        intervals[0]["playbackRate"] = json!(2);
        intervals[0]["sourceEnd"] = json!(480000);
        let r=restore_silence_captions(RestoreSilenceCaptionsOptions {source_json:doc.to_string(),intervals_json:intervals.to_string(),transcripts_json:json!([{"intervalIndex":0,"words":[{"text":"boundary","start":1.9,"end":2.2},{"text":"duplicate","start":3.1,"end":3.5},{"text":"outside","start":4.1,"end":4.5}]}]).to_string(),id_prefix:"gap-speed".into()});
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.inserted_word_count, 1);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        let words = d["scene"]["tracks"][1]["captionSource"]["words"]
            .as_array()
            .unwrap();
        assert!(
            words
                .iter()
                .any(|w| w["text"] == "boundary" && w["start"] == 1.0 && w["end"] == 1.1)
        );
        assert!(words.iter().any(|w| w["text"] == "manual"));
    }
    #[test]
    fn empty_speech_is_no_op_and_locked_or_stale_source_is_rejected_atomically() {
        let r = run(fixture(), json!([]));
        assert!(r.valid);
        assert_eq!(r.inserted_caption_count, 0);
        let mut doc = fixture();
        doc["scene"]["tracks"][0]["elements"][0]["duration"] = json!(100000);
        let r = run(doc, json!([]));
        assert!(!r.valid);
        assert!(r.source_json.is_empty());
        let mut doc = fixture();
        doc["scene"]["tracks"][1]["locked"] = json!(true);
        assert!(!run(doc, json!([{"text":"word","start":2.1,"end":2.4}])).valid);
    }
    #[test]
    fn opacity_gap_preserves_custom_curve_anchors_and_restores_visibility() {
        let mut e = json!({"startTime":0,"duration":360000,"params":{"opacity":1},"animations":{"opacity":{"keys":[{"id":"left","time":0,"value":0.2,"segmentToNext":"bezier","rightHandle":{"dt":120000,"dv":0.4}},{"id":"right","time":360000,"value":0.8,"leftHandle":{"dt":-120000,"dv":-0.2},"segmentToNext":"linear"}]}}});
        hide_existing_caption_in_gap(&mut e, 120000, 240000, "gap");
        let keys = e["animations"]["opacity"]["keys"].as_array().unwrap();
        assert_eq!(keys.first().unwrap()["id"], "left");
        assert_eq!(keys.last().unwrap()["id"], "right");
        assert!(keys.iter().any(|k| k["time"] == 120000 && k["value"] == 0));
        assert!(
            keys.iter()
                .any(|k| k["time"] == 240000 && k["value"].as_f64().unwrap() > 0.2)
        );
    }
    #[test]
    fn manual_word_splits_new_captions_and_hidden_sibling_cannot_receive_them() {
        let mut doc = fixture();
        let text = &mut doc["scene"]["tracks"][1];
        text["captionSource"]["words"]
            .as_array_mut()
            .unwrap()
            .push(json!({"text":"manual","start":1.4,"end":1.6}));
        text["captionSource"]["settings"]["inPaddingPercent"] = json!(100);
        text["captionSource"]["settings"]["outPaddingPercent"] = json!(100);
        let mut hidden = text.clone();
        hidden["id"] = json!("hidden");
        hidden["hidden"] = json!(true);
        hidden["elements"] = json!([]);
        doc["scene"]["tracks"].as_array_mut().unwrap().push(hidden);
        let result = run(
            doc,
            json!([{"text":"left","start":2.1,"end":2.3},{"text":"old","start":2.4,"end":2.6},{"text":"right","start":2.7,"end":2.9}]),
        );
        assert!(result.valid, "{}", result.error);
        assert_eq!(result.inserted_word_count, 2);
        assert_eq!(result.inserted_caption_count, 2);
        let doc: Value = serde_json::from_str(&result.source_json).unwrap();
        let es = doc["scene"]["tracks"][1]["elements"].as_array().unwrap();
        assert_eq!(es.len(), 3);
        assert!(span(&es[1]).1 <= 168000);
        assert!(span(&es[2]).0 >= 192000);
        assert!(
            doc["scene"]["tracks"][3]["elements"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let opacity = es[0]["animations"]["opacity"]["keys"].as_array().unwrap();
        let active = opacity
            .iter()
            .rev()
            .find(|k| k["time"].as_i64().unwrap() <= 180000)
            .unwrap();
        assert_eq!(active["value"], 0.8);
    }
    #[test]
    fn later_gap_does_not_inherit_earlier_visibility_masks() {
        let mut intervals = gap();
        intervals.as_array_mut().unwrap().push(json!({"trackId":"video","elementId":"clip","mediaId":"media","startTime":240000,"endTime":360000,"sourceStart":360000,"sourceEnd":480000,"playbackRate":1}));
        let result=restore_silence_captions(RestoreSilenceCaptionsOptions {source_json:fixture().to_string(),intervals_json:intervals.to_string(),transcripts_json:json!([{"intervalIndex":0,"words":[{"text":"first","start":2.1,"end":2.4}]},{"intervalIndex":1,"words":[{"text":"second","start":3.85,"end":3.95}]}]).to_string(),id_prefix:"restore-caption-many".into()});
        assert!(result.valid, "{}", result.error);
        assert_eq!(result.inserted_caption_count, 2);
        let doc: Value = serde_json::from_str(&result.source_json).unwrap();
        let captions = doc["scene"]["tracks"][1]["elements"].as_array().unwrap();
        assert!(captions[1]["animations"].get("opacity").is_none());
        assert!(captions[2]["animations"].get("opacity").is_none());
    }
    #[test]
    fn typing_sound_follows_new_word_bounds_and_transition_sounds_have_unique_ids_across_tracks() {
        let mut doc = fixture();
        doc["scene"]["tracks"][1]["elements"][0]["wordRuns"][0]["revealMode"] =
            json!("letter-by-letter");
        let mut extra = doc["scene"]["tracks"][2].clone();
        extra["id"] = json!("second-sound-track");
        extra["elements"][0]["id"] = json!("second-sfx");
        doc["scene"]["tracks"].as_array_mut().unwrap().push(extra);
        doc["scene"]["tracks"][2]["elements"].as_array_mut().unwrap().push(json!({"id":"typing","type":"audio","sourceType":"library","libraryAssetId":"typing-asset","startTime":24000,"duration":72000,"trimStart":0,"trimEnd":1800000,"sourceDuration":1872000,"params":{"opencut.typingRevealSfx.textElementId":"original","volume":-5}}));
        let result = run(
            doc,
            json!([{"text":"typed","start":2.1,"end":2.4},{"text":"plain","start":2.5,"end":2.8}]),
        );
        assert!(result.valid, "{}", result.error);
        let doc: Value = serde_json::from_str(&result.source_json).unwrap();
        let tracks = doc["scene"]["tracks"].as_array().unwrap();
        let typing = tracks[2]["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"].as_str().unwrap().contains(":typing:"))
            .unwrap();
        assert_eq!(typing["startTime"], 132000);
        assert_eq!(typing["duration"], 36000);
        let ids: Vec<_> = tracks
            .iter()
            .flat_map(|t| t["elements"].as_array().unwrap())
            .filter_map(|e| e["id"].as_str())
            .collect();
        assert_eq!(
            ids.len(),
            ids.iter().collect::<std::collections::HashSet<_>>().len()
        );
    }
    #[test]
    fn hiding_punctuation_keeps_hebrew_marks_symbols_and_questions() {
        assert_eq!(display_word("שָׁלוֹם, $5 🙂?", true), "שָׁלוֹם $5 🙂?");
    }
    #[test]
    fn default_bezier_handles_and_linear_extrapolation_match_existing_renderer() {
        let mut e = json!({"startTime":0,"duration":360000,"params":{"opacity":1},"animations":{"opacity":{"extrapolation":{"before":"linear","after":"linear"},"keys":[{"id":"left","time":120000,"value":0.3,"segmentToNext":"bezier"},{"id":"right","time":240000,"value":0.6,"segmentToNext":"linear"}]}}});
        hide_existing_caption_in_gap(&mut e, 160000, 200000, "gap");
        let keys = e["animations"]["opacity"]["keys"].as_array().unwrap();
        assert!(keys.first().unwrap()["value"].as_f64().unwrap().abs() < 1e-6);
        assert!((keys.last().unwrap()["value"].as_f64().unwrap() - 0.9).abs() < 1e-6);
        assert!(
            (keys.iter().find(|k| k["time"] == 200000).unwrap()["value"]
                .as_f64()
                .unwrap()
                - 0.5)
                .abs()
                < 1e-5
        );
    }
    #[test]
    fn overlapping_incoming_words_are_realigned_without_dropping_words_or_negative_duration() {
        let mut doc = fixture();
        doc["scene"]["tracks"][1]["captionSource"]["settings"]["wordsPerRow"] = json!(1);
        let result = run(
            doc,
            json!([{"text":"long","start":2.1,"end":2.6},{"text":"nested","start":2.5,"end":2.55}]),
        );
        assert!(result.valid, "{}", result.error);
        assert_eq!(result.inserted_word_count, 2);
        assert_eq!(result.inserted_caption_count, 2);
        let doc: Value = serde_json::from_str(&result.source_json).unwrap();
        let es = doc["scene"]["tracks"][1]["elements"].as_array().unwrap();
        assert_eq!(es[1]["duration"], 48000);
        assert_eq!(es[2]["duration"], 6000);
        assert!(span(&es[1]).1 <= span(&es[2]).0);
    }
}
