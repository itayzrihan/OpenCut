//! Classic-only single-project recipe; host performs media/AI I/O and canonical transactions.
use crate::{CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Shared preflight and framing contract; an explicit 1x rate is ordinary footage.
pub fn supports_full_auto_framing(clip: &Value) -> bool {
    clip["type"] == "video"
        && clip.get("animations").is_none_or(Value::is_null)
        && clip
            .get("retime")
            .is_none_or(|r| r.is_null() || r["rate"].as_f64() == Some(1.0))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullAutoFramingSampleOptions {
    pub clips_json: String,
}

/// Five duration-weighted samples of the retained source intervals, in timeline order.
/// Never sample discarded footage between distant or reordered takes.
#[export]
pub fn full_auto_framing_sample_times(o: FullAutoFramingSampleOptions) -> Vec<f64> {
    let Ok(mut clips) = serde_json::from_str::<Vec<Value>>(&o.clips_json) else {
        return vec![];
    };
    if clips.is_empty()
        || clips.iter().any(|c| {
            !supports_full_auto_framing(c)
                || c["duration"]
                    .as_f64()
                    .is_none_or(|d| !d.is_finite() || d <= 0.0)
                || c["trimStart"]
                    .as_f64()
                    .is_none_or(|t| !t.is_finite() || t < 0.0)
        })
    {
        return vec![];
    }
    clips.sort_by(|a, b| {
        a["startTime"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&b["startTime"].as_f64().unwrap_or(0.0))
    });
    let total: f64 = clips.iter().map(|c| c["duration"].as_f64().unwrap()).sum();
    [0.02, 0.25, 0.5, 0.75, 0.98]
        .iter()
        .map(|fraction| {
            let mut remaining = total * fraction;
            for c in &clips {
                let duration = c["duration"].as_f64().unwrap();
                if remaining < duration {
                    return (c["trimStart"].as_f64().unwrap() + remaining) / 120_000.0;
                }
                remaining -= duration;
            }
            unreachable!("fractions are strictly below one")
        })
        .collect()
}

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
    let scene_id = doc["scene"]["id"].as_str().unwrap_or("scene").to_owned();
    if o.stage == "framing" || o.stage == "framing-auto" || o.stage == "center-subject" {
        let unattended = o.stage == "framing-auto";
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
            if !supports_full_auto_framing(e) {
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
                || (!unattended && f.samples.len() < 3)
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
                    || !(1..=2).contains(&s.person_count)
                    || (s.face_x - s.body_x).abs() > 0.18
                {
                    if unattended {
                        xs.clear();
                        break;
                    }
                    return Err("Face/body framing is uncertain or has multiple people; review the source before Full Auto Edit".into());
                }
                xs.push(s.face_x * 0.8 + s.body_x * 0.2);
            }
            xs.sort_by(f64::total_cmp);
            // Stable talking-head crop, not an unsupported claim of continuous tracking.
            if xs.len() >= 3 && xs.last().unwrap() - xs[0] > 0.12 {
                if unattended {
                    xs.clear();
                } else {
                    return Err(
                    "Speaker moves too far for a stable horizontal crop; manual framing required"
                        .into(),
                );
                }
            }
            let scale = (1080.0 / f.width).max(1920.0 / f.height);
            let limit = ((f.width * scale - 1080.0) / 2.0).max(0.0);
            let target = if xs.len() >= 3 { xs[xs.len() / 2] } else { 0.5 };
            let x = ((0.5 - target) * f.width * scale).clamp(-limit, limit);
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
        tracks.insert(at,json!({"id":format!("full-auto-edit:{scene_id}:edge-track"),"type":"effect","area":"overlay","name":"Editorial Edge Feather","hidden":false,"fullAutoEditOwner":"edge-feather-v1","elements":[{"id":format!("full-auto-edit:{scene_id}:edge"),"name":"Editorial Edge Feather","type":"effect","effectType":"editorial-edge-feather","startTime":0,"duration":end,"trimStart":0,"trimEnd":0,"fullAutoEditOwner":"edge-feather-v1","params":{"intensity":60,"height":30,"softness":80,"color":"#000000"}}]}));
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
    fn samples_follow_chosen_cuts_not_discarded_source_gaps() {
        let clips = json!([
            {"type":"video","startTime":240000,"trimStart":1200000,"duration":240000,"retime":{"rate":1,"maintainPitch":true}},
            {"type":"video","startTime":0,"trimStart":12000000,"duration":240000}
        ]);
        let times = full_auto_framing_sample_times(FullAutoFramingSampleOptions {
            clips_json: clips.to_string(),
        });
        assert_eq!(times, vec![100.08, 101.0, 10.0, 11.0, 11.92]);
        let mut unsupported = clips;
        unsupported[0]["retime"]["rate"] = json!(2);
        assert!(
            full_auto_framing_sample_times(FullAutoFramingSampleOptions {
                clips_json: unsupported.to_string()
            })
            .is_empty()
        );
    }
    #[test]
    fn framing_and_finish_preserve_reordered_cut_clocks() {
        let mut source = source();
        let mut first = source["scene"]["tracks"][0]["elements"][0].clone();
        first["trimStart"] = json!(12000000);
        first["duration"] = json!(240000);
        let mut second = first.clone();
        second["id"] = json!("v2");
        second["trimStart"] = json!(1200000);
        second["startTime"] = json!(240000);
        second["retime"] = json!({"rate":1});
        source["scene"]["tracks"][0]["elements"] = json!([first, second]);
        let framed = compile_full_auto_edit(CompileFullAutoEditOptions {
            source_json: source.to_string(), stage: "framing-auto".into(), font_family: "".into(),
            framing_json: json!([{"elementId":"v1","width":1920,"height":1080,"samples":[]},{"elementId":"v2","width":1920,"height":1080,"samples":[]}]).to_string()
        });
        assert!(framed.valid, "{}", framed.error);
        let finished = compile_full_auto_edit(CompileFullAutoEditOptions {
            source_json: framed.source_json,
            stage: "finish".into(),
            font_family: "Assistant Bold".into(),
            framing_json: "[]".into(),
        });
        assert!(finished.valid, "{}", finished.error);
        let result: Value = serde_json::from_str(&finished.source_json).unwrap();
        let clips = &result["scene"]["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["area"] == "main")
            .unwrap()["elements"];
        for i in 0..2 {
            for key in ["id", "startTime", "duration", "trimStart"] {
                assert_eq!(
                    clips[i][key],
                    source["scene"]["tracks"][0]["elements"][i][key]
                );
            }
        }
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
    fn unattended_missing_faces_completes_vertical_cover_and_two_faces_center_midpoint() {
        for samples in [
            json!([]),
            json!(vec![
                json!({"faceX":0.4,"bodyX":0.4,"confidence":1.,"personCount":2});
                3
            ]),
        ] {
            let r = compile_full_auto_edit(CompileFullAutoEditOptions {
                source_json: source().to_string(),
                stage: "framing-auto".into(),
                font_family: String::new(),
                framing_json:
                    json!([{"elementId":"v1","width":1920,"height":1080,"samples":samples}])
                        .to_string(),
            });
            assert!(r.valid, "{}", r.error);
            let d: Value = serde_json::from_str(&r.source_json).unwrap();
            assert_eq!(
                d["projectSettings"]["canvasSize"],
                json!({"width":1080,"height":1920})
            );
            assert_eq!(d["scene"]["tracks"][0]["elements"][0]["fitMode"], "cover");
            let x = d["scene"]["tracks"][0]["elements"][0]["params"]["transform.positionX"]
                .as_f64()
                .unwrap();
            if samples.as_array().unwrap().is_empty() {
                assert_eq!(x, 0.);
            } else {
                assert!(x > 0.);
            }
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

    #[test]
    fn finishing_ids_do_not_collide_between_scenes() {
        let mut ids = std::collections::HashSet::new();
        for scene in ["smart-a", "smart-b"] {
            let mut input = source();
            input["scene"]["id"] = json!(scene);
            let result = compile_full_auto_edit(CompileFullAutoEditOptions {
                source_json: input.to_string(),
                stage: "finish".into(),
                framing_json: "[]".into(),
                font_family: "Assistant Bold".into(),
            });
            assert!(result.valid, "{}", result.error);
            let output: Value = serde_json::from_str(&result.source_json).unwrap();
            let track = output["scene"]["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["fullAutoEditOwner"] == "edge-feather-v1")
                .unwrap();
            assert!(ids.insert(track["id"].as_str().unwrap().to_owned()));
            assert!(ids.insert(track["elements"][0]["id"].as_str().unwrap().to_owned()));
        }
    }
}
