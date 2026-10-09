//! Canonical cue timing/rows and overlap-layer allocation. Host adapters attach
//! original word metadata by returned indices; platform font measurement stays outside.
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLayoutWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCuePlanOptions {
    pub words: Vec<CaptionLayoutWord>,
    pub settings_json: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCuePlan {
    pub text: String,
    pub start_time: f64,
    pub duration: f64,
    pub word_indices: Vec<usize>,
}

fn preference(settings: &Value, key: &str, default: f64, min: f64, max: f64, integer: bool) -> f64 {
    let value = match settings.get(key) {
        None | Some(Value::Null) => default,
        Some(value) => value.as_f64().filter(|v| v.is_finite()).unwrap_or(min),
    };
    (if integer {
        (value + 0.5).floor()
    } else {
        value
    })
    .clamp(min, max)
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLayoutNormalizeOptions {
    pub settings_json: String,
}
fn breaks(settings: &Value) -> Vec<usize> {
    let mut values: Vec<usize> = settings["rowBreaks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0 && v.fract() == 0.0 && *v < usize::MAX as f64)
        .map(|v| v as usize)
        .collect();
    values.sort_unstable();
    values.dedup();
    values
}
/// Normalize the stored legacy setting shape without interpreting executable code.
#[export]
pub fn normalize_caption_layout_settings(
    CaptionLayoutNormalizeOptions { settings_json }: CaptionLayoutNormalizeOptions,
) -> String {
    let settings: Value = serde_json::from_str(&settings_json).unwrap_or(Value::Null);
    let choice = |key: &str, allowed: &[&str], default: &str| -> String {
        settings[key]
            .as_str()
            .filter(|s| allowed.contains(s))
            .unwrap_or(default)
            .into()
    };
    let named = |key: &str, default: &str| -> String {
        settings[key]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(default)
            .into()
    };
    let animation = settings["wordAnimationId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            settings["presetId"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("none");
    let mut output = serde_json::json!({
        "wordsPerRow":preference(&settings,"wordsPerRow",4.0,1.0,12.0,true),"rows":preference(&settings,"rows",1.0,1.0,4.0,true),
        "inPaddingPercent":preference(&settings,"inPaddingPercent",0.0,0.0,100.0,false),"outPaddingPercent":preference(&settings,"outPaddingPercent",0.0,0.0,100.0,false),
        "bottomFadeOutPercent":preference(&settings,"bottomFadeOutPercent",60.0,0.0,100.0,false),
        "revealMode":choice("revealMode",&["determined-by-preset","row","spoken-word","spoken-word-keep","emphasize-spoken","emphasize-spoken-keep","letter-by-letter","growing-row"],"determined-by-preset"),
        "transitionIn":choice("transitionIn",&["none","fade","blur","zoom","blur-zoom","rise","slide","typewriter","glow-dissolve"],"none"),
        "wordAnimationId":animation,"accentColor":named("accentColor","#c8ff4d"),"wordDirection":choice("wordDirection",&["ltr","rtl","auto"],"auto"),
        "hidePunctuation":settings["hidePunctuation"].as_bool().unwrap_or(true),"placementMode":choice("placementMode",&["grid","manual"],"grid"),
        "placementGridX":preference(&settings,"placementGridX",0.5,0.0,1.0,false),"placementGridY":preference(&settings,"placementGridY",0.5,0.0,1.0,false),
        "manualPositionX":preference(&settings,"manualPositionX",0.0,-100000.0,100000.0,false),"manualPositionY":preference(&settings,"manualPositionY",0.0,-100000.0,100000.0,false)
    });
    let row_breaks = breaks(&settings);
    if !row_breaks.is_empty() {
        output["rowBreaks"] = serde_json::json!(row_breaks);
    }
    if settings["exactWordTimings"] == true {
        output["exactWordTimings"] = Value::Bool(true);
    }
    if let Some(segments) = settings.get("segmentBreaks") {
        output["segmentBreaks"] = segments.clone();
    }
    output.to_string()
}
#[derive(Clone)]
struct Group {
    text: String,
    start: f64,
    end: f64,
    indices: Vec<usize>,
}
fn boundary(left: &Group, right: &Group) -> f64 {
    if left.indices.len() == 1 && right.indices.len() == 1 {
        left.end + (right.start - left.end) / 2.0
    } else if left.indices.len() == 1 {
        right.start
    } else {
        left.end
    }
}
/// Plan captions without losing word extension fields or generating identities.
#[export]
pub fn build_caption_cue_plan(
    CaptionCuePlanOptions {
        words,
        settings_json,
    }: CaptionCuePlanOptions,
) -> Vec<CaptionCuePlan> {
    if words.is_empty()
        || words
            .iter()
            .any(|w| !w.start.is_finite() || !w.end.is_finite())
    {
        return Vec::new();
    }
    let settings: Value = serde_json::from_str(&settings_json).unwrap_or(Value::Null);
    let per_row = preference(&settings, "wordsPerRow", 4.0, 1.0, 12.0, true) as usize;
    let row_count = preference(&settings, "rows", 1.0, 1.0, 4.0, true) as usize;
    let lead = preference(&settings, "inPaddingPercent", 0.0, 0.0, 100.0, false) / 100.0;
    let tail = preference(&settings, "outPaddingPercent", 0.0, 0.0, 100.0, false) / 100.0;
    // AI row boundaries are suggestions. Keep every usable semantic boundary,
    // split oversized rows and cover an omitted tail without dropping speech.
    let mut suggested = breaks(&settings);
    suggested.retain(|end| *end <= words.len());
    if suggested.last() != Some(&words.len()) {
        suggested.push(words.len());
    }
    let mut breaks = Vec::new();
    let mut start = 0;
    for end in suggested {
        breaks.extend((start + per_row..end).step_by(per_row));
        breaks.push(end);
        start = end;
    }
    let exact = settings["exactWordTimings"] == true;
    let mut segments: Vec<usize> = settings["segmentBreaks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .map(|v| v as usize)
        .filter(|i| *i > 0 && *i < words.len())
        .collect();
    segments.sort_unstable();
    segments.dedup();
    // Reflow row lengths within each edit segment; no cue may straddle a cut.
    if !segments.is_empty() {
        let mut start = 0;
        breaks.clear();
        for end in segments.iter().copied().chain(std::iter::once(words.len())) {
            breaks.extend((start + per_row..end).step_by(per_row));
            breaks.push(end);
            start = end;
        }
    }
    let mut rows = Vec::new();
    let mut start = 0;
    for end in breaks {
        rows.push((start..end).collect::<Vec<_>>());
        start = end;
    }
    let mut row_groups: Vec<Vec<Vec<usize>>> = Vec::new();
    for row in rows {
        let boundary = row
            .first()
            .is_some_and(|i| segments.binary_search(i).is_ok());
        if boundary || row_groups.last().is_none_or(|g| g.len() >= row_count) {
            row_groups.push(vec![]);
        }
        row_groups.last_mut().unwrap().push(row);
    }
    let groups: Vec<Group> = row_groups
        .iter()
        .map(|rows| {
            let indices: Vec<usize> = rows.iter().flatten().copied().collect();
            Group {
                text: rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|i| words[*i].text.as_str())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                start: words[indices[0]].start,
                end: indices.iter().map(|i| words[*i].end).fold(
                    words[indices[0]].start + if exact { 0.000_001 } else { 0.1 },
                    f64::max,
                ),
                indices,
            }
        })
        .collect();
    groups
        .iter()
        .enumerate()
        .map(|(i, group)| {
            let previous = i.checked_sub(1).map(|i| &groups[i]);
            let next = groups.get(i + 1);
            let previous_boundary = previous.map(|previous| {
                if group.start < previous.end {
                    group.start
                } else {
                    boundary(previous, group)
                }
            });
            let next_boundary = next.map(|next| {
                if next.start < group.end {
                    group.end
                } else {
                    boundary(group, next)
                }
            });
            let mut readable_start = group.start;
            let mut readable_end = group.end.max(group.start + 0.001);
            if !exact && group.indices.len() == 1 {
                let earliest = previous_boundary.unwrap_or(0.0).max(0.0);
                let latest = next_boundary.unwrap_or(readable_end).max(readable_end);
                let missing = (0.6 - (readable_end - group.start)).max(0.0);
                readable_start -= missing.min((group.start - earliest).max(0.0));
                let remaining = (0.6 - (readable_end - readable_start)).max(0.0);
                readable_end = (readable_end + remaining).min(latest);
            }
            let duration = (readable_end - readable_start).max(0.001);
            let mut start = (readable_start - duration * if exact { 0.0 } else { lead }).max(0.0);
            let mut end =
                (readable_end + duration * if exact { 0.0 } else { tail }).max(start + 0.000_001);
            if !exact && group.indices.len() == 1 {
                if let Some(boundary) = previous_boundary {
                    start = start.max(boundary);
                }
                if let Some(boundary) = next_boundary {
                    end = end.min(boundary);
                }
            }
            CaptionCuePlan {
                text: group.text.clone(),
                start_time: start,
                duration: (end - start).max(0.001),
                word_indices: group.indices.clone(),
            }
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLayerOptions {
    pub captions: Vec<CaptionCuePlan>,
    pub layer_count: f64,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Debug, PartialEq)]
pub struct CaptionLayerPlan {
    pub layers: Vec<Vec<usize>>,
}
/// Preferred-layer round robin, then any free layer, then overflow. Reuse an
/// overflow layer after it becomes free; source order remains deterministic.
#[export]
pub fn allocate_caption_layers(
    CaptionLayerOptions {
        captions,
        layer_count,
    }: CaptionLayerOptions,
) -> CaptionLayerPlan {
    let count = if layer_count.is_finite() {
        (layer_count + 0.5).floor().clamp(1.0, 16.0) as usize
    } else {
        1
    };
    let mut layers = vec![Vec::new(); count];
    let mut ends = vec![0.0; count];
    for (i, caption) in captions.iter().enumerate() {
        let preferred = i % count;
        let index = if ends[preferred] <= caption.start_time {
            preferred
        } else if let Some(index) = ends.iter().position(|end| *end <= caption.start_time) {
            index
        } else {
            layers.push(Vec::new());
            ends.push(0.0);
            layers.len() - 1
        };
        layers[index].push(i);
        ends[index] = ends[index].max(caption.start_time + caption.duration);
    }
    CaptionLayerPlan {
        layers: layers
            .into_iter()
            .filter(|layer| !layer.is_empty())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_ai_rows_preserve_words_clocks_and_valid_boundaries() {
        for suggested in ["[3,10]", "[10,3,3,999]", "[3]", "[]"] {
            let cues = build_caption_cue_plan(CaptionCuePlanOptions {
                words: (0..13)
                    .map(|i| CaptionLayoutWord {
                        text: format!("word{i}"),
                        start: i as f64,
                        end: i as f64 + 0.5,
                    })
                    .collect(),
                settings_json: format!(
                    "{{\"wordsPerRow\":4,\"rows\":1,\"exactWordTimings\":true,\"rowBreaks\":{suggested}}}"
                ),
            });
            assert_eq!(
                cues.iter()
                    .flat_map(|cue| cue.word_indices.iter().copied())
                    .collect::<Vec<_>>(),
                (0..13).collect::<Vec<_>>()
            );
            for cue in &cues {
                assert!(cue.word_indices.len() <= 4);
                assert_eq!(cue.start_time, cue.word_indices[0] as f64);
                assert_eq!(
                    cue.start_time + cue.duration,
                    *cue.word_indices.last().unwrap() as f64 + 0.5
                );
            }
            if suggested != "[]" {
                assert_eq!(cues[0].word_indices, vec![0, 1, 2]);
            }
        }
    }
    #[test]
    fn readable_rows_preserve_order_and_neighbour_boundaries() {
        let words = (0..4)
            .map(|i| CaptionLayoutWord {
                text: format!("word{i}"),
                start: i as f64,
                end: i as f64 + 0.1,
            })
            .collect();
        let cues = build_caption_cue_plan(CaptionCuePlanOptions {
            words,
            settings_json: "{\"wordsPerRow\":1,\"inPaddingPercent\":100,\"outPaddingPercent\":100}"
                .into(),
        });
        assert_eq!(cues.len(), 4);
        assert!(
            cues.windows(2)
                .all(|pair| pair[0].start_time + pair[0].duration <= pair[1].start_time)
        );
        assert_eq!(cues[2].word_indices, vec![2]);
    }
    #[test]
    fn overflow_layers_are_reused() {
        let captions = [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]
            .into_iter()
            .map(|start| CaptionCuePlan {
                text: "text".into(),
                start_time: start,
                duration: 0.5,
                word_indices: vec![],
            })
            .collect();
        assert_eq!(
            allocate_caption_layers(CaptionLayerOptions {
                captions,
                layer_count: 2.0
            })
            .layers,
            vec![vec![0, 4], vec![1, 3], vec![2, 5]]
        );
    }
}
