//! Caption clip building. Only glyph widths are supplied by the platform;
//! wrapping, geometry, word timing and serializable clip state are shared policy.
use super::caption_sync::{js_whitespace, strip_caption_punctuation};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::MediaTime;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTextMeasureQuery {
    pub text: String,
    pub font: String,
    pub letter_spacing: f64,
}
pub type CaptionWidthMeasure<'a> = dyn FnMut(&CaptionTextMeasureQuery) -> Result<f64, String> + 'a;
fn n(v: &Value, fallback: f64) -> f64 {
    v.as_f64().unwrap_or(fallback)
}
fn s<'a>(v: &'a Value, fallback: &'a str) -> &'a str {
    v.as_str().unwrap_or(fallback)
}
fn words(value: &str) -> Vec<&str> {
    value
        .split(js_whitespace)
        .filter(|s| !s.is_empty())
        .collect()
}
fn ticks(v: f64) -> Result<i64, String> {
    MediaTime::from_seconds_f64(v)
        .map(MediaTime::as_ticks)
        .ok_or_else(|| "Caption timing is not finite or representable".into())
}
fn object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
fn metric(
    measure: &mut CaptionWidthMeasure<'_>,
    text: &str,
    font: &str,
    spacing: f64,
) -> Result<f64, String> {
    let width = measure(&CaptionTextMeasureQuery {
        text: text.into(),
        font: font.into(),
        letter_spacing: spacing,
    })?;
    if width.is_finite() && width >= 0.0 {
        Ok(width)
    } else {
        Err("Invalid caption glyph width".into())
    }
}
fn wrap(
    text: &str,
    maximum: f64,
    font: &str,
    spacing: f64,
    measure: &mut CaptionWidthMeasure<'_>,
) -> Result<String, String> {
    let normalized = text.trim_matches(js_whitespace).replace("\r\n", "\n");
    let mut paragraphs = Vec::new();
    for paragraph in normalized.split('\n') {
        let parts = words(paragraph);
        let Some(first) = parts.first() else {
            paragraphs.push(String::new());
            continue;
        };
        let mut lines = Vec::new();
        let mut current = (*first).to_owned();
        for word in parts.iter().skip(1) {
            let candidate = format!("{current} {word}");
            if metric(measure, &candidate, font, spacing)? <= maximum {
                current = candidate;
            } else {
                lines.push(current);
                current = (*word).into();
            }
        }
        lines.push(current);
        paragraphs.push(lines.join("\n"));
    }
    Ok(paragraphs.join("\n"))
}
/// Shared primitive used by clip authoring and canonical preflight metric replay.
pub fn readable_caption_word_timings(
    words: &[(f64, f64)],
    start: f64,
    end: f64,
) -> Vec<(f64, f64)> {
    let mut result: Vec<_> = words
        .iter()
        .map(|(s, e)| (start.max(*s), end.min(e.max(s + 0.001))))
        .collect();
    if result.len() == 1 {
        result[0] = (start, end);
    } else if let Some(last_index) = result.len().checked_sub(1) {
        let previous_end = result[last_index - 1].1;
        let last = &mut result[last_index];
        last.0 = (last.1 - 0.001).min(start.max(previous_end).max(last.0.min(last.1 - 0.45)));
    }
    result
}
fn word_runs(caption: &Value, content: &str, hide: bool) -> Result<Option<Value>, String> {
    let start = n(&caption["startTime"], 0.0);
    let duration = n(&caption["duration"], 0.0);
    let raw: Vec<(String, f64, f64)> =
        if let Some(items) = caption["words"].as_array().filter(|w| !w.is_empty()) {
            items
                .iter()
                .map(|w| {
                    (
                        s(&w["text"], "").into(),
                        n(&w["start"], 0.0),
                        n(&w["end"], 0.0),
                    )
                })
                .collect()
        } else {
            let parts = words(s(&caption["text"], ""));
            let span = duration.max(0.001) / parts.len().max(1) as f64;
            parts
                .iter()
                .enumerate()
                .map(|(i, w)| {
                    (
                        (*w).into(),
                        start + i as f64 * span,
                        start + (i + 1) as f64 * span,
                    )
                })
                .collect()
        };
    let source: Vec<_> = raw
        .into_iter()
        .filter_map(|(text, start, end)| {
            let text = if hide {
                strip_caption_punctuation(&text)
            } else {
                text
            };
            (!hide || !text.is_empty()).then_some((text, start, end))
        })
        .collect();
    if source.is_empty() {
        return Ok(None);
    }
    let times = readable_caption_word_timings(
        &source.iter().map(|(_, s, e)| (*s, *e)).collect::<Vec<_>>(),
        start,
        start + duration,
    );
    let lines: Vec<_> = content
        .split('\n')
        .enumerate()
        .flat_map(|(line, text)| std::iter::repeat_n(line, words(text).len()))
        .collect();
    let runs: Result<Vec<_>,String> = source.iter().enumerate().map(|(i,(text,_,_))| Ok(json!({
        "id":format!("word-{i}"),"text":text,"lineIndex":lines.get(i).copied().unwrap_or(0),
        "startTime":ticks((times[i].0 - start).max(0.0))?,"endTime":ticks((times[i].1 - start).max(0.001))?
    }))).collect();
    Ok(Some(json!(runs?)))
}
/// Build a complete caption clip from the product's published text defaults.
/// `None` measurement matches the existing unavailable-canvas fallback.
pub fn build_caption_text_element(
    input: &Value,
    mut measure: Option<&mut CaptionWidthMeasure<'_>>,
) -> Result<Value, String> {
    let defaults = &input["defaults"];
    if !defaults["element"].is_object() || !defaults["element"]["params"].is_object() {
        return Err("Caption product defaults are required".into());
    }
    let caption = &input["caption"];
    let style = &caption["style"];
    let layout = &input["layoutSettings"];
    let placement = &style["placement"];
    let width = n(&input["canvasSize"]["width"], 0.0);
    let height = n(&input["canvasSize"]["height"], 0.0);
    let scale_reference = n(&input["fontSizeScaleReference"], 90.0);
    if !scale_reference.is_finite() || scale_reference <= 0.0 {
        return Err("Invalid caption font scale reference".into());
    }
    let size = style["fontSizeRatioOfPlayHeight"]
        .as_f64()
        .map(|r| r * scale_reference)
        .unwrap_or_else(|| n(&style["fontSize"], 3.0));
    let family = s(&style["fontFamily"], "Arial");
    let align = s(&style["textAlign"], "center");
    let weight = s(&style["fontWeight"], "bold");
    let font_style = s(&style["fontStyle"], "normal");
    let spacing = n(&style["letterSpacing"], n(&defaults["letterSpacing"], 0.0));
    let line_height = n(&style["lineHeight"], n(&defaults["lineHeight"], 1.2));
    let font = format!(
        "{} {} {}px \"{}\", sans-serif",
        if font_style == "italic" {
            "italic"
        } else {
            "normal"
        },
        weight,
        size * (height / scale_reference),
        family.replace('"', "\\\"")
    );
    let left_margin = n(&placement["marginLeftRatio"], 0.0);
    let right_margin = n(&placement["marginRightRatio"], 0.0);
    let maximum = if left_margin > 0.0 || right_margin > 0.0 {
        (width * (1.0 - left_margin - right_margin)).max(0.0)
    } else {
        width * 0.8
    };
    let hide = layout["hidePunctuation"] == true;
    let display = if hide {
        strip_caption_punctuation(s(&caption["text"], ""))
    } else {
        s(&caption["text"], "").into()
    };
    let manual = layout["placementMode"] == "manual";
    let mut x = if manual {
        n(&layout["manualPositionX"], 0.0)
    } else {
        0.0
    };
    let mut y = if manual {
        n(&layout["manualPositionY"], 0.0)
    } else {
        0.0
    };
    let mut content = display.clone();
    let mut background = object(&defaults["background"]);
    background.insert("enabled".into(), json!(false));
    background.extend(object(&style["background"]));
    let background = Value::Object(background);
    if let Some(measure) = measure.as_mut() {
        content = wrap(&display, maximum, &font, spacing, *measure)?;
        let mut block_width = 0.0_f64;
        let lines: Vec<_> = content.split('\n').collect();
        for line in &lines {
            block_width = block_width.max(metric(*measure, line, &font, spacing)?);
        }
        let block_height = lines.len() as f64 * (line_height * (size * (height / scale_reference)));
        let mut left = match align {
            "left" => 0.0,
            "right" => -block_width,
            _ => -block_width / 2.0,
        };
        let mut top = -block_height / 2.0;
        let mut rect_width = block_width;
        let mut rect_height = block_height;
        let color = s(&background["color"], "");
        if background["enabled"] == true && !color.is_empty() && color != "transparent" {
            let ratio = size / 15.0;
            let px = n(
                &background["paddingX"],
                n(&defaults["background"]["paddingX"], 30.0),
            ) * ratio;
            let py = n(
                &background["paddingY"],
                n(&defaults["background"]["paddingY"], 42.0),
            ) * ratio;
            let bg_left = left - px
                + n(
                    &background["offsetX"],
                    n(&defaults["background"]["offsetX"], 0.0),
                );
            let bg_top = top - py
                + n(
                    &background["offsetY"],
                    n(&defaults["background"]["offsetY"], 0.0),
                );
            let right = (left + rect_width).max(bg_left + (block_width + 2.0 * px));
            let bottom = (top + rect_height).max(bg_top + (block_height + 2.0 * py));
            left = left.min(bg_left);
            top = top.min(bg_top);
            rect_width = right - left;
            rect_height = bottom - top;
        }
        if !manual {
            if layout["placementMode"] == "grid" {
                let ratio = width.max(1.0) / height.max(1.0);
                let (columns, rows) = if (ratio - 1.0).abs() <= 0.05 {
                    (3.0, 3.0)
                } else if ratio > 1.0 {
                    (5.0, 3.0)
                } else {
                    (3.0, 5.0)
                };
                let grid_index = |v: &Value, count: f64| {
                    let v = n(v, 0.0) * (count - 1.0);
                    if v.is_finite() {
                        (v + 0.5).floor().clamp(0.0, count - 1.0)
                    } else {
                        0.0
                    }
                };
                x = ((grid_index(&layout["placementGridX"], columns) + 0.5) / columns) * width
                    - (left + rect_width / 2.0)
                    - width / 2.0;
                y = ((grid_index(&layout["placementGridY"], rows) + 0.5) / rows) * height
                    - (top + rect_height / 2.0)
                    - height / 2.0;
            } else {
                let lm = width * left_margin;
                let rm = width * right_margin;
                x = match align {
                    "left" => lm - left - width / 2.0,
                    "right" => width - rm - (left + rect_width) - width / 2.0,
                    _ => lm + (width - lm - rm) / 2.0 - (left + rect_width / 2.0) - width / 2.0,
                };
                let margin = height * n(&placement["marginVerticalRatio"], 0.05);
                y = match s(&placement["verticalAlign"], "bottom") {
                    "top" => margin - top - height / 2.0,
                    "middle" => height / 2.0 - (top + rect_height / 2.0) - height / 2.0,
                    _ => height - margin - (top + rect_height) - height / 2.0,
                };
            }
        }
    }
    let mut result = defaults["element"].clone();
    result["name"] = json!(format!(
        "Caption {}",
        input["index"].as_u64().unwrap_or(0) + 1
    ));
    // Replace only horizontal spacing around existing newlines, as the old
    // responsive-source field does; preserve multiline semantics elsewhere.
    let display_lines: Vec<_> = display.split('\n').collect();
    let responsive = display_lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let line = if i > 0 {
                line.trim_start_matches([' ', '\t'])
            } else {
                line
            };
            if i + 1 < display_lines.len() {
                line.trim_end_matches([' ', '\t'])
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    result["responsiveText"] = json!({"sourceContent":responsive,"generatedContent":content,"maxWidth":maximum,"canvasHeight":height,"fontSize":size});
    if let Some(runs) = word_runs(caption, &content, hide)? {
        result["wordRuns"] = runs;
    } else {
        result.as_object_mut().unwrap().remove("wordRuns");
    }
    for key in [
        "revealMode",
        "transitionIn",
        "wordAnimationId",
        "accentColor",
        "wordDirection",
    ] {
        let output = format!("caption{}{}", key[..1].to_uppercase(), &key[1..]);
        if let Some(v) = input.get(key) {
            result[&output] = v.clone();
        } else {
            result.as_object_mut().unwrap().remove(&output);
        }
    }
    result["duration"] = json!(ticks(n(&caption["duration"], 0.0))?);
    result["startTime"] = json!(ticks(n(&caption["startTime"], 0.0))?);
    let params = result["params"].as_object_mut().unwrap();
    for (key, value) in [
        ("content", json!(content)),
        ("fontSize", json!(size)),
        ("fontFamily", json!(family)),
        ("color", json!(s(&style["color"], "#ffffff"))),
        ("textAlign", json!(align)),
        ("fontWeight", json!(weight)),
        ("fontStyle", json!(font_style)),
        ("textDecoration", json!(s(&style["textDecoration"], "none"))),
        ("letterSpacing", json!(spacing)),
        ("lineHeight", json!(line_height)),
        ("background.enabled", background["enabled"].clone()),
        ("background.color", background["color"].clone()),
        ("shadow.enabled", json!(true)),
        ("shadow.blur", json!(50)),
        ("shadow.offsetX", json!(0)),
        ("shadow.offsetY", json!(0)),
        ("transform.positionX", json!(x)),
        ("transform.positionY", json!(y)),
        (
            "bottomFadeOutEndOpacity",
            defaults["bottomFadeOutEndOpacity"].clone(),
        ),
    ] {
        params.insert(key.into(), value);
    }
    let fade = if layout["bottomFadeOutPercent"]["nonFinite"] == true {
        0.0
    } else {
        n(&layout["bottomFadeOutPercent"], 60.0).clamp(0.0, 100.0) / 100.0
    };
    params.insert("bottomFadeOut".into(), json!(fade));
    for key in ["cornerRadius", "paddingX", "paddingY", "offsetX", "offsetY"] {
        let value = background
            .get(key)
            .filter(|v| !v.is_null())
            .unwrap_or(&defaults["background"][key]);
        params.insert(format!("background.{key}"), value.clone());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"index":0,"caption":{"text":"one two three","startTime":1,"duration":1},"canvasSize":{"width":100,"height":100},
        "defaults":{"element":{"type":"text","trimStart":0,"trimEnd":0,"params":{"opacity":1}},"background":{"color":"#000000","paddingX":30,"paddingY":42},"bottomFadeOutEndOpacity":0.25}})
    }
    #[test]
    fn measurements_wrap_and_can_be_replayed_without_policy_in_the_host() {
        let mut trace = Map::new();
        let mut measure = |q: &CaptionTextMeasureQuery| {
            let width = q.text.len() as f64 * 10.0;
            trace.insert(q.text.clone(), json!(width));
            Ok(width)
        };
        let original = input();
        let measured = build_caption_text_element(&original, Some(&mut measure)).unwrap();
        let mut replay = |q: &CaptionTextMeasureQuery| {
            trace[&q.text]
                .as_f64()
                .ok_or_else(|| "Missing metric".into())
        };
        assert_eq!(
            build_caption_text_element(&original, Some(&mut replay)).unwrap(),
            measured
        );
        assert_eq!(measured["params"]["content"], "one two\nthree");
        assert_eq!(measured["wordRuns"][2]["lineIndex"], 1);
        assert_eq!(measured["startTime"], 120000);
        assert_eq!(original, input());
    }
    #[test]
    fn no_measurement_preserves_multiline_and_manual_placement_and_rejects_bad_widths() {
        let mut input = input();
        input["caption"]["text"] = json!("one\n two");
        input["layoutSettings"] =
            json!({"placementMode":"manual","manualPositionX":42,"manualPositionY":-7});
        let built = build_caption_text_element(&input, None).unwrap();
        assert_eq!(built["params"]["content"], "one\n two");
        assert_eq!(built["params"]["transform.positionX"], 42.0);
        assert_eq!(built["params"]["transform.positionY"], -7.0);
        assert!(build_caption_text_element(&input, Some(&mut |_| Ok(f64::NAN))).is_err());
    }
}
