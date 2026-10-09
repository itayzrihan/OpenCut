use super::classic_remove::ElementRef;
use super::*;
use classic_timeline::{
    CaptionWord, ReconcileCaptionWordsOptions, TextLayerWordsInput, reconcile_caption_words,
    strip_caption_punctuation,
};
const TICKS: f64 = 120_000.0;

fn words(source: &Value) -> &[Value] {
    source["words"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn generated(word: &Value) -> bool {
    word["source"]["type"] != "text-layer"
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn seconds(value: &Value) -> f64 {
    number(value) / TICKS
}
fn rounded(value: f64) -> f64 {
    (value * 1_000_000.0 + 0.5).floor() / 1_000_000.0
}
fn normalize(value: &str) -> String {
    strip_caption_punctuation(value).to_lowercase()
}
fn matches_source(track: &Value, source: &Value) -> bool {
    track["type"] == "text" && classic_timeline::caption_sources_match(track, source)
}
fn source(tracks: &Value) -> Option<Value> {
    tracks["overlay"]
        .as_array()?
        .iter()
        .find(|track| track["type"] == "text" && track["captionSource"].is_object())
        .map(|track| track["captionSource"].clone())
}
fn update(tracks: &mut Value, source: &Value, next: &[Value]) {
    if let Some(overlay) = tracks["overlay"].as_array_mut() {
        for track in overlay {
            if matches_source(track, source) {
                track["captionSource"]["words"] = Value::Array(next.to_vec());
            }
        }
    }
}

pub(super) fn sync_after_edit(
    tracks: &mut Value,
    before: &Value,
    updates: &Value,
) -> Result<(), CapabilityError> {
    let plan = classic_timeline::sync_caption_scene_transcript(
        &serde_json::json!({"tracks":tracks,"previousTracks":before,"updates":updates}),
    );
    if plan["changed"] == true {
        if let Some(source) = source(tracks) {
            update(
                tracks,
                &source,
                plan["words"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            );
        }
    }
    let replaced = classic_timeline::caption_words_replaced_by_manual_layers(
        &serde_json::json!({"tracks":tracks,"previousTracks":before,"elements":updates}),
    );
    if let Some(source) = source(tracks) {
        let next: Vec<_> = words(&source)
            .iter()
            .enumerate()
            .filter(|(i, _)| !replaced.contains(i))
            .map(|(_, w)| w.clone())
            .collect();
        update(tracks, &source, &next);
    }
    reconcile_words(tracks, &[])
}

fn transcript_entries(element: &Value) -> Vec<(String, f64, f64)> {
    let start = seconds(&element["startTime"]);
    if let Some(runs) = element["wordRuns"].as_array().filter(|v| !v.is_empty()) {
        return runs
            .iter()
            .filter_map(|run| {
                if !run["startTime"].is_number() || !run["endTime"].is_number() {
                    return None;
                }
                let s = start + seconds(&run["startTime"]);
                Some((
                    text(&run["text"]).into(),
                    rounded(s),
                    rounded((start + seconds(&run["endTime"])).max(s + 0.01)),
                ))
            })
            .collect();
    }
    let content: Vec<_> = text(&element["params"]["content"])
        .split_whitespace()
        .collect();
    let duration = seconds(&element["duration"]) / content.len().max(1) as f64;
    content
        .into_iter()
        .enumerate()
        .map(|(i, word)| {
            let s = start + i as f64 * duration;
            (
                word.into(),
                rounded(s),
                rounded((s + duration).max(s + 0.01)),
            )
        })
        .collect()
}

pub(super) fn remove_words(
    tracks: &mut Value,
    before: &Value,
    removed: &[ElementRef],
) -> Result<(), CapabilityError> {
    let Some(original_source) = source(tracks) else {
        return Ok(());
    };
    let source_words = words(&original_source);
    let mut indexes = HashSet::new();
    let mut seen = HashSet::new();
    for target in removed {
        if !seen.insert((&target.track_id, &target.element_id)) {
            continue;
        }
        let Some(element) = before["overlay"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|track| track["id"] == target.track_id && matches_source(track, &original_source))
            .and_then(|track| track["elements"].as_array())
            .and_then(|items| items.iter().find(|item| item["id"] == target.element_id))
        else {
            continue;
        };
        let entries = transcript_entries(element);
        for (word, start, end) in &entries {
            let normalized = normalize(word);
            let best = source_words
                .iter()
                .enumerate()
                .filter(|(i, w)| {
                    !indexes.contains(i)
                        && generated(w)
                        && normalize(text(&w["text"])) == normalized
                })
                .min_by(|(_, a), (_, b)| {
                    let distance = |w: &Value| {
                        (number(&w["start"]) - start).abs() + (number(&w["end"]) - end).abs()
                    };
                    distance(a).total_cmp(&distance(b))
                })
                .map(|(i, _)| i);
            if let Some(i) = best {
                indexes.insert(i);
            }
        }
        if entries.is_empty() {
            let mut local = HashSet::new();
            let mut search_start = 0;
            let start = seconds(&element["startTime"]);
            let end = start + seconds(&element["duration"]);
            for run in element["wordRuns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|run| !text(&run["text"]).trim().is_empty())
            {
                let normalized = normalize(text(&run["text"]));
                let find = |from| {
                    let candidates: Vec<_> = source_words
                        .iter()
                        .enumerate()
                        .skip(from)
                        .filter(|(i, w)| {
                            !local.contains(i)
                                && generated(w)
                                && normalize(text(&w["text"])) == normalized
                        })
                        .collect();
                    candidates
                        .iter()
                        .find(|(_, w)| {
                            let midpoint = (number(&w["start"]) + number(&w["end"])) / 2.0;
                            midpoint >= start - 0.001 && midpoint <= end + 0.001
                        })
                        .or(candidates.first())
                        .map(|(i, _)| *i)
                };
                if let Some(i) = find(search_start).or_else(|| find(0)) {
                    local.insert(i);
                    indexes.insert(i);
                    search_start = i + 1;
                }
            }
        }
    }
    let remaining: Vec<_> = source_words
        .iter()
        .enumerate()
        .filter(|(i, _)| !indexes.contains(i))
        .map(|(_, word)| word.clone())
        .collect();
    update(tracks, &original_source, &remaining);
    reconcile_words(tracks, removed)
}

pub(super) fn reconcile_words(
    tracks: &mut Value,
    removed: &[ElementRef],
) -> Result<(), CapabilityError> {
    // Reuse the existing Rust reconciler; do not port its word timing/ownership
    // policy into another implementation. Preserve retained extension fields.
    let Some(active_source) = source(tracks) else {
        return Ok(());
    };
    let removed_keys: HashSet<_> = removed
        .iter()
        .map(|r| (r.track_id.as_str(), r.element_id.as_str()))
        .collect();
    let old: Vec<Value> = words(&active_source)
        .iter()
        .filter(|w| {
            generated(w)
                || !removed_keys.contains(&(
                    text(&w["source"]["trackId"]),
                    text(&w["source"]["elementId"]),
                ))
        })
        .cloned()
        .collect();
    let typed_words: Vec<CaptionWord> = serde_json::from_value(serde_json::json!(old))
        .map_err(|e| CapabilityError::InvalidInput(format!("Invalid caption words: {e}")))?;
    let mut layers = Vec::<TextLayerWordsInput>::new();
    for track in tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["type"] == "text" && !t["captionSource"].is_object())
    {
        for element in track["elements"].as_array().into_iter().flatten() {
            let layer = serde_json::json!({"trackId":track["id"],"elementId":element["id"],"startTime":element["startTime"],"duration":element["duration"],"content":text(&element["params"]["content"]),"wordRuns":element["wordRuns"].as_array().cloned().unwrap_or_default()});
            layers.push(
                serde_json::from_value(layer).map_err(|e| {
                    CapabilityError::InvalidInput(format!("Invalid text layer: {e}"))
                })?,
            );
        }
    }
    let reconciled = reconcile_caption_words(ReconcileCaptionWordsOptions {
        words: typed_words,
        text_layers: layers,
    });
    let next: Vec<Value> = reconciled
        .into_iter()
        .map(|word| {
            let value = serde_json::to_value(word).expect("caption word");
            let previous = old.iter().find(|w| {
                w["text"] == value["text"]
                    && number(&w["start"]) == number(&value["start"])
                    && number(&w["end"]) == number(&value["end"])
                    && ["type", "trackId", "elementId", "wordIndex", "wordId"]
                        .iter()
                        .all(|key| w["source"][key] == value["source"][key])
            });
            previous.cloned().unwrap_or(value)
        })
        .collect();
    update(tracks, &active_source, &next);
    Ok(())
}
