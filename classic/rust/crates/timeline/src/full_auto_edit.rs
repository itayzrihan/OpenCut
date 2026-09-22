//! Classic-only single-project recipe; host performs media/AI I/O and canonical transactions.
use crate::{CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullAutoEditOptions {
    pub zoom: bool,
    pub transitions: bool,
    pub word_animation: bool,
    #[serde(default)]
    pub music: bool,
}
#[export]
pub fn full_auto_edit_stages(o: FullAutoEditOptions) -> Vec<String> {
    let mut stages = vec!["preflight", "framing", "silence", "auto-texts", "finish"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if o.zoom {
        stages.push("zoom".into());
    }
    if o.transitions {
        stages.push("transitions".into());
    }
    if o.word_animation {
        stages.push("word-animation".into());
    }
    if o.music {
        stages.push("music".into());
    }
    stages.push("save".into());
    stages
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileFullAutoEditOptions {
    pub source_json: String,
    pub stage: String,
    pub framing_json: String,
    pub font_family: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullAutoEditResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Framing {
    element_id: String,
    width: f64,
    height: f64,
    samples: Vec<Detection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Detection {
    face_x: f64,
    body_x: f64,
    confidence: f64,
    person_count: u32,
}
#[export]
pub fn compile_full_auto_edit(o: CompileFullAutoEditOptions) -> FullAutoEditResult {
    match compile(o) {
        Ok(source_json) => FullAutoEditResult {
            valid: true,
            source_json,
            error: String::new(),
        },
        Err(error) => FullAutoEditResult {
            valid: false,
            source_json: String::new(),
            error,
        },
    }
}
fn compile(o: CompileFullAutoEditOptions) -> Result<String, String> {
    let c = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: o.source_json,
    });
    if !c.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value = serde_json::from_str(&c.formatted_json).map_err(|e| e.to_string())?;
    if o.stage == "framing" || o.stage == "center-subject" {
        let center_only = o.stage == "center-subject";
        if center_only
            && (doc["projectSettings"]["canvasSize"]["width"] != 1080
                || doc["projectSettings"]["canvasSize"]["height"] != 1920)
        {
            return Err("Local centering requires an existing 1080x1920 vertical canvas".into());
        }
        let framing: Vec<Framing> =
            serde_json::from_str(&o.framing_json).map_err(|e| e.to_string())?;
        let tracks = doc["scene"]["tracks"]
            .as_array_mut()
            .ok_or("Missing tracks")?;
        let main = tracks
            .iter_mut()
            .find(|t| t["area"] == "main")
            .ok_or("Missing main video")?;
        let es = main["elements"].as_array_mut().ok_or("Missing clips")?;
        if es.is_empty() || es.len() != framing.len() {
            return Err("Every main clip needs framing samples".into());
        }
        for e in es {
            if e["type"] != "video"
                || e.get("retime").is_some_and(|v| !v.is_null())
                || e.get("animations").is_some_and(|v| !v.is_null())
            {
                return Err("Full Auto Edit starts from ordinary imported video clips, without retiming or animated transforms".into());
            }
            let f = framing
                .iter()
                .find(|f| e["id"] == f.element_id)
                .ok_or("Missing clip detection")?;
            if !f.width.is_finite()
                || !f.height.is_finite()
                || f.width < 1.0
                || f.height < 1.0
                || f.samples.len() < 3
            {
                return Err("Need source dimensions and at least three framing samples".into());
            }
            let mut xs = Vec::new();
            for s in &f.samples {
                if !s.face_x.is_finite()
                    || !s.body_x.is_finite()
                    || !s.confidence.is_finite()
                    || !(0.0..=1.0).contains(&s.face_x)
                    || !(0.0..=1.0).contains(&s.body_x)
                    || !(0.8..=1.0).contains(&s.confidence)
                    || s.person_count != 1
                    || (s.face_x - s.body_x).abs() > 0.18
                {
                    return Err("Face/body framing is uncertain or has multiple people; review the source before Full Auto Edit".into());
                }
                xs.push(s.face_x * 0.8 + s.body_x * 0.2);
            }
            xs.sort_by(f64::total_cmp);
            // Stable talking-head crop, not an unsupported claim of continuous tracking.
            if xs.last().unwrap() - xs[0] > 0.12 {
                return Err(
                    "Speaker moves too far for a stable horizontal crop; manual framing required"
                        .into(),
                );
            }
            let scale = (1080.0 / f.width).max(1920.0 / f.height);
            let limit = ((f.width * scale - 1080.0) / 2.0).max(0.0);
            let x = ((0.5 - xs[xs.len() / 2]) * f.width * scale).clamp(-limit, limit);
            if center_only {
                if e["fitMode"] != "cover"
                    || ["transform.scaleX", "transform.scaleY"]
                        .iter()
                        .any(|k| e["params"][k].as_f64().unwrap_or(1.) != 1.)
                    || [
                        "transform.rotate",
                        "transform.perspectiveX",
                        "transform.perspectiveY",
                    ]
                    .iter()
                    .any(|k| e["params"][k].as_f64().unwrap_or(0.) != 0.)
                {
                    return Err("Local centering requires cover with unrotated, unscaled main clips; existing edit preserved".into());
                }
                e["params"]["transform.positionX"] = json!(x);
                continue;
            }
            e["fitMode"] = json!("cover");
            if !e["params"].is_object() {
                e["params"] = json!({});
            }
            for (key, value) in [
                ("transform.positionX", x),
                ("transform.positionY", 0.0),
                ("transform.scaleX", 1.0),
                ("transform.scaleY", 1.0),
                ("transform.rotate", 0.0),
                ("transform.perspectiveX", 0.0),
                ("transform.perspectiveY", 0.0),
            ] {
                e["params"][key] = json!(value);
            }
        }
        if !center_only {
            doc["projectSettings"]["canvasSize"] = json!({"width":1080,"height":1920});
            doc["projectSettings"]["canvasSizeMode"] = json!("preset");
        }
    } else if o.stage == "finish" {
        let normalized = o.font_family.to_lowercase().replace([' ', '-', '_'], "");
        if !["assistantbold", "assistantextrabold"].contains(&normalized.as_str()) {
            return Err("Load the Assistant Bold or Assistant ExtraBold custom font first".into());
        }
        let tracks = doc["scene"]["tracks"]
            .as_array_mut()
            .ok_or("Missing tracks")?;
        let end = tracks
            .iter()
            .filter(|t| t["area"] == "main")
            .flat_map(|t| t["elements"].as_array().into_iter().flatten())
            .map(|e| e["startTime"].as_i64().unwrap_or(0) + e["duration"].as_i64().unwrap_or(0))
            .max()
            .ok_or("Missing video")?;
        for t in tracks.iter_mut() {
            if let Some(es) = t["elements"].as_array_mut() {
                for e in es {
                    if e["type"] == "text" {
                        e["params"]["fontFamily"] = json!(o.font_family);
                        e["params"]["fontWeight"] = json!("normal"); // custom file already contains its bold weight
                        e["params"]["bottomFadeOut"] = json!(0.6);
                        e["params"]["bottomFadeOutEndOpacity"] = json!(0.25);
                        e["params"]["transform.positionX"] = json!(0);
                        e["params"]["transform.positionY"] = json!(0);
                    }
                }
            }
        }
        // Fresh imported-project recipe; never create a second edge feather on rerun.
        for t in tracks.iter_mut() {
            if let Some(es) = t["elements"].as_array_mut() {
                es.retain(|e| e["fullAutoEditOwner"] != "edge-feather-v1");
            }
        }
        tracks.retain(|t| {
            !(t["fullAutoEditOwner"] == "edge-feather-v1"
                && t["elements"].as_array().is_some_and(|es| es.is_empty()))
        });
        tracks.sort_by_key(|t| {
            if t["area"] == "overlay" && t["type"] == "text" {
                0
            } else if t["area"] == "overlay" {
                1
            } else if t["area"] == "main" {
                2
            } else {
                3
            }
        });
        let at = tracks
            .iter()
            .position(|t| t["area"] == "main")
            .ok_or("Missing main track")?;
        tracks.insert(at,json!({"id":"full-auto-edit:edge-track","type":"effect","area":"overlay","name":"Editorial Edge Feather","hidden":false,"fullAutoEditOwner":"edge-feather-v1","elements":[{"id":"full-auto-edit:edge","name":"Editorial Edge Feather","type":"effect","effectType":"editorial-edge-feather","startTime":0,"duration":end,"trimStart":0,"trimEnd":0,"fullAutoEditOwner":"edge-feather-v1","params":{"intensity":60,"height":30,"softness":80,"color":"#000000"}}]}));
    } else {
        return Err("Unknown Full Auto stage".into());
    }
    let c = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: doc.to_string(),
    });
    if !c.valid {
        return Err(format!("Invalid generated source: {:?}", c.diagnostics));
    }
    Ok(c.formatted_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Value {
        json!({"schemaVersion":2,"projectSettings":{"fps":30,"canvasSize":{"width":1920,"height":1080}},"scene":{"id":"s","tracks":[{"id":"v","type":"video","area":"main","elements":[{"id":"v1","type":"video","startTime":0,"duration":1200000,"params":{}}]}]}})
    }
    fn frame(x: f64) -> FullAutoEditResult {
        compile_full_auto_edit(CompileFullAutoEditOptions{source_json:source().to_string(),stage:"framing".into(),font_family:String::new(),framing_json:json!([{"elementId":"v1","width":1920,"height":1080,"samples":[{"faceX":x,"bodyX":x,"confidence":0.95,"personCount":1},{"faceX":x,"bodyX":x,"confidence":0.95,"personCount":1},{"faceX":x,"bodyX":x,"confidence":0.95,"personCount":1}]}]).to_string()})
    }
    #[test]
    fn options_are_independent_and_base_order_is_fixed() {
        for n in 0..16 {
            let s = full_auto_edit_stages(FullAutoEditOptions {
                zoom: n & 1 != 0,
                transitions: n & 2 != 0,
                word_animation: n & 4 != 0,
                music: n & 8 != 0,
            });
            assert_eq!(
                &s[..5],
                ["preflight", "framing", "silence", "auto-texts", "finish"]
            );
            assert_eq!(s.contains(&"zoom".into()), n & 1 != 0);
            assert_eq!(s.contains(&"transitions".into()), n & 2 != 0);
            assert_eq!(s.contains(&"word-animation".into()), n & 4 != 0);
            assert_eq!(s.contains(&"music".into()), n & 8 != 0);
            if n & 8 != 0 {
                assert_eq!(s[s.len() - 2], "music");
            }
            assert_eq!(s.last().unwrap(), "save");
        }
    }
    #[test]
    fn cover_centers_and_clamps_without_black_edges() {
        for x in [0.0, 0.3, 0.5, 0.7, 1.0] {
            let r = frame(x);
            assert!(r.valid, "{}", r.error);
            let d: Value = serde_json::from_str(&r.source_json).unwrap();
            let e = &d["scene"]["tracks"][0]["elements"][0];
            assert_eq!(e["fitMode"], "cover");
            let offset = e["params"]["transform.positionX"].as_f64().unwrap();
            assert!(offset.abs() <= 1166.667);
            assert_eq!(offset.signum(), (0.5 - x).signum());
            assert_eq!(d["projectSettings"]["canvasSize"]["width"], 1080);
        }
    }
    #[test]
    fn finishing_covers_final_duration_and_preserves_speech() {
        let mut d = source();
        d["scene"]["tracks"].as_array_mut().unwrap().insert(1,json!({"id":"text","type":"text","area":"overlay","elements":[{"id":"caption","type":"text","startTime":120000,"duration":120000,"params":{"content":"unchanged words"},"wordRuns":[{"id":"w","text":"word","startTime":0,"endTime":120000}]}]}));
        let before = d["scene"]["tracks"][1]["elements"][0]["wordRuns"].clone();
        let r = compile_full_auto_edit(CompileFullAutoEditOptions {
            source_json: d.to_string(),
            stage: "finish".into(),
            framing_json: "[]".into(),
            font_family: "Assistant ExtraBold".into(),
        });
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        assert_eq!(d["scene"]["tracks"][0]["elements"][0]["wordRuns"], before);
        assert_eq!(
            d["scene"]["tracks"][0]["elements"][0]["params"]["bottomFadeOut"],
            0.6
        );
        assert_eq!(
            d["scene"]["tracks"][0]["elements"][0]["params"]["bottomFadeOutEndOpacity"],
            0.25
        );
        assert_eq!(d["scene"]["tracks"][1]["elements"][0]["duration"], 1200000);
        assert_eq!(
            d["scene"]["tracks"][1]["elements"][0]["name"],
            "Editorial Edge Feather"
        );
        assert_eq!(d["scene"]["tracks"][2]["area"], "main");
    }
    #[test]
    fn center_only_preserves_everything_except_horizontal_position() {
        let framed = frame(0.4);
        let mut d: Value = serde_json::from_str(&framed.source_json).unwrap();
        d["scene"]["tracks"][0]["elements"][0]["params"]["opacity"] = json!(0.7);
        d["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionY"] = json!(17);
        d["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionX"] = json!(0);
        d["scene"]["tracks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"captions","type":"text","area":"overlay","elements":[]}));
        let mut expected = d.clone();
        let r=compile_full_auto_edit(CompileFullAutoEditOptions{source_json:d.to_string(),stage:"center-subject".into(),font_family:String::new(),framing_json:json!([{"elementId":"v1","width":1920,"height":1080,"samples":[{"faceX":0.4,"bodyX":0.4,"confidence":1.,"personCount":1},{"faceX":0.4,"bodyX":0.4,"confidence":1.,"personCount":1},{"faceX":0.4,"bodyX":0.4,"confidence":1.,"personCount":1}]}]).to_string()});
        assert!(r.valid, "{}", r.error);
        let actual: Value = serde_json::from_str(&r.source_json).unwrap();
        expected["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionX"] =
            actual["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionX"].clone();
        assert_eq!(actual, expected);
        assert!(
            actual["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionX"]
                .as_f64()
                .unwrap()
                > 0.
        );
    }
    #[test]
    fn untrusted_detections_fail_closed() {
        assert!(!frame(2.0).valid);
    }
}
