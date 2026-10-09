//! Caption reconstruction policy: stable identities and inherited presentation.
//! The host supplies measured regenerated elements; font measurement is external.
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPresentationOptions {
    pub input_json: String,
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn number(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn content(v: &Value) -> &str {
    text(&v["params"]["content"])
}
fn span(e: &Value) -> (f64, f64) {
    let start = number(&e["startTime"]) / 120_000.0;
    (start, start + number(&e["duration"]) / 120_000.0)
}
fn presentation_source(time: (f64, f64), elements: &[&Value]) -> Option<usize> {
    let mut best = None;
    let mut best_overlap = -1.0;
    let mut best_distance = f64::INFINITY;
    let middle = (time.0 + time.1) / 2.0;
    for (i, element) in elements.iter().enumerate() {
        let candidate = span(element);
        let overlap = (time.1.min(candidate.1) - time.0.max(candidate.0)).max(0.0);
        let distance = ((candidate.0 + candidate.1) / 2.0 - middle).abs();
        if best.is_none()
            || overlap > best_overlap
            || (overlap == best_overlap && distance < best_distance)
        {
            best = Some(i);
            best_overlap = overlap;
            best_distance = distance;
        }
    }
    best
}
fn replace(object: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        object.insert(key.to_owned(), value.clone());
    } else {
        object.remove(key);
    }
}
fn enum_param<'a>(params: &'a Value, key: &str, allowed: &[&str]) -> Option<&'a Value> {
    params
        .get(key)
        .filter(|v| v.as_str().is_some_and(|s| allowed.contains(&s)))
}
fn style(cue: &Value, source: &Value) -> Value {
    let mut result = cue["style"].as_object().cloned().unwrap_or_default();
    let params = &source["params"];
    for key in ["fontFamily", "color"] {
        replace(&mut result, key, params.get(key).filter(|v| v.is_string()));
    }
    for key in ["fontSize", "letterSpacing", "lineHeight"] {
        replace(&mut result, key, params.get(key).filter(|v| v.is_number()));
    }
    for (key, allowed) in [
        ("textAlign", &["left", "center", "right"][..]),
        ("fontStyle", &["normal", "italic"][..]),
        ("textDecoration", &["none", "underline", "line-through"][..]),
    ] {
        replace(&mut result, key, enum_param(params, key, allowed));
    }
    if let Some(weight) = params["fontWeight"].as_str() {
        let weight = weight
            .trim_matches(super::caption_sync::js_whitespace)
            .to_lowercase();
        result.insert(
            "fontWeight".into(),
            json!(if [
                "normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"
            ]
            .contains(&weight.as_str())
            {
                weight.as_str()
            } else {
                "normal"
            }),
        );
    } else {
        result.remove("fontWeight");
    }
    let mut background = Map::new();
    background.insert(
        "enabled".into(),
        json!(params["background.enabled"].as_bool().unwrap_or(false)),
    );
    background.insert(
        "color".into(),
        json!(params["background.color"].as_str().unwrap_or("#000000")),
    );
    for key in ["cornerRadius", "paddingX", "paddingY", "offsetX", "offsetY"] {
        if let Some(v) = params
            .get(format!("background.{key}"))
            .filter(|v| v.is_number())
        {
            background.insert(key.into(), v.clone());
        }
    }
    result.insert("background".into(), Value::Object(background));
    Value::Object(result)
}
/// Source selection uses largest overlap, then nearest midpoint, then source order.
/// Return only styles so the host keeps the original cue/word references.
pub fn caption_cue_presentation_styles(
    cues: &[Value],
    source_tracks: &[Value],
) -> Vec<Option<Value>> {
    let elements: Vec<_> = source_tracks
        .iter()
        .flat_map(|t| array(&t["elements"]))
        .collect();
    cues.iter()
        .map(|cue| {
            let start = number(&cue["startTime"]);
            presentation_source((start, start + number(&cue["duration"])), &elements)
                .map(|i| style(cue, elements[i]))
        })
        .collect()
}
#[derive(Serialize)]
pub struct CaptionReference {
    #[serde(rename = "from")]
    pub root: &'static str,
    pub source: String,
    pub target: String,
}
#[derive(Serialize)]
pub struct CaptionTrackPresentationPlan {
    pub tracks: Vec<Value>,
    pub references: Vec<CaptionReference>,
}
fn pointer_key(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
fn reference(refs: &mut Vec<CaptionReference>, root: &'static str, source: String, target: String) {
    refs.push(CaptionReference {
        root,
        source,
        target,
    });
}
const WORD_PRESENTATION: &[&str] = &[
    "style",
    "revealMode",
    "transitionIn",
    "wordAnimationId",
    "accentColor",
    "wordDirection",
];
fn merge_presentation(
    generated: &Value,
    source: &Value,
    source_path: &str,
    target_path: &str,
    refs: &mut Vec<CaptionReference>,
) -> Value {
    let mut result = generated.clone();
    let object = result
        .as_object_mut()
        .expect("caption element must be an object");
    for key in [
        "hidden",
        "effects",
        "animations",
        "transitions",
        "textRowOverrides",
        "captionRevealMode",
        "captionTransitionIn",
        "captionWordAnimationId",
        "captionAccentColor",
        "captionWordDirection",
    ] {
        if let Some(value) = source.get(key).filter(|v| !v.is_null()) {
            object.insert(key.into(), value.clone());
            reference(
                refs,
                "source",
                format!("{source_path}/{key}"),
                format!("{target_path}/{key}"),
            );
        }
    }
    let mut params = generated["params"].as_object().cloned().unwrap_or_default();
    if let Some(source_params) = source["params"].as_object() {
        params.extend(source_params.clone());
    }
    for key in ["content", "transform.positionX", "transform.positionY"] {
        replace(&mut params, key, generated["params"].get(key));
    }
    object.insert("params".into(), Value::Object(params));
    let runs = array(&generated["wordRuns"]);
    let source_runs = array(&source["wordRuns"]);
    if !runs.is_empty() && !source_runs.is_empty() {
        let mut used = HashSet::new();
        let merged: Vec<_> = runs
            .iter()
            .enumerate()
            .map(|(index, run)| {
                let found = source_runs
                    .iter()
                    .enumerate()
                    .find(|(i, s)| !used.contains(i) && s["text"] == run["text"])
                    .map(|(i, _)| i)
                    .or_else(|| {
                        (index < source_runs.len() && !used.contains(&index)).then_some(index)
                    });
                let Some(i) = found else {
                    reference(
                        refs,
                        "generated",
                        format!("{target_path}/wordRuns/{index}"),
                        format!("{target_path}/wordRuns/{index}"),
                    );
                    return run.clone();
                };
                used.insert(i);
                let mut result = run.as_object().cloned().unwrap_or_default();
                if let Some(fields) = run.as_object() {
                    for key in fields
                        .keys()
                        .filter(|k| !WORD_PRESENTATION.contains(&k.as_str()))
                    {
                        let key = pointer_key(key);
                        reference(
                            refs,
                            "generated",
                            format!("{target_path}/wordRuns/{index}/{key}"),
                            format!("{target_path}/wordRuns/{index}/{key}"),
                        );
                    }
                }
                for key in WORD_PRESENTATION.iter().copied() {
                    replace(&mut result, key, source_runs[i].get(key));
                    if source_runs[i].get(key).is_some() {
                        reference(
                            refs,
                            "source",
                            format!("{source_path}/wordRuns/{i}/{key}"),
                            format!("{target_path}/wordRuns/{index}/{key}"),
                        );
                    }
                }
                Value::Object(result)
            })
            .collect();
        object.insert("wordRuns".into(), Value::Array(merged));
    } else if generated.get("wordRuns").is_some() {
        reference(
            refs,
            "generated",
            format!("{target_path}/wordRuns"),
            format!("{target_path}/wordRuns"),
        );
    }
    result
}
/// Keep reusable element IDs/name, inherited animation/effects/word styling,
/// and preferred track ownership while retaining newly measured content/position.
pub fn inherit_caption_track_presentation(
    generated: &[Value],
    source_tracks: &[Value],
    preferred_refs: &[Value],
) -> Vec<Value> {
    caption_track_presentation_plan(generated, source_tracks, preferred_refs).tracks
}
pub fn caption_track_presentation_plan(
    generated: &[Value],
    source_tracks: &[Value],
    preferred_refs: &[Value],
) -> CaptionTrackPresentationPlan {
    let elements: Vec<_> = source_tracks
        .iter()
        .flat_map(|t| array(&t["elements"]))
        .collect();
    let element_paths: Vec<_> = source_tracks
        .iter()
        .enumerate()
        .flat_map(|(t, track)| {
            array(&track["elements"])
                .iter()
                .enumerate()
                .map(move |(e, _)| format!("/{t}/elements/{e}"))
        })
        .collect();
    let mut references = Vec::new();
    let track_by_id: HashMap<_, _> = source_tracks.iter().map(|t| (text(&t["id"]), t)).collect();
    let owner_by_id: HashMap<_, _> = source_tracks
        .iter()
        .flat_map(|t| {
            array(&t["elements"])
                .iter()
                .map(|e| (text(&e["id"]), text(&t["id"])))
        })
        .collect();
    let preferred: HashSet<_> = preferred_refs
        .iter()
        .map(|r| text(&r["elementId"]))
        .collect();
    let mut used_elements = HashSet::new();
    let mut matches: Vec<Vec<String>> = vec![vec![]; generated.len()];
    let mut result: Vec<_> = generated
        .iter()
        .enumerate()
        .map(|(track_index, track)| {
            if let Some(fields) = track.as_object() {
                for key in fields
                    .keys()
                    .filter(|k| !["id", "name", "hidden", "elements"].contains(&k.as_str()))
                {
                    let key = pointer_key(key);
                    reference(
                        &mut references,
                        "generated",
                        format!("/{track_index}/{key}"),
                        format!("/{track_index}/{key}"),
                    );
                }
            }
            let mut track = track.clone();
            let items: Vec<_> = array(&track["elements"])
                .iter()
                .enumerate()
                .map(|(element_index, element)| {
                    let target_path = format!("/{track_index}/elements/{element_index}");
                    let start = number(&element["startTime"]) / 120_000.0;
                    let duration = number(&element["duration"]) / 120_000.0;
                    let reusable = elements.iter().position(|candidate| {
                        !used_elements.contains(text(&candidate["id"]))
                            && content(candidate) == content(element)
                            && (number(&candidate["startTime"]) / 120_000.0 - start).abs() <= 0.002
                            && (number(&candidate["duration"]) / 120_000.0 - duration).abs()
                                <= 0.002
                    });
                    let source = reusable.or_else(|| presentation_source(span(element), &elements));
                    if source.is_some() {
                        if let Some(fields) = element.as_object() {
                            for key in fields.keys().filter(|k| {
                                !["id", "name", "params", "wordRuns"].contains(&k.as_str())
                            }) {
                                let key = pointer_key(key);
                                reference(
                                    &mut references,
                                    "generated",
                                    format!("{target_path}/{key}"),
                                    format!("{target_path}/{key}"),
                                );
                            }
                        }
                    } else {
                        reference(
                            &mut references,
                            "generated",
                            target_path.clone(),
                            target_path.clone(),
                        );
                    }
                    let mut item = source
                        .map(|i| {
                            merge_presentation(
                                element,
                                elements[i],
                                &element_paths[i],
                                &target_path,
                                &mut references,
                            )
                        })
                        .unwrap_or_else(|| element.clone());
                    if let Some(i) = reusable {
                        let id = text(&elements[i]["id"]);
                        used_elements.insert(id.to_owned());
                        matches[track_index].push(id.to_owned());
                        item["id"] = elements[i]["id"].clone();
                        if let Some(name) = elements[i].get("name") {
                            item["name"] = name.clone();
                        } else {
                            item.as_object_mut().unwrap().remove("name");
                        }
                    }
                    item
                })
                .collect();
            track["elements"] = Value::Array(items);
            track
        })
        .collect();
    let mut used_tracks = HashSet::new();
    let mut assigned = HashMap::new();
    for (index, ids) in matches.iter().enumerate() {
        if let Some(id) = ids
            .iter()
            .filter(|id| preferred.contains(id.as_str()))
            .filter_map(|id| owner_by_id.get(id.as_str()))
            .find(|id| !id.is_empty() && !used_tracks.contains(**id))
        {
            used_tracks.insert((*id).to_owned());
            assigned.insert(index, (*id).to_owned());
        }
    }
    for (index, track) in result.iter_mut().enumerate() {
        let fallback = source_tracks
            .get(index)
            .filter(|t| !used_tracks.contains(text(&t["id"])))
            .or_else(|| {
                source_tracks
                    .iter()
                    .find(|t| !used_tracks.contains(text(&t["id"])))
            })
            .map(|t| text(&t["id"]).to_owned());
        if let Some(id) = assigned.get(&index).cloned().or(fallback) {
            used_tracks.insert(id.clone());
            track["id"] = json!(id);
            if let Some(previous) = track_by_id.get(id.as_str()) {
                for key in ["name", "hidden"] {
                    if let Some(v) = previous.get(key).filter(|v| !v.is_null()) {
                        track[key] = v.clone();
                    }
                }
            }
        }
    }
    CaptionTrackPresentationPlan {
        tracks: result,
        references,
    }
}
#[export]
pub fn plan_caption_presentation(
    CaptionPresentationOptions { input_json }: CaptionPresentationOptions,
) -> String {
    let input: Value =
        serde_json::from_str(&input_json).expect("caption presentation input must be JSON");
    match input["mode"].as_str() {
        Some("styles") => {
            let source_tracks = array(&input["sourceTracks"]);
            if source_tracks
                .iter()
                .all(|t| array(&t["elements"]).is_empty())
            {
                "null".to_owned()
            } else {
                serde_json::to_string(&caption_cue_presentation_styles(
                    array(&input["cues"]),
                    source_tracks,
                ))
                .unwrap()
            }
        }
        Some("tracks") => serde_json::to_string(&caption_track_presentation_plan(
            array(&input["generatedTracks"]),
            array(&input["sourceTracks"]),
            array(&input["preferredElementRefs"]),
        ))
        .unwrap(),
        _ => panic!("unknown caption presentation phase"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn styles_select_overlap_and_remove_undefined_overrides() {
        let cues = vec![
            json!({"startTime":1,"duration":1,"style":{"color":"red","placement":{"verticalAlign":"top"},"fontSizeRatioOfPlayHeight":0.1}}),
        ];
        let tracks = vec![json!({"elements":[
            {"startTime":0,"duration":120000,"params":{"color":"red"}},
            {"startTime":120000,"duration":120000,"params":{"fontWeight":" 700 ","background.enabled":true}}]})];
        let result = caption_cue_presentation_styles(&cues, &tracks);
        assert_eq!(
            result,
            vec![Some(
                json!({"fontWeight":"700","background":{"enabled":true,"color":"#000000"},"placement":{"verticalAlign":"top"},"fontSizeRatioOfPlayHeight":0.1})
            )]
        );
    }
    #[test]
    fn reference_plan_preserves_json_values_and_escapes_extension_keys() {
        let generated = vec![
            json!({"id":"new","captionSource":{"words":[]},"opaque~/field":{"flag":true},"elements":[
            {"id":"new-e","name":"New","startTime":0,"duration":120000,"params":{"content":"one"},"effects":[{"id":"new-fx"}],"wordRuns":[
                {"id":"new-run","text":"one","style":{"color":"green"},"opaque~/run":{"flag":true}}]}]}),
        ];
        let source = vec![json!({"id":"old","name":"Old","elements":[
            {"id":"old-e","name":"Old clip","startTime":0,"duration":120000,"params":{"content":"one"},"effects":[{"id":"source-fx"}],"wordRuns":[
                {"id":"old-run","text":"one","style":{"color":"blue"}}]}]})];
        let plan = caption_track_presentation_plan(&generated, &source, &[]);
        let originals = json!({"generated":generated,"source":source});
        let expected = json!(plan.tracks);
        let mut reconstructed = expected.clone();
        for binding in plan.references {
            let value = originals[binding.root]
                .pointer(&binding.source)
                .expect("binding source exists")
                .clone();
            *reconstructed
                .pointer_mut(&binding.target)
                .expect("binding target exists") = value;
        }
        assert_eq!(reconstructed, expected);
        assert_eq!(expected[0]["opaque~/field"]["flag"], true);
    }
    #[test]
    fn preferred_tracks_reuse_element_identity_without_reusing_timing_or_position() {
        let sources = vec![
            json!({"id":"a","name":"First","hidden":false,"elements":[{"id":"old-a","name":"Keep me","startTime":0,"duration":120000,"params":{"content":"one","transform.positionX":88},"effects":[{"id":"fx"}],"wordRuns":[{"id":"a","text":"one","style":{"color":"blue"}}]}]}),
            json!({"id":"b","name":"Second","hidden":true,"elements":[{"id":"old-b","name":"Other","startTime":120000,"duration":120000,"params":{"content":"two"}}]}),
        ];
        let generated = vec![
            json!({"id":"new-a","elements":[{"id":"new-e","startTime":120000,"duration":120000,"params":{"content":"two","transform.positionX":0}}]}),
            json!({"id":"new-b","elements":[{"id":"new-f","startTime":0,"duration":120000,"params":{"content":"one","transform.positionX":1},"wordRuns":[{"id":"new-word","text":"one","startTime":0,"endTime":120000}]}]}),
        ];
        let result = inherit_caption_track_presentation(
            &generated,
            &sources,
            &[json!({"trackId":"b","elementId":"old-b"})],
        );
        assert_eq!(result[0]["id"], "b");
        assert_eq!(result[1]["id"], "a");
        assert_eq!(result[0]["hidden"], true);
        assert_eq!(result[1]["elements"][0]["id"], "old-a");
        assert_eq!(result[1]["elements"][0]["params"]["transform.positionX"], 1);
        assert_eq!(result[1]["elements"][0]["wordRuns"][0]["id"], "new-word");
        assert_eq!(
            result[1]["elements"][0]["wordRuns"][0]["style"]["color"],
            "blue"
        );
        assert_eq!(result[1]["elements"][0]["effects"], json!([{"id":"fx"}]));
    }
}
