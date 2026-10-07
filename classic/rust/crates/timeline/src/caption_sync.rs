//! Generated-caption transcript matching. JSON preserves unknown word metadata;
//! the returned index plan lets hosts retain unchanged object identities.
use super::caption_layout::{
    CaptionCuePlanOptions, CaptionLayerOptions, CaptionLayoutWord, allocate_caption_layers,
    build_caption_cue_plan,
};
use super::caption_scene::{caption_source_track_index, caption_source_track_indices};
use bridge::export;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::OnceLock};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTranscriptSyncOptions {
    pub input_json: String,
}
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    id: Option<String>,
    text: String,
    start: f64,
    end: f64,
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn seconds(v: &Value) -> f64 {
    n(v) / 120_000.0
}
fn round(v: f64) -> f64 {
    (v * 1000.0 + 0.5).floor() / 1000.0
}
fn runs(e: &Value) -> &[Value] {
    e["wordRuns"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn timed(r: &Value) -> bool {
    r["startTime"].is_number() && r["endTime"].is_number()
}
fn presentation(e: &Value) -> bool {
    !runs(e).is_empty() && !runs(e).iter().any(timed)
}
fn id(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}
fn content(e: &Value) -> Vec<&str> {
    text(&e["params"]["content"])
        .split(js_whitespace)
        .filter(|v| !v.is_empty())
        .collect()
}
// Match ECMAScript's whitespace set, including BOM and excluding NEL.
pub(super) fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn entries(e: &Value, visual: bool) -> Vec<Entry> {
    let start = seconds(&e["startTime"]);
    if visual || !runs(e).is_empty() {
        return runs(e)
            .iter()
            .filter(|r| {
                if visual {
                    !text(&r["text"]).trim_matches(js_whitespace).is_empty()
                } else {
                    timed(r)
                }
            })
            .map(|r| {
                let s = start + seconds(&r["startTime"]);
                Entry {
                    id: id(&r["id"]),
                    text: text(&r["text"]).to_owned(),
                    start: if visual { 0.0 } else { round(s) },
                    end: if visual {
                        0.0
                    } else {
                        round((start + seconds(&r["endTime"])).max(s + 0.01))
                    },
                }
            })
            .collect();
    }
    let words = content(e);
    let duration = seconds(&e["duration"]);
    words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            let s = start + i as f64 * duration / words.len() as f64;
            Entry {
                id: Some(format!("word-{i}")),
                text: (*word).into(),
                start: round(s),
                end: round((start + (i + 1) as f64 * duration / words.len() as f64).max(s + 0.01)),
            }
        })
        .collect()
}
pub fn strip_caption_punctuation(value: &str) -> String {
    static PATTERNS: OnceLock<[regex::Regex; 4]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"[\p{P}&&[^?¿؟？]]",
            r"[\t\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+",
            r"[ \t]*\n[ \t]*",
            r"\n{3,}",
        ]
        .map(|p| regex::Regex::new(p).expect("constant regex"))
    });
    let mut result = value.to_owned();
    for (pattern, replacement) in patterns.iter().zip(["", " ", "\n", "\n\n"]) {
        result = pattern.replace_all(&result, replacement).into_owned();
    }
    result.trim_matches(js_whitespace).to_owned()
}
fn norm(v: &str) -> String {
    strip_caption_punctuation(v).to_lowercase()
}
fn generated(w: &Value) -> bool {
    w["source"]["type"] != "text-layer"
}
fn source_match(words: &[Value], e: &Entry, used: &HashSet<usize>) -> Option<usize> {
    let value = norm(&e.text);
    let mut best = None;
    let mut score = f64::INFINITY;
    for (i, w) in words.iter().enumerate() {
        if used.contains(&i) || !generated(w) || norm(text(&w["text"])) != value {
            continue;
        }
        let distance = (n(&w["start"]) - e.start).abs() + (n(&w["end"]) - e.end).abs();
        if distance < score {
            score = distance;
            best = Some(i);
        }
    }
    best
}
fn previous_match(
    previous: &[Entry],
    next: &Entry,
    index: usize,
    used: &mut HashSet<usize>,
    visual: bool,
) -> Option<usize> {
    let found = next
        .id
        .as_ref()
        .and_then(|id| {
            previous
                .iter()
                .enumerate()
                .find(|(i, e)| !used.contains(i) && e.id.as_ref() == Some(id))
                .map(|(i, _)| i)
        })
        .or_else(|| (index < previous.len() && !used.contains(&index)).then_some(index))
        .or_else(|| {
            visual
                .then(|| {
                    previous
                        .iter()
                        .enumerate()
                        .find(|(i, e)| !used.contains(i) && norm(&e.text) == norm(&next.text))
                        .map(|(i, _)| i)
                })
                .flatten()
        });
    if let Some(i) = found {
        used.insert(i);
    }
    found
}
fn presentation_map(words: &[Value], items: &[Entry], e: &Value) -> Vec<Option<usize>> {
    let mut used = HashSet::new();
    let mut search_start = 0;
    let s = seconds(&e["startTime"]);
    let end = s + seconds(&e["duration"]);
    items
        .iter()
        .map(|entry| {
            let find = |from| {
                let mut fallback = None;
                for (i, w) in words.iter().enumerate().skip(from) {
                    if used.contains(&i)
                        || !generated(w)
                        || norm(text(&w["text"])) != norm(&entry.text)
                    {
                        continue;
                    }
                    if fallback.is_none() {
                        fallback = Some(i);
                    }
                    let mid = (n(&w["start"]) + n(&w["end"])) / 2.0;
                    if mid >= s - 0.001 && mid <= end + 0.001 {
                        return Some(i);
                    }
                }
                fallback
            };
            let found = find(search_start).or_else(|| find(0));
            if let Some(i) = found {
                used.insert(i);
                search_start = i + 1;
            }
            found
        })
        .collect()
}
fn put(words: &mut [Value], i: usize, entry: &Entry, hide: bool, timing: bool) {
    let current = &mut words[i];
    let retain = hide
        && current["excludeFromPunctuationHiding"] != true
        && strip_caption_punctuation(text(&current["text"]))
            == strip_caption_punctuation(&entry.text);
    if !retain {
        current["text"] = json!(entry.text);
    }
    if timing {
        let start = round(entry.start);
        let end = round(entry.end.max(entry.start + 0.01));
        if n(&current["start"]) != start {
            current["start"] = json!(start);
        }
        if n(&current["end"]) != end {
            current["end"] = json!(end);
        }
    }
}
fn sync_previous(
    words: &[Value],
    previous: &Value,
    next: &Value,
    hide: bool,
    visual: bool,
) -> Vec<Value> {
    let old = entries(previous, visual);
    if old.is_empty() {
        return words.to_vec();
    }
    let new = entries(next, visual);
    let mapping = visual.then(|| presentation_map(words, &old, previous));
    let mut used_old = HashSet::new();
    let mut used_source = HashSet::new();
    let mut result = words.to_vec();
    let mut remove = HashSet::new();
    for (index, entry) in new.iter().enumerate() {
        let Some(old_index) = previous_match(&old, entry, index, &mut used_old, visual) else {
            continue;
        };
        let source = if let Some(mapping) = &mapping {
            mapping[old_index]
        } else {
            source_match(words, &old[old_index], &used_source)
        };
        if let Some(i) = source {
            used_source.insert(i);
            put(&mut result, i, entry, hide, !visual);
        }
    }
    for (index, entry) in old.iter().enumerate() {
        if used_old.contains(&index) {
            continue;
        }
        let source = if let Some(mapping) = &mapping {
            mapping[index]
        } else {
            source_match(words, entry, &used_source)
        };
        if let Some(i) = source {
            used_source.insert(i);
            remove.insert(i);
        }
    }
    result
        .into_iter()
        .enumerate()
        .filter_map(|(i, w)| (!remove.contains(&i)).then_some(w))
        .collect()
}
fn semantically_equal(previous: &Value, next: &Value) -> bool {
    let visual = presentation(previous) || presentation(next);
    let a = entries(previous, visual);
    let b = entries(next, visual);
    a.len() == b.len()
        && a.iter().zip(b.iter()).all(|(a, b)| {
            a.text == b.text
                && if visual {
                    a.id == b.id
                } else {
                    a.start == b.start && a.end == b.end
                }
        })
}
/// Native entry point used by canonical transactions as well as the WASM host.
/// Arguments describe one generated caption element; unknown word fields survive.
pub fn sync_caption_transcript(input: &Value) -> Vec<Value> {
    let words = input["words"].as_array().cloned().unwrap_or_default();
    let element = &input["element"];
    let previous = input.get("previousElement").filter(|v| v.is_object());
    let settings = &input["settings"];
    let hide = settings["hidePunctuation"] == true;
    if let Some(previous) = previous {
        if semantically_equal(previous, element)
            || (!presentation(previous) && presentation(element))
        {
            return words;
        }
        if presentation(previous) && presentation(element) {
            let result = sync_previous(&words, previous, element, hide, true);
            if result != words {
                return result;
            }
        }
        let result = sync_previous(&words, previous, element, hide, false);
        if result != words {
            return result;
        }
    }
    let generated_indices: Vec<_> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| generated(w))
        .map(|(i, _)| i)
        .collect();
    let cues = build_caption_cue_plan(CaptionCuePlanOptions {
        words: generated_indices
            .iter()
            .map(|i| CaptionLayoutWord {
                text: text(&words[*i]["text"]).into(),
                start: n(&words[*i]["start"]),
                end: n(&words[*i]["end"]),
            })
            .collect(),
        settings_json: settings.to_string(),
    });
    let layers = allocate_caption_layers(CaptionLayerOptions {
        captions: cues.clone(),
        layer_count: input["layerCount"].as_f64().unwrap_or(1.0),
    });
    let layer_value = input["layerIndex"].as_f64().unwrap_or(0.0);
    if layer_value < 0.0 || layer_value.fract() != 0.0 || layer_value >= usize::MAX as f64 {
        return words;
    }
    let layer = layer_value as usize;
    let index = input["elementIndex"].as_u64().unwrap_or(0) as usize;
    let Some(cue) = layers
        .layers
        .get(layer)
        .and_then(|l| l.get(index))
        .and_then(|i| cues.get(*i))
    else {
        return words;
    };
    let mut result = words.clone();
    let parts = content(element);
    for (offset, index) in cue.word_indices.iter().enumerate() {
        let i = generated_indices[*index];
        let current = &words[i];
        let run = runs(element).get(offset);
        let rendered = run
            .map(|r| text(&r["text"]))
            .or_else(|| parts.get(offset).copied())
            .unwrap_or(text(&current["text"]));
        let start = run
            .and_then(|r| r["startTime"].as_f64())
            .map(|v| seconds(&element["startTime"]) + v / 120_000.0)
            .unwrap_or(n(&current["start"]));
        let end = run
            .and_then(|r| r["endTime"].as_f64())
            .map(|v| seconds(&element["startTime"]) + v / 120_000.0)
            .unwrap_or(n(&current["end"]));
        put(
            &mut result,
            i,
            &Entry {
                id: None,
                text: rendered.into(),
                start,
                end,
            },
            hide,
            true,
        );
    }
    result
}
#[export]
pub fn plan_caption_transcript_sync(
    CaptionTranscriptSyncOptions { input_json }: CaptionTranscriptSyncOptions,
) -> String {
    let mut input: Value =
        serde_json::from_str(&input_json).expect("caption sync input must be JSON");
    let original = input["words"].as_array().cloned().unwrap_or_default();
    // A collision-free internal index survives matching/deletion, including
    // repeated identical words. It is never returned as transcript metadata.
    let mut marker = "__captionSyncIndex".to_owned();
    while original.iter().any(|w| w.get(&marker).is_some()) {
        marker.push('_');
    }
    if let Some(words) = input["words"].as_array_mut() {
        for (i, w) in words.iter_mut().enumerate() {
            w[&marker] = json!(i);
        }
    }
    let mut result = sync_caption_transcript(&input);
    let plan: Vec<_> = result.iter_mut().map(|word| {
        let i = word.as_object_mut().expect("caption word must be an object").remove(&marker).expect("caption source index survives");
        json!({"sourceIndex": i, "text": word["text"], "start": word["start"], "end": word["end"]})
    }).collect();
    json!({"changed": result != original, "words": plan}).to_string()
}

/// The same generated-source policy is used by canonical move/split drafts and
/// the legacy UI adapter. Selection and update order belong to this shared
/// layer; the host only reapplies the returned field edits to original words.
pub fn sync_caption_scene_transcript(input: &Value) -> Value {
    let tracks = &input["tracks"];
    let Some(first) = caption_source_track_index(tracks) else {
        return json!({"changed":false,"firstIndex":null,"sourceIndices":[],"words":[]});
    };
    let overlay = tracks["overlay"]
        .as_array()
        .expect("selected overlay track");
    let source = &overlay[first]["captionSource"];
    let indices = caption_source_track_indices(tracks, source);
    let original = source["words"].as_array().cloned().unwrap_or_default();
    let mut words = original.clone();
    let mut changed = false;
    for update in input["updates"].as_array().into_iter().flatten() {
        let Some(track) = indices
            .iter()
            .map(|i| &overlay[*i])
            .find(|t| t["id"] == update["trackId"])
        else {
            continue;
        };
        let Some((element_index, element)) = track["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .find(|(_, e)| e["id"] == update["elementId"])
        else {
            continue;
        };
        let previous = input["previousTracks"]["overlay"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["type"] == "text" && t["id"] == update["trackId"])
            .and_then(|t| t["elements"].as_array())
            .and_then(|items| items.iter().find(|e| e["id"] == update["elementId"]))
            .cloned()
            .unwrap_or(Value::Null);
        let candidate = sync_caption_transcript(&json!({
            "words":words, "settings":track["captionSource"]["settings"],
            "layerCount":track["captionSource"]["layerCount"].as_f64().unwrap_or(1.0),
            "layerIndex":track["captionSource"]["layerIndex"].as_f64().unwrap_or(0.0),
            "elementIndex":element_index,"element":element,"previousElement":previous
        }));
        changed |= candidate != words;
        words = candidate;
    }
    json!({"changed":changed,"firstIndex":first,"sourceIndices":indices,"words":words})
}

#[export]
pub fn plan_caption_scene_transcript_sync(
    CaptionTranscriptSyncOptions { input_json }: CaptionTranscriptSyncOptions,
) -> String {
    let mut input: Value =
        serde_json::from_str(&input_json).expect("caption scene sync input must be JSON");
    let Some(first) = caption_source_track_index(&input["tracks"]) else {
        return sync_caption_scene_transcript(&input).to_string();
    };
    let original = input["tracks"]["overlay"][first]["captionSource"]["words"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut marker = "__captionSceneSyncIndex".to_owned();
    while original.iter().any(|w| w.get(&marker).is_some()) {
        marker.push('_');
    }
    if let Some(words) = input["tracks"]["overlay"][first]["captionSource"]["words"].as_array_mut()
    {
        for (i, word) in words.iter_mut().enumerate() {
            word[&marker] = json!(i);
        }
    }
    let mut result = sync_caption_scene_transcript(&input);
    let plan: Vec<_> = result["words"]
        .as_array_mut()
        .expect("scene words")
        .iter_mut()
        .map(|word| {
            let index = word
                .as_object_mut()
                .expect("caption word")
                .remove(&marker)
                .expect("caption scene source index survives");
            json!({"sourceIndex":index,"text":word["text"],"start":word["start"],"end":word["end"]})
        })
        .collect();
    result["words"] = json!(plan);
    result.to_string()
}

/// Moving a generated caption to an ordinary text track replaces its generated
/// transcript words with words owned by that text layer. Match against the
/// pre-edit source and remove each original word at most once.
pub fn caption_words_replaced_by_manual_layers(input: &Value) -> Vec<usize> {
    let tracks = &input["tracks"];
    let Some(first) = caption_source_track_index(tracks) else {
        return vec![];
    };
    let source = &tracks["overlay"][first]["captionSource"];
    let words = source["words"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let current = caption_source_track_indices(tracks, source);
    let source_ids: HashSet<_> = current
        .iter()
        .map(|i| text(&tracks["overlay"][*i]["id"]))
        .collect();
    let before = &input["previousTracks"];
    let previous = caption_source_track_indices(before, source);
    let mut seen = HashSet::new();
    let mut used = HashSet::new();
    for target in input["elements"].as_array().into_iter().flatten() {
        let key = (text(&target["trackId"]), text(&target["elementId"]));
        if !seen.insert(key) || source_ids.contains(key.0) {
            continue;
        }
        let Some(element) = previous
            .iter()
            .flat_map(|i| {
                before["overlay"][*i]["elements"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .find(|element| text(&element["id"]) == key.1)
        else {
            continue;
        };
        for entry in entries(element, false) {
            if let Some(index) = source_match(words, &entry, &used) {
                used.insert(index);
            }
        }
    }
    (0..words.len()).filter(|i| used.contains(i)).collect()
}

#[export]
pub fn plan_caption_manual_word_replacement(
    CaptionTranscriptSyncOptions { input_json }: CaptionTranscriptSyncOptions,
) -> String {
    let input: Value =
        serde_json::from_str(&input_json).expect("caption ownership input must be JSON");
    json!({"indices":caption_words_replaced_by_manual_layers(&input)}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_replacement_uses_previous_generated_words_and_deduplicates_refs() {
        let words =
            json!([{"text":"same","start":0,"end":0.2},{"text":"same","start":1,"end":1.2}]);
        let source = json!({"sourceId":"shared","words":words,"settings":{}});
        let input = json!({
            "tracks":{"overlay":[{"id":"generated","type":"text","captionSource":source,"elements":[]}]},
            "previousTracks":{"overlay":[{"id":"generated","type":"text","captionSource":source,
                "elements":[{"id":"clip","startTime":120000,"duration":24000,"params":{"content":"same"},"wordRuns":[{"id":"word","text":"same","startTime":0,"endTime":24000}]}]}]},
            "elements":[{"trackId":"manual","elementId":"clip"},{"trackId":"manual","elementId":"clip"},{"trackId":"generated","elementId":"clip"}]
        });
        assert_eq!(caption_words_replaced_by_manual_layers(&input), vec![1]);
        assert_eq!(
            caption_words_replaced_by_manual_layers(&json!({"tracks":{"overlay":[]}})),
            Vec::<usize>::new()
        );
        let mut foreign = input.clone();
        foreign["previousTracks"]["overlay"][0]["captionSource"]["sourceId"] = json!("foreign");
        assert!(caption_words_replaced_by_manual_layers(&foreign).is_empty());
    }
    #[test]
    fn scene_sync_orders_updates_and_isolates_other_sources() {
        let words = json!([
            {"text":"one","start":0,"end":0.2,"confidence":0.9,"__captionSceneSyncIndex":"owned"},
            {"text":"two","start":1,"end":1.2,"speaker":{"id":"speaker"}}
        ]);
        let track = |id: &str, word: &str, ticks: i64, source: &str| {
            json!({
                "id":id,"type":"text","captionSource":{"sourceId":source,"words":words,"settings":{}},
                "elements":[{"id":id,"params":{"content":word},"startTime":ticks,"duration":24000,
                    "wordRuns":[{"id":id,"text":word,"startTime":0,"endTime":24000}]}]
            })
        };
        let input = json!({
            "tracks":{"overlay":[track("a","one",240000,"shared"),track("b","two",480000,"shared"),track("foreign","one",960000,"foreign")]},
            "previousTracks":{"overlay":[track("a","one",0,"shared"),track("b","two",120000,"shared")]},
            "updates":[{"trackId":"foreign","elementId":"foreign"},{"trackId":"a","elementId":"a"},
                {"trackId":"missing","elementId":"a"},{"trackId":"b","elementId":"b"}]
        });
        let original = input.clone();
        let result = sync_caption_scene_transcript(&input);
        assert_eq!(result["sourceIndices"], json!([0, 1]));
        assert_eq!(result["changed"], true);
        assert_eq!(result["words"][0]["start"], 2.0);
        assert_eq!(result["words"][1]["start"], 4.0);
        assert_eq!(result["words"][0]["__captionSceneSyncIndex"], "owned");
        assert_eq!(result["words"][1]["speaker"], json!({"id":"speaker"}));
        let plan: Value = serde_json::from_str(&plan_caption_scene_transcript_sync(
            CaptionTranscriptSyncOptions {
                input_json: input.to_string(),
            },
        ))
        .unwrap();
        assert_eq!(plan["words"][0]["sourceIndex"], 0);
        assert_eq!(plan["words"][1]["sourceIndex"], 1);
        assert_eq!(input, original);
        assert_eq!(
            sync_caption_scene_transcript(&json!({"tracks":{"overlay":[]},"updates":[]}))["changed"],
            false
        );
    }
    #[test]
    fn whitespace_matches_ecmascript_and_preserves_questions() {
        assert_eq!(
            strip_caption_punctuation("\u{feff}כן,\u{00a0}¿?\u{0085}\n x!\u{feff}"),
            "כן ¿?\u{0085}\nx"
        );
        let e = json!({"params":{"content":"\u{feff}one\u{00a0}two\u{0085}three"}});
        assert_eq!(content(&e), vec!["one", "two\u{0085}three"]);
    }
    #[test]
    fn plan_keeps_duplicate_word_indices_and_avoids_metadata_collisions() {
        let input = json!({"words":[
            {"text":"same","start":0,"end":0.2,"__captionSyncIndex":7},
            {"text":"same","start":1,"end":1.2,"__captionSyncIndex":7}],
            "settings":{},
            "previousElement":{"startTime":0,"duration":144000,"wordRuns":[
                {"id":"a","text":"same","startTime":0,"endTime":24000},
                {"id":"b","text":"same","startTime":120000,"endTime":144000}]},
            "element":{"startTime":0,"duration":144000,"wordRuns":[
                {"id":"b","text":"same","startTime":120000,"endTime":144000}]}});
        let plan: Value = serde_json::from_str(&plan_caption_transcript_sync(
            CaptionTranscriptSyncOptions {
                input_json: input.to_string(),
            },
        ))
        .unwrap();
        assert_eq!(
            plan,
            json!({"changed":true,"words":[{"sourceIndex":1,"text":"same","start":1,"end":1.2}]})
        );
        assert_eq!(sync_caption_transcript(&input)[0]["__captionSyncIndex"], 7);
    }
    #[test]
    fn retiming_deletion_and_metadata() {
        let input = json!({"words":[{"text":"hello,","start":0,"end":0.2,"confidence":0.7},{"text":"world","start":0.2,"end":0.4}],
            "settings":{"hidePunctuation":true},
            "previousElement":{"startTime":0,"duration":48000,"wordRuns":[{"id":"a","text":"hello","startTime":0,"endTime":24000},{"id":"b","text":"world","startTime":24000,"endTime":48000}]},
            "element":{"startTime":120001,"duration":48000,"wordRuns":[{"id":"a","text":"hello","startTime":0,"endTime":24000}]}});
        let result = sync_caption_transcript(&input);
        assert_eq!(
            result,
            vec![json!({"text":"hello,","start":1.0,"end":1.2,"confidence":0.7})]
        );
    }
    #[test]
    fn presentation_changes_keep_transcript_timing() {
        let input = json!({"words":[{"text":"כן?","start":2,"end":2.4,"speakerId":"a"}],"settings":{},
            "previousElement":{"startTime":240000,"duration":48000,"wordRuns":[{"id":"a","text":"כן?"}]},
            "element":{"startTime":1200000,"duration":48000,"wordRuns":[{"id":"a","text":"לא!"}]}});
        assert_eq!(
            sync_caption_transcript(&input),
            vec![json!({"text":"לא!","start":2,"end":2.4,"speakerId":"a"})]
        );
    }
}
