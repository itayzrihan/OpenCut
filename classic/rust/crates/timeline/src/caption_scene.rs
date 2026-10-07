//! Complete generated-caption scene rebuilding, with platform widths and an
//! identity allocator supplied by the caller. No editor store or host IO here.
use super::{
    CaptionCuePlan, CaptionCuePlanOptions, CaptionLayerOptions, CaptionLayoutWord,
    CaptionReference, CaptionWidthMeasure, allocate_caption_layers, build_caption_cue_plan,
    build_caption_text_element, caption_cue_presentation_styles, caption_track_presentation_plan,
    strip_caption_punctuation,
};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn n(v: &Value, default: f64) -> f64 {
    v.as_f64().unwrap_or(default)
}
pub fn generated_caption_word_indices(words: &[Value]) -> Vec<usize> {
    words
        .iter()
        .enumerate()
        .filter(|(_, w)| w["source"]["type"] != "text-layer")
        .map(|(i, _)| i)
        .collect()
}
/// Legacy sources without a stable sourceId are grouped by generated words,
/// preferred layer count and time-span overlap. Stable source IDs dominate.
pub fn caption_sources_match(track: &Value, source: &Value) -> bool {
    let candidate = &track["captionSource"];
    if !candidate.is_object() {
        return false;
    }
    if !text(&candidate["sourceId"]).is_empty() || !text(&source["sourceId"]).is_empty() {
        return candidate["sourceId"] == source["sourceId"];
    }
    let a = array(&candidate["words"]);
    let b = array(&source["words"]);
    let ai = generated_caption_word_indices(a);
    let bi = generated_caption_word_indices(b);
    if ai.len() != bi.len() || n(&candidate["layerCount"], 1.0) != n(&source["layerCount"], 1.0) {
        return false;
    }
    if ai.is_empty() {
        return true;
    }
    let span = |words: &[Value], indices: &[usize]| {
        (
            indices
                .iter()
                .map(|i| n(&words[*i]["start"], 0.0))
                .fold(f64::INFINITY, f64::min),
            indices
                .iter()
                .map(|i| n(&words[*i]["end"], 0.0))
                .fold(f64::NEG_INFINITY, f64::max),
        )
    };
    let (start, end) = span(a, &ai);
    let (other_start, other_end) = span(b, &bi);
    let shorter = (end - start)
        .max(0.0)
        .min((other_end - other_start).max(0.0));
    if shorter <= 0.002 {
        (start - other_start).abs() <= 0.002
    } else {
        (end.min(other_end) - start.max(other_start)).max(0.0) / shorter >= 0.6
    }
}
pub fn caption_source_track_index(tracks: &Value) -> Option<usize> {
    array(&tracks["overlay"])
        .iter()
        .position(|t| t["type"] == "text" && t["captionSource"].is_object())
}
pub fn caption_source_track_indices(tracks: &Value, source: &Value) -> Vec<usize> {
    array(&tracks["overlay"])
        .iter()
        .enumerate()
        .filter(|(_, t)| t["type"] == "text" && caption_sources_match(t, source))
        .map(|(i, _)| i)
        .collect()
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSourceSelectionOptions {
    pub input_json: String,
}
#[export]
pub fn plan_caption_source_selection(
    CaptionSourceSelectionOptions { input_json }: CaptionSourceSelectionOptions,
) -> String {
    let input: Value =
        serde_json::from_str(&input_json).expect("caption source selection input must be JSON");
    json!({"firstIndex":caption_source_track_index(&input["tracks"]),"indices":caption_source_track_indices(&input["tracks"],&input["source"]),"matches":caption_sources_match(&input["track"],&input["source"])}).to_string()
}
fn cues(words: &[Value], settings: &Value) -> Vec<(CaptionCuePlan, Value)> {
    let indices = generated_caption_word_indices(words);
    build_caption_cue_plan(CaptionCuePlanOptions{words:indices.iter().map(|i|CaptionLayoutWord{text:text(&words[*i]["text"]).into(),start:n(&words[*i]["start"],0.0),end:n(&words[*i]["end"],0.0)}).collect(),settings_json:settings.to_string()})
        .into_iter().map(|cue|{let value=json!({"text":cue.text,"startTime":cue.start_time,"duration":cue.duration,"words":cue.word_indices.iter().map(|i|words[indices[*i]].clone()).collect::<Vec<_>>()});(cue,value)}).collect()
}
fn pristine(element: &Value, expected: Option<&CaptionCuePlan>, settings: &Value) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let content = text(&element["params"]["content"]);
    (content == expected.text
        || (settings["hidePunctuation"] == true
            && content == strip_caption_punctuation(&expected.text)))
        && (n(&element["startTime"], 0.0) / 120000.0 - expected.start_time).abs() <= 0.002
        && (n(&element["duration"], 0.0) / 120000.0 - expected.duration).abs() <= 0.002
        && n(&element["trimStart"], 0.0) == 0.0
        && n(&element["trimEnd"], 0.0) == 0.0
}
#[derive(Serialize)]
pub struct CaptionScenePlan {
    pub tracks: Option<Value>,
    pub references: Vec<CaptionReference>,
}
/// `fresh_id` must allocate unique IDs against the caller's draft document.
/// References retain unchanged input objects in UI adapters, without UI policy.
pub fn rebuild_caption_scene(
    input: &Value,
    fresh_id: &mut dyn FnMut() -> Result<String, String>,
    mut measure: Option<&mut CaptionWidthMeasure<'_>>,
) -> Result<CaptionScenePlan, String> {
    let tracks = &input["tracks"];
    let overlay = array(&tracks["overlay"]);
    let Some(first) = caption_source_track_index(tracks) else {
        return Ok(CaptionScenePlan {
            tracks: None,
            references: vec![],
        });
    };
    let source = &overlay[first]["captionSource"];
    let indices = caption_source_track_indices(tracks, source);
    let source_tracks: Vec<_> = indices.iter().map(|i| overlay[*i].clone()).collect();
    let source_ids: HashSet<_> = source_tracks.iter().map(|t| text(&t["id"])).collect();
    let ignored: HashSet<_> = array(&input["ignoredEditedElements"])
        .iter()
        .map(|r| (text(&r["trackId"]), text(&r["elementId"])))
        .collect();
    let mut edited = Vec::new();
    let mut edited_refs = Vec::new();
    if input["preserveEditedElements"].as_bool().unwrap_or(true) {
        for i in &indices {
            let track = &overlay[*i];
            let old_source = &track["captionSource"];
            let previous = cues(array(&old_source["words"]), &old_source["settings"]);
            let plan: Vec<_> = previous.iter().map(|(cue, _)| cue.clone()).collect();
            let layers = allocate_caption_layers(CaptionLayerOptions {
                captions: plan.clone(),
                layer_count: n(&old_source["layerCount"], 1.0),
            });
            let layer_index = n(&old_source["layerIndex"], 0.0);
            let expected =
                (layer_index.is_finite() && layer_index >= 0.0 && layer_index.fract() == 0.0)
                    .then(|| layers.layers.get(layer_index as usize))
                    .flatten();
            let items: Vec<_> = array(&track["elements"])
                .iter()
                .enumerate()
                .filter(|(index, e)| {
                    !ignored.contains(&(text(&track["id"]), text(&e["id"])))
                        && !pristine(
                            e,
                            expected
                                .and_then(|l| l.get(*index))
                                .and_then(|i| plan.get(*i)),
                            &old_source["settings"],
                        )
                })
                .collect();
            if items.is_empty() {
                continue;
            }
            let mut edited_track = input["trackDefaults"].clone();
            if !edited_track.is_object() {
                return Err("Caption track defaults are required".into());
            }
            edited_track["id"] = json!(fresh_id()?);
            edited_track["name"] = json!(format!("Edited {}", text(&track["name"])));
            if let Some(hidden) = track.get("hidden") {
                edited_track["hidden"] = hidden.clone();
            } else {
                edited_track.as_object_mut().unwrap().remove("hidden");
            }
            edited_track["elements"] =
                json!(items.iter().map(|(_, e)| (*e).clone()).collect::<Vec<_>>());
            for (e_index, (old_index, _)) in items.iter().enumerate() {
                edited_refs.push((
                    edited.len(),
                    e_index,
                    format!("/tracks/overlay/{i}/elements/{old_index}"),
                ));
            }
            edited.push(edited_track);
        }
    }
    let next_words = array(&input["words"]);
    let caption_plan = cues(next_words, &input["settings"]);
    let mut caption_values: Vec<_> = caption_plan.iter().map(|(_, v)| v.clone()).collect();
    let styles = caption_cue_presentation_styles(&caption_values, &source_tracks);
    for (cue, style) in caption_values.iter_mut().zip(styles) {
        if let Some(style) = style {
            cue["style"] = style;
        }
    }
    let layers = allocate_caption_layers(CaptionLayerOptions {
        captions: caption_plan.iter().map(|(p, _)| p.clone()).collect(),
        layer_count: n(&input["layerCount"], n(&source["layerCount"], 1.0)),
    });
    let source_id = match source.get("sourceId").filter(|v| !v.is_null()) {
        Some(id) => id.clone(),
        None => json!(fresh_id()?),
    };
    let mut generated = Vec::new();
    for (layer_index, items) in layers.layers.iter().enumerate() {
        let mut track = input["trackDefaults"].clone();
        if !track.is_object() {
            return Err("Caption track defaults are required".into());
        }
        track["id"] = json!(fresh_id()?);
        track["name"] = json!(if layers.layers.len() > 1 {
            format!("Captions {}", layer_index + 1)
        } else {
            "Captions".into()
        });
        let mut elements = Vec::new();
        for (index, cue_index) in items.iter().enumerate() {
            let mut build = json!({"index":index,"caption":caption_values[*cue_index],"canvasSize":input["canvasSize"],"layoutSettings":input["settings"],"defaults":input["defaults"],"fontSizeScaleReference":input["fontSizeScaleReference"]});
            for key in [
                "revealMode",
                "transitionIn",
                "wordAnimationId",
                "accentColor",
                "wordDirection",
            ] {
                if let Some(v) = input["settings"].get(key) {
                    build[key] = v.clone();
                }
            }
            let mut element = if let Some(provider) = measure.as_mut() {
                build_caption_text_element(&build, Some(&mut **provider))?
            } else {
                build_caption_text_element(&build, None)?
            };
            element["id"] = json!(fresh_id()?);
            elements.push(element);
        }
        track["elements"] = json!(elements);
        let mut updated_source = source.clone();
        updated_source["sourceId"] = source_id.clone();
        updated_source["words"] = json!(next_words);
        updated_source["settings"] = input["settings"].clone();
        updated_source["layerIndex"] = json!(layer_index);
        updated_source["layerCount"] = json!(layers.layers.len());
        track["captionSource"] = updated_source;
        generated.push(track);
    }
    let presentation = caption_track_presentation_plan(
        &generated,
        &source_tracks,
        array(&input["ignoredEditedElements"]),
    );
    let mut references = Vec::new();
    for binding in presentation
        .references
        .into_iter()
        .filter(|r| r.root == "source")
    {
        let (index, path) = binding.source[1..]
            .split_once('/')
            .ok_or("Invalid caption reference")?;
        let i: usize = index.parse().map_err(|_| "Invalid caption reference")?;
        references.push(CaptionReference {
            root: "input",
            source: format!("/tracks/overlay/{}/{path}", indices[i]),
            target: format!("/overlay{}", binding.target),
        });
    }
    let generated_count = presentation.tracks.len();
    for i in 0..generated_count {
        for key in ["words", "settings"] {
            references.push(CaptionReference {
                root: "input",
                source: format!("/{key}"),
                target: format!("/overlay/{i}/captionSource/{key}"),
            });
        }
    }
    for (track, e, source) in edited_refs {
        references.push(CaptionReference {
            root: "input",
            source,
            target: format!("/overlay/{}/elements/{e}", generated_count + track),
        });
    }
    let mut next_overlay = presentation.tracks;
    next_overlay.extend(edited);
    for (i, track) in overlay
        .iter()
        .enumerate()
        .filter(|(_, t)| !source_ids.contains(text(&t["id"])))
    {
        references.push(CaptionReference {
            root: "input",
            source: format!("/tracks/overlay/{i}"),
            target: format!("/overlay/{}", next_overlay.len()),
        });
        next_overlay.push(track.clone());
    }
    let mut result = tracks.clone();
    result["overlay"] = json!(next_overlay);
    for key in tracks
        .as_object()
        .ok_or("Invalid scene tracks")?
        .keys()
        .filter(|k| *k != "overlay")
    {
        let escaped = key.replace('~', "~0").replace('/', "~1");
        references.push(CaptionReference {
            root: "input",
            source: format!("/tracks/{escaped}"),
            target: format!("/{escaped}"),
        });
    }
    Ok(CaptionScenePlan {
        tracks: Some(result),
        references,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CaptionTextMeasureQuery;
    #[test]
    fn grouping_respects_stable_ids_and_legacy_generated_spans() {
        let source = json!({"words":[{"text":"one","start":0,"end":1}],"layerCount":2});
        assert!(caption_sources_match(
            &json!({"captionSource":{"words":[{"text":"other","start":0.2,"end":1.2},{"text":"manual","source":{"type":"text-layer"}}],"layerCount":2}}),
            &source
        ));
        assert!(!caption_sources_match(
            &json!({"captionSource":{"sourceId":"other","words":[]}}),
            &json!({"sourceId":"original","words":[]})
        ));
        assert!(!caption_sources_match(
            &json!({"captionSource":{"words":[{"start":2,"end":3}],"layerCount":2}}),
            &source
        ));
    }
    #[test]
    fn no_source_rebuild_allocates_nothing_and_measurement_failure_preserves_input() {
        let mut allocate = || Err("No allocation expected".into());
        let empty = json!({"tracks":{"overlay":[],"main":{"id":"main"},"audio":[]}});
        assert!(
            rebuild_caption_scene(&empty, &mut allocate, None)
                .unwrap()
                .tracks
                .is_none()
        );
        let input = json!({"tracks":{"overlay":[{"id":"source-track","type":"text","elements":[],"captionSource":{"sourceId":"source","words":[],"settings":{}}}],"main":{"id":"main"},"audio":[]},"preserveEditedElements":false,"words":[{"text":"one two","start":0,"end":1}],"settings":{},"canvasSize":{"width":100,"height":100},"trackDefaults":{"type":"text","hidden":false,"elements":[]},"defaults":{"element":{"type":"text","params":{}}}});
        let before = input.clone();
        let mut next = 0;
        let mut allocate = || {
            next += 1;
            Ok(format!("id-{next}"))
        };
        assert!(
            rebuild_caption_scene(
                &input,
                &mut allocate,
                Some(&mut |_: &CaptionTextMeasureQuery| Err("Unavailable font".into()))
            )
            .is_err()
        );
        assert_eq!(input, before);
    }
}
