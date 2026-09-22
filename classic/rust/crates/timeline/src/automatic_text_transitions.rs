//! Classic-only semantic text accents, compiled into the canonical Timeline Source.
//! No model-selected asset paths, executable code, or independent project state.
use crate::{CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

const OWNER: &str = "automatic-text-transitions-v1";
const TICKS: f64 = 120_000.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileAutomaticTextTransitionsOptions {
    pub source_json: String,
    pub plan_json: String,
    /// Host-supplied existing transition SFX catalog, never model-authored.
    pub sfx_json: String,
    /// Exact live registry IDs, supplied by the host UI.
    pub preset_ids_json: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticTextTransitionsResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub text_count: usize,
    pub sound_count: usize,
    pub coverage_percent: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    events: Vec<Event>,
    density_reason: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    element_id: String,
    side: String,
    preset_id: String,
    percent: f64,
    reason: String,
}

fn baseline(id: &str) -> bool {
    ["none", "fade", "close-focus", "shrink", "shatter"].contains(&id)
}
fn union_duration(mut spans: Vec<(i64, i64)>) -> i64 {
    spans.sort_unstable();
    let mut end = 0;
    let mut total = 0;
    for (a, b) in spans {
        total += (b - a.max(end)).max(0);
        end = end.max(b);
    }
    total
}

#[export]
pub fn compile_automatic_text_transitions(
    o: CompileAutomaticTextTransitionsOptions,
) -> AutomaticTextTransitionsResult {
    compile(o).unwrap_or_else(|error| AutomaticTextTransitionsResult {
        valid: false,
        source_json: String::new(),
        error,
        text_count: 0,
        sound_count: 0,
        coverage_percent: 0.0,
    })
}

fn compile(
    o: CompileAutomaticTextTransitionsOptions,
) -> Result<AutomaticTextTransitionsResult, String> {
    let canonical =
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: o.source_json,
        });
    if !canonical.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value =
        serde_json::from_str(&canonical.formatted_json).map_err(|e| e.to_string())?;
    let plan: Plan =
        serde_json::from_str(&o.plan_json).map_err(|e| format!("Invalid transition plan: {e}"))?;
    if plan.events.len() > 1000
        || plan.density_reason.trim().is_empty()
        || plan.density_reason.len() > 1500
    {
        return Err("Provide a short densityReason and at most 1000 events".into());
    }
    let preset_ids: Vec<String> =
        serde_json::from_str(&o.preset_ids_json).map_err(|e| e.to_string())?;
    let catalog: Vec<Value> = serde_json::from_str(&o.sfx_json).map_err(|e| e.to_string())?;
    let created_at = doc["scene"]["updatedAt"]
        .as_str()
        .unwrap_or("1970-01-01T00:00:00.000Z")
        .to_owned();
    let scene_id = doc["scene"]["id"]
        .as_str()
        .ok_or("Missing scene ID")?
        .to_owned();
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;

    // Restore only sides still carrying our exact output. A user's later manual
    // transition edit wins. Unselected baseline transitions never get rewritten.
    for track in tracks.iter_mut() {
        if let Some(es) = track["elements"].as_array_mut() {
            es.retain(|e| e["automaticTextTransitionsOwner"] != OWNER);
            for e in es {
                if let Some(saved) = e
                    .get("automaticTextTransitions")
                    .and_then(Value::as_object)
                    .cloned()
                {
                    for (side, previous) in saved {
                        if e["transitions"][&side] == previous["applied"] {
                            if previous["before"].is_null() {
                                if let Some(t) = e["transitions"].as_object_mut() {
                                    t.remove(&side);
                                }
                            } else {
                                e["transitions"][&side] = previous["before"].clone();
                            }
                        }
                    }
                    e.as_object_mut()
                        .unwrap()
                        .remove("automaticTextTransitions");
                    if e["transitions"].as_object().is_some_and(|t| t.is_empty()) {
                        e.as_object_mut().unwrap().remove("transitions");
                    }
                }
            }
        }
    }
    tracks.retain(|t| {
        !(t["automaticTextTransitionsOwner"] == OWNER
            && t["elements"].as_array().is_some_and(|e| e.is_empty()))
    });
    let texts: Vec<Value> = tracks
        .iter()
        .filter(|t| t["hidden"] != true)
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter(|e| e["type"] == "text" && e["hidden"] != true)
        .cloned()
        .collect();
    if texts.is_empty() {
        return Err("Run Auto Text first: no visible text elements".into());
    }
    let span = |e: &Value| {
        let a = e["startTime"].as_i64().unwrap_or(0);
        (a, a + e["duration"].as_i64().unwrap_or(0))
    };
    let total = union_duration(texts.iter().map(span).collect());
    if total <= 0 {
        return Err("No timed text".into());
    }
    let video_end = tracks
        .iter()
        .filter(|t| t["area"] == "main")
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .map(|e| span(e).1)
        .max()
        .unwrap_or(0);
    let mut selected = HashSet::new();
    let mut sides = HashSet::new();
    let mut sounds: Vec<Value> = Vec::new();
    // Existing short sound effects (including Automatic Zoom) prevent duplicate
    // simultaneous hits. Music beds and dialogue are not sound accents.
    let mut sound_times: Vec<i64> = tracks
        .iter()
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter(|e| {
            e["type"] == "audio"
                && e["params"]["muted"] != true
                && e["duration"].as_i64().unwrap_or(i64::MAX) < (TICKS * 3.0) as i64
        })
        .map(|e| span(e).0)
        .collect();
    for event in &plan.events {
        if (!["in", "out"].contains(&event.side.as_str())
            || event.preset_id == "none"
            || !preset_ids.contains(&event.preset_id))
            || !event.percent.is_finite()
            || !(5.0..=35.0).contains(&event.percent)
            || event.reason.trim().is_empty()
            || event.reason.len() > 1000
        {
            return Err(format!(
                "Invalid preset/side/percent/reason for {}",
                event.element_id
            ));
        }
        if !sides.insert((event.element_id.clone(), event.side.clone())) {
            return Err("Duplicate text side".into());
        }
        let original = texts
            .iter()
            .find(|e| e["id"] == event.element_id)
            .ok_or_else(|| format!("Unknown or hidden text ID {}", event.element_id))?;
        let old_id = original["transitions"][&event.side]["presetId"]
            .as_str()
            .unwrap_or("none");
        if !baseline(old_id) {
            return Err(format!(
                "Preserve manually accented {} {} ({old_id})",
                event.element_id, event.side
            ));
        }
        if original
            .get("animations")
            .is_some_and(|a| !a.is_null() && a.as_object().is_some_and(|o| !o.is_empty()))
        {
            return Err(format!(
                "Preserve custom animated text {}",
                event.element_id
            ));
        }
        let (start, end) = span(original);
        let duration = end - start;
        if duration <= 0 || end > video_end || start < 0 {
            return Err("Text lies outside the video".into());
        }
        let percent = if event.preset_id == "flicker" {
            event.percent.max(10.0)
        } else {
            event.percent
        };
        let d = ((duration as f64 * percent / 100.0).round() as i64)
            .max(1)
            .min((TICKS * 0.6) as i64);
        let at = if event.side == "out" { duration - d } else { 0 };
        let id = format!("{OWNER}:{scene_id}:{}:{}", event.element_id, event.side);
        let transition = json!({"id":id,"presetId":event.preset_id,"placement":event.side,"duration":d,"startTime":at,"createdAt":created_at});
        for track in tracks.iter_mut() {
            for e in track["elements"].as_array_mut().into_iter().flatten() {
                if e["id"] != event.element_id {
                    continue;
                }
                let before = e["transitions"][&event.side].clone();
                if !e["transitions"].is_object() {
                    e["transitions"] = json!({});
                }
                e["transitions"][&event.side] = transition.clone();
                if !e["automaticTextTransitions"].is_object() {
                    e["automaticTextTransitions"] = json!({});
                }
                e["automaticTextTransitions"][&event.side] =
                    json!({"before":before,"applied":transition,"reason":event.reason});
                let in_d = e["transitions"]["in"]["duration"].as_i64().unwrap_or(0);
                let out_d = e["transitions"]["out"]["duration"].as_i64().unwrap_or(0);
                if in_d + out_d > duration {
                    return Err("In/out transitions overlap; shorten the accent".into());
                }
            }
        }
        selected.insert(event.element_id.clone());
        if let Some(sfx) = catalog
            .iter()
            .find(|p| p["transitionId"] == event.preset_id && p["side"] == event.side)
        {
            let number = |key: &str| -> Result<f64, String> {
                sfx[key]
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| format!("Invalid host SFX {key}"))
            };
            let lead = number("leadInSeconds")?;
            let length = number("durationSeconds")?;
            let source = number("sourceDurationSeconds")?;
            let trim = number("trimStartSeconds")?;
            let volume = if event.preset_id == "grow" {
                -31.4
            } else {
                number("volume")?
            };
            if !(0.0..=2.0).contains(&lead)
                || !(0.0..=3.0).contains(&length)
                || trim < 0.0
                || trim + length > source + 0.001
                || !(-60.0..=0.0).contains(&volume)
            {
                return Err("Invalid host SFX limits".into());
            }
            let desired = start + at - (lead * TICKS).round() as i64;
            let audio_start = desired.max(0);
            // Trim the unavailable lead-in at scene start instead of shifting
            // the transient away from the visual accent.
            let trim_ticks = (trim * TICKS).round() as i64 + (-desired).max(0);
            let audio_duration =
                ((length * TICKS).round() as i64 - (-desired).max(0)).min(video_end - audio_start);
            if audio_duration <= 0
                || sound_times
                    .iter()
                    .any(|s| (s - audio_start).abs() < (TICKS * 0.18) as i64)
            {
                continue;
            }
            let source_ticks = (source * TICKS).round() as i64;
            sounds.push(json!({"id":format!("{id}:sfx"),"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":sfx["assetId"],"name":sfx["name"],"startTime":audio_start,"duration":audio_duration,"trimStart":trim_ticks,"trimEnd":(source_ticks-trim_ticks-audio_duration).max(0),"sourceDuration":source_ticks,"automaticTextTransitionsOwner":OWNER,
                "params":{"volume":volume,"muted":false,"fadeInDuration":0,"fadeOutDuration":0.05,"opencut.textTransitionSfx.kind":"text-transition-in-sfx","opencut.textTransitionSfx.textElementId":event.element_id,"opencut.textTransitionSfx.presetId":event.preset_id}}));
            sound_times.push(audio_start);
        }
    }
    let already_accented = |e: &Value| {
        ["in", "out"].iter().any(|side| {
            !baseline(
                e["transitions"][side]["presetId"]
                    .as_str()
                    .unwrap_or("none"),
            )
        })
    };
    let existing_coverage = union_duration(
        texts
            .iter()
            .filter(|e| already_accented(e))
            .map(span)
            .collect(),
    ) as f64
        / total as f64
        * 100.0;
    let coverage = union_duration(
        texts
            .iter()
            .filter(|e| selected.contains(e["id"].as_str().unwrap_or("")) || already_accented(e))
            .map(span)
            .collect(),
    ) as f64
        / total as f64
        * 100.0;
    if coverage > 65.0_f64.max(existing_coverage) + 0.001 {
        return Err(format!(
            "Accent coverage {coverage:.1}% exceeds 65%; aim near 30–40% and leave breathing room"
        ));
    }
    let sound_count = sounds.len();
    if sound_count > 0 {
        let base = format!("{OWNER}:{scene_id}:audio");
        let mut id = base.clone();
        let mut i = 0;
        while tracks.iter().any(|t| t["id"] == id) {
            i += 1;
            id = format!("{base}:{i}");
        }
        tracks.push(json!({"id":id,"type":"audio","area":"audio","name":"Automatic Transitions · SFX","muted":false,"automaticTextTransitionsOwner":OWNER,"elements":sounds}));
    }
    let result = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: doc.to_string(),
    });
    if !result.valid {
        return Err(format!(
            "Generated source invalid: {:?}",
            result.diagnostics
        ));
    }
    Ok(AutomaticTextTransitionsResult {
        valid: true,
        source_json: result.formatted_json,
        error: String::new(),
        text_count: selected.len(),
        sound_count,
        coverage_percent: coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Value {
        json!({"schemaVersion":2,"projectSettings":{"fps":30,"canvasSize":{"width":1080,"height":1920}},
        "scene":{"id":"scene","tracks":[
            {"id":"captions","area":"overlay","type":"text","elements":(0..10).map(|i|json!({"id":format!("t{i}"),"type":"text","startTime":i*120000,"duration":120000,"params":{"content":format!("Actual phrase {i}"),"fontFamily":"Assistant","bottomFadeOut":0.7},"wordRuns":[{"id":format!("w{i}"),"text":"phrase","startTime":0,"endTime":120000}]})).collect::<Vec<_>>()},
            {"id":"main","area":"main","type":"video","elements":[{"id":"video","type":"video","startTime":0,"duration":1200000,"params":{"scale":1.7}}]},
            {"id":"audio","area":"audio","type":"audio","elements":[{"id":"music","type":"audio","startTime":0,"duration":1200000,"params":{"volume":-25}}]}
        ]}})
    }
    fn event(id: &str, preset: &str, side: &str) -> Value {
        json!({"elementId":id,"presetId":preset,"side":side,"percent":15,"reason":"Specific actual key phrase"})
    }
    fn run(doc: Value, events: Vec<Value>) -> AutomaticTextTransitionsResult {
        compile_automatic_text_transitions(CompileAutomaticTextTransitionsOptions {
            source_json:doc.to_string(), plan_json:json!({"events":events,"densityReason":"Three benefits then quiet exposition"}).to_string(),
            preset_ids_json:json!(["push-right","flicker","grow","rise-soft","slide-down","fade"]).to_string(),
            sfx_json:json!([
                {"transitionId":"push-right","side":"in","assetId":"whoosh","name":"Push Right SFX","leadInSeconds":0.35,"durationSeconds":1.38,"sourceDurationSeconds":8.04,"trimStartSeconds":0,"volume":-12.3},
                {"transitionId":"grow","side":"out","assetId":"grow-sfx","name":"Grow Out SFX","leadInSeconds":0.186225,"durationSeconds":1,"sourceDurationSeconds":5.88,"trimStartSeconds":0.36,"volume":0}
            ]).to_string(),
        })
    }
    fn parsed(r: &AutomaticTextTransitionsResult) -> Value {
        assert!(r.valid, "{}", r.error);
        serde_json::from_str(&r.source_json).unwrap()
    }
    #[test]
    fn semantic_accents_preserve_words_video_fonts_and_existing_audio() {
        let before = source();
        let r = run(
            before.clone(),
            vec![
                event("t2", "push-right", "in"),
                event("t4", "rise-soft", "in"),
                event("t6", "slide-down", "out"),
            ],
        );
        let d = parsed(&r);
        assert_eq!(r.text_count, 3);
        assert_eq!(r.sound_count, 1);
        assert_eq!(r.coverage_percent, 30.0);
        assert_eq!(d["scene"]["tracks"][1], before["scene"]["tracks"][1]);
        assert_eq!(d["scene"]["tracks"][2], before["scene"]["tracks"][2]);
        for i in 0..10 {
            for key in ["params", "wordRuns", "startTime", "duration"] {
                assert_eq!(
                    d["scene"]["tracks"][0]["elements"][i][key],
                    before["scene"]["tracks"][0]["elements"][i][key]
                );
            }
        }
        let e = &d["scene"]["tracks"][0]["elements"][6];
        assert_eq!(e["transitions"]["out"]["startTime"], 102000);
    }
    #[test]
    fn rerun_replaces_owned_accents_and_restores_unselected_baseline() {
        let before = source();
        let first = run(before.clone(), vec![event("t2", "push-right", "in")]);
        let d = parsed(&first);
        assert_eq!(
            run(d.clone(), vec![event("t2", "push-right", "in")]).source_json,
            first.source_json
        );
        let clean = parsed(&run(d, vec![]));
        assert_eq!(clean["scene"]["tracks"], before["scene"]["tracks"]);
    }
    #[test]
    fn manual_edits_and_manual_elements_in_owned_audio_track_survive() {
        let mut d = parsed(&run(source(), vec![event("t2", "push-right", "in")]));
        d["scene"]["tracks"][0]["elements"][2]["transitions"]["in"] = json!({"id":"manual","presetId":"flicker","duration":12000,"startTime":0,"placement":"in"});
        d["scene"]["tracks"][3]["elements"].as_array_mut().unwrap().push(json!({"id":"manual-sound","type":"audio","startTime":600000,"duration":120000,"params":{}}));
        let result = parsed(&run(d.clone(), vec![]));
        assert_eq!(
            result["scene"]["tracks"][0]["elements"][2]["transitions"],
            d["scene"]["tracks"][0]["elements"][2]["transitions"]
        );
        assert_eq!(
            result["scene"]["tracks"][3]["elements"][0]["id"],
            "manual-sound"
        );
        assert!(!run(result, vec![event("t2", "push-right", "in")]).valid);
    }
    #[test]
    fn clips_sound_lead_in_and_tail_and_uses_authored_grow_gain() {
        let d = parsed(&run(
            source(),
            vec![event("t0", "push-right", "in"), event("t9", "grow", "out")],
        ));
        let es = d["scene"]["tracks"][3]["elements"].as_array().unwrap();
        assert_eq!(es[0]["startTime"], 0);
        assert_eq!(es[0]["trimStart"], 42000);
        assert_eq!(es[1]["params"]["volume"], -31.4);
        for e in es {
            assert!(e["startTime"].as_i64().unwrap() + e["duration"].as_i64().unwrap() <= 1200000);
            assert_eq!(
                e["trimStart"].as_i64().unwrap()
                    + e["duration"].as_i64().unwrap()
                    + e["trimEnd"].as_i64().unwrap(),
                e["sourceDuration"].as_i64().unwrap()
            );
        }
    }
    #[test]
    fn rejects_unknown_ids_presets_duplicate_sides_and_excess_density_atomically() {
        for events in [
            vec![event("missing", "push-right", "in")],
            vec![event("t1", "invented", "in")],
            vec![
                event("t1", "push-right", "in"),
                event("t1", "push-right", "in"),
            ],
            (0..8)
                .map(|i| event(&format!("t{i}"), "push-right", "in"))
                .collect(),
        ] {
            let result = run(source(), events);
            assert!(!result.valid);
            assert!(result.source_json.is_empty());
        }
    }
    #[test]
    fn coincident_sound_hits_are_suppressed_and_in_out_count_one_text() {
        let mut doc = source();
        doc["scene"]["tracks"][2]["elements"].as_array_mut().unwrap().push(json!({"id":"existing-zoom-sound","type":"audio","startTime":198000,"duration":120000,"params":{"volume":-35}}));
        let r = run(
            doc,
            vec![event("t2", "push-right", "in"), event("t2", "grow", "out")],
        );
        parsed(&r);
        assert_eq!(r.sound_count, 1);
        assert_eq!(r.text_count, 1);
        assert_eq!(r.coverage_percent, 10.0);
    }

    #[test]
    fn existing_manual_accent_coverage_counts_toward_the_budget() {
        let mut doc = source();
        for i in 0..7 {
            doc["scene"]["tracks"][0]["elements"][i]["transitions"] = json!({"in":{"id":format!("manual-{i}"),"presetId":"flicker","duration":12000,"startTime":0,"placement":"in"}});
        }
        let unchanged = run(doc.clone(), vec![]);
        parsed(&unchanged);
        assert_eq!(unchanged.coverage_percent, 70.0);
        assert!(!run(doc, vec![event("t8", "push-right", "in")]).valid);
    }
}
