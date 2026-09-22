//! Classic-only sparse word accents. The model selects IDs; Rust owns policy and edits.
use crate::{CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

const OWNER: &str = "automatic-word-animation-v1";
const META: &str = "automaticWordAnimation";
const KEYS: [&str; 3] = ["wordAnimationId", "revealMode", "glowerEnabled"];
const CLASSICS: [&str; 4] = [
    "cinema-breath-5",
    "cinema-breath-6",
    "breathing-row-1",
    "clean-spotlight-1",
];

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileAutomaticWordAnimationOptions {
    pub source_json: String,
    pub plan_json: String,
    pub preset_ids_json: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticWordAnimationResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub word_count: usize,
    pub sound_count: usize,
    pub coverage_percent: f64,
    pub summary: String,
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
    word_id: String,
    animation_id: String,
    letter_by_letter: bool,
    reason: String,
}
fn union(mut spans: Vec<(i64, i64)>) -> i64 {
    spans.sort_unstable();
    let (mut end, mut total) = (0, 0);
    for (a, b) in spans {
        total += (b - a.max(end)).max(0);
        end = end.max(b);
    }
    total
}
#[export]
pub fn compile_automatic_word_animation(
    o: CompileAutomaticWordAnimationOptions,
) -> AutomaticWordAnimationResult {
    compile(o).unwrap_or_else(|error| AutomaticWordAnimationResult {
        valid: false,
        source_json: String::new(),
        error,
        word_count: 0,
        sound_count: 0,
        coverage_percent: 0.0,
        summary: String::new(),
    })
}
fn compile(
    o: CompileAutomaticWordAnimationOptions,
) -> Result<AutomaticWordAnimationResult, String> {
    let c = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: o.source_json,
    });
    if !c.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value = serde_json::from_str(&c.formatted_json).map_err(|e| e.to_string())?;
    let plan: Plan = serde_json::from_str(&o.plan_json).map_err(|e| e.to_string())?;
    let catalog: Vec<String> =
        serde_json::from_str(&o.preset_ids_json).map_err(|e| e.to_string())?;
    if plan.events.len() > 100
        || plan.density_reason.trim().is_empty()
        || plan.density_reason.len() > 1500
    {
        return Err(
            "Provide densityReason and at most 100 word accents; an empty selection is welcome"
                .into(),
        );
    }
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;
    // Restore only unchanged owned properties. Preserve later manual edits.
    for t in tracks.iter_mut() {
        if let Some(es) = t["elements"].as_array_mut() {
            es.retain(|e| e["automaticWordAnimationOwner"] != OWNER);
            for e in es {
                let saved = e[META].as_array().cloned().unwrap_or_default();
                if let Some(words) = e.get_mut("wordRuns").and_then(Value::as_array_mut) {
                    for s in saved {
                        if let Some(w) = words.iter_mut().find(|w| w["id"] == s["wordId"]) {
                            for k in KEYS {
                                if w[k] == s["applied"][k] {
                                    if s["before"][k].is_null() {
                                        w.as_object_mut().unwrap().remove(k);
                                    } else {
                                        w[k] = s["before"][k].clone();
                                    }
                                }
                            }
                        }
                    }
                }
                e.as_object_mut().unwrap().remove(META);
            }
        }
    }
    tracks.retain(|t| {
        !(t["automaticWordAnimationOwner"] == OWNER
            && t["elements"].as_array().is_some_and(|e| e.is_empty()))
    });
    let video_spans: Vec<_> = tracks
        .iter()
        .filter(|t| t["area"] == "main")
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter(|e| e["type"] == "video")
        .map(|e| {
            let a = e["startTime"].as_i64().unwrap_or(0);
            (a, a + e["duration"].as_i64().unwrap_or(0))
        })
        .collect();
    let duration = union(video_spans);
    if duration <= 0 {
        return Err("No timed main video".into());
    }
    let mut selected = HashSet::new();
    let mut accented = Vec::new();
    let mut reveal_texts = HashSet::new();
    let mut reveal_spans = Vec::new();
    let mut reveal_links: Vec<(i64, i64, String)> = Vec::new();
    let mut sounds = Vec::new();
    // Count full caption spans, not just active word time: presets can style idle/spoken words too.
    for t in tracks.iter().filter(|t| t["hidden"] != true) {
        for e in t["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["type"] == "text" && e["hidden"] != true)
        {
            let special = |v: &Value| {
                v.as_str()
                    .is_some_and(|s| s != "none" && s != "row" && s != "determined-by-preset")
            };
            if e["captionGlowerEnabled"] == true
                || e["captionLightningStormEnabled"] == true
                || e["captionGlitchyEnabled"] == true
                || special(&e["captionPresetId"])
                || special(&e["captionWordAnimationId"])
                || special(&e["captionRevealMode"])
                || e["wordRuns"].as_array().is_some_and(|ws| {
                    ws.iter().any(|w| {
                        w["glowerEnabled"] == true
                            || w["lightningStormEnabled"] == true
                            || w["glitchyEnabled"] == true
                            || special(&w["wordAnimationId"])
                            || special(&w["revealMode"])
                    })
                })
                || e["textRowOverrides"].as_array().is_some_and(|ws| {
                    ws.iter().any(|w| {
                        w["glowerEnabled"] == true
                            || w["lightningStormEnabled"] == true
                            || w["glitchyEnabled"] == true
                            || special(&w["wordAnimationId"])
                            || special(&w["revealMode"])
                    })
                })
            {
                let a = e["startTime"].as_i64().unwrap_or(0);
                accented.push((a, a + e["duration"].as_i64().unwrap_or(0)));
            }
        }
    }
    for event in &plan.events {
        if !selected.insert((event.element_id.clone(), event.word_id.clone()))
            || event.reason.trim().is_empty()
            || event.reason.len() > 1000
            || !(event.animation_id == "none" && event.letter_by_letter
                || CLASSICS.contains(&event.animation_id.as_str())
                    && catalog.contains(&event.animation_id))
        {
            return Err(
                "Use unique timed word IDs and restrained classic presets with a semantic reason"
                    .into(),
            );
        }
        let e = tracks
            .iter_mut()
            .filter(|t| t["hidden"] != true)
            .flat_map(|t| t["elements"].as_array_mut().into_iter().flatten())
            .find(|e| e["id"] == event.element_id && e["type"] == "text" && e["hidden"] != true)
            .ok_or("Unknown visible text ID")?;
        if e["captionGlowerEnabled"] == true
            || e["captionLightningStormEnabled"] == true
            || e["captionGlitchyEnabled"] == true
            || e["captionPresetId"].as_str().is_some_and(|s| s != "none")
            || e["captionWordAnimationId"]
                .as_str()
                .is_some_and(|s| s != "none")
            || e["captionRevealMode"]
                .as_str()
                .is_some_and(|s| s != "row" && s != "none" && s != "determined-by-preset")
        {
            return Err("Preserve existing layer animation/reveal".into());
        }
        let start = e["startTime"].as_i64().ok_or("Untimed caption")?;
        let duration = e["duration"].as_i64().ok_or("Untimed caption")?;
        let rows = e["textRowOverrides"].clone();
        let w = e["wordRuns"]
            .as_array_mut()
            .ok_or("Missing timed words")?
            .iter_mut()
            .find(|w| w["id"] == event.word_id)
            .ok_or("Unknown word ID")?;
        if w["glowerEnabled"] == true
            || w["lightningStormEnabled"] == true
            || w["glitchyEnabled"] == true
            || rows.as_array().is_some_and(|rs| {
                rs.iter().any(|r| {
                    r["lineIndex"] == w["lineIndex"]
                        && (r["glowerEnabled"] == true
                            || r["lightningStormEnabled"] == true
                            || r["glitchyEnabled"] == true
                            || r.get("wordAnimationId").is_some()
                            || r.get("revealMode").is_some())
                })
            })
            || KEYS.iter().any(|k| {
                w[*k]
                    .as_str()
                    .is_some_and(|s| s != "none" && s != "row" && s != "determined-by-preset")
            })
        {
            return Err("Preserve existing manual word/row animation".into());
        }
        let a = w["startTime"].as_i64().ok_or("Missing word startTime")?;
        let b = w["endTime"].as_i64().ok_or("Missing word endTime")?;
        if a < 0 || b <= a || b > duration {
            return Err("Word timing outside caption".into());
        }
        let before = json!({"wordAnimationId":w["wordAnimationId"],"revealMode":w["revealMode"],"glowerEnabled":w["glowerEnabled"]});
        w["wordAnimationId"] = json!(event.animation_id);
        // Keep other words visible. Only the chosen word can type itself in.
        w["revealMode"] = json!(if event.letter_by_letter {
            "letter-by-letter"
        } else {
            "row"
        });
        if event.animation_id == "cinema-breath-6" {
            w["glowerEnabled"] = json!(true);
        }
        let applied = json!({"wordAnimationId":w["wordAnimationId"],"revealMode":w["revealMode"],"glowerEnabled":w["glowerEnabled"]});
        if !e[META].is_array() {
            e[META] = json!([]);
        }
        e[META].as_array_mut().unwrap().push(
            json!({"wordId":event.word_id,"before":before,"applied":applied,"reason":event.reason}),
        );
        accented.push((start, start + duration));
        if event.letter_by_letter {
            if b - a < 24000 || b - a > 360000 {
                return Err("Typing reveal needs a readable 0.2–3 second word span".into());
            }
            reveal_texts.insert(event.element_id.clone());
            reveal_spans.push((start + a, start + b));
            reveal_links.push((start + a, start + b, event.element_id.clone()));
        }
    }
    let coverage = union(accented) as f64 / duration as f64 * 100.0;
    if coverage > 10.0001 {
        return Err(format!(
            "Combined existing and planned caption coverage {coverage:.1}% exceeds 10%; select fewer captions"
        ));
    }
    if reveal_texts.len() > 2 || union(reveal_spans.clone()) as f64 > duration as f64 * 0.02 {
        return Err(
            "Letter by Letter is exceptional: maximum two captions and 2% of video; prefer none"
                .into(),
        );
    }
    // Merge adjacent typing words; never place a typing sound across unrelated speech.
    reveal_links.sort_unstable();
    let mut merged: Vec<(i64, i64, String)> = Vec::new();
    for (a, b, text_id) in reveal_links {
        if let Some(last) = merged
            .last_mut()
            .filter(|last| a <= last.1 && text_id == last.2 && b - last.0 <= 1872000)
        {
            last.1 = last.1.max(b);
        } else {
            merged.push((a, b, text_id));
        }
    }
    for (i, (a, b, text_id)) in merged.into_iter().enumerate() {
        sounds.push(json!({"id":format!("{OWNER}:sfx:{i}"),"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":"da73d7d4-9b71-4a24-84ad-f6c51034354c","name":"Word Reveal · Typing","startTime":a,"duration":b-a,"trimStart":0,"trimEnd":1872000-(b-a),"sourceDuration":1872000,"automaticWordAnimationOwner":OWNER,"params":{"volume":-5,"muted":false,"fadeInDuration":0,"fadeOutDuration":0.04,"opencut.typingRevealSfx.kind":"letter-by-letter-typing-sfx","opencut.typingRevealSfx.textElementId":text_id}}));
    }
    let sound_count = sounds.len();
    if sound_count > 0 {
        let base = format!("{OWNER}:audio");
        let mut id = base.clone();
        let mut suffix = 0;
        while tracks.iter().any(|t| t["id"] == id) {
            suffix += 1;
            id = format!("{base}:{suffix}");
        }
        tracks.push(json!({"id":id,"type":"audio","area":"audio","name":"Automatic Word Reveal · SFX","muted":false,"automaticWordAnimationOwner":OWNER,"elements":sounds}));
    }
    let c = canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
        json: doc.to_string(),
    });
    if !c.valid {
        return Err(format!("Generated source invalid: {:?}", c.diagnostics));
    }
    Ok(AutomaticWordAnimationResult {
        valid: true,
        source_json: c.formatted_json,
        error: String::new(),
        word_count: plan.events.len(),
        sound_count,
        coverage_percent: coverage,
        summary: plan.density_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Value {
        json!({"schemaVersion":2,"projectSettings":{"fps":30,"canvasSize":{"width":1080,"height":1920}},"scene":{"id":"s","tracks":[{"id":"t","type":"text","area":"overlay","elements":(0..20).map(|i|json!({"id":format!("t{i}"),"type":"text","startTime":i*240000,"duration":240000,"params":{"content":"key word","bottomFadeOut":0.6},"captionRevealMode":"determined-by-preset","wordRuns":[{"id":"w","text":"key","startTime":24000,"endTime":60000},{"id":"other","text":"word","startTime":60000,"endTime":120000}]})).collect::<Vec<_>>()},{"id":"v","type":"video","area":"main","elements":[{"id":"v1","type":"video","startTime":0,"duration":4800000,"params":{}}]}]}})
    }
    fn event(i: usize, typing: bool) -> Value {
        json!({"elementId":format!("t{i}"),"wordId":"w","animationId":if typing {"none"} else {"cinema-breath-6"},"letterByLetter":typing,"reason":"Pivotal spoken insight"})
    }
    fn run(d: Value, events: Vec<Value>) -> AutomaticWordAnimationResult {
        compile_automatic_word_animation(CompileAutomaticWordAnimationOptions {
            source_json: d.to_string(),
            plan_json: json!({"densityReason":"Rare emphasis","events":events}).to_string(),
            preset_ids_json: json!(CLASSICS).to_string(),
        })
    }
    fn doc(r: &AutomaticWordAnimationResult) -> Value {
        assert!(r.valid, "{}", r.error);
        serde_json::from_str(&r.source_json).unwrap()
    }
    #[test]
    fn sparse_word_scope_preserves_timing_and_other_words() {
        let before = source();
        let r = run(before.clone(), vec![event(5, false)]);
        let d = doc(&r);
        assert_eq!(r.coverage_percent, 5.0);
        assert_eq!(
            d["scene"]["tracks"][0]["elements"][5]["wordRuns"][1],
            before["scene"]["tracks"][0]["elements"][5]["wordRuns"][1]
        );
        assert_eq!(d["scene"]["tracks"][1], before["scene"]["tracks"][1]);
        assert_eq!(
            d["scene"]["tracks"][0]["elements"][5]["params"],
            before["scene"]["tracks"][0]["elements"][5]["params"]
        );
    }
    #[test]
    fn cap_counts_whole_caption_and_rejects_atomically() {
        let r = run(
            source(),
            vec![event(1, false), event(5, false), event(9, false)],
        );
        assert!(!r.valid);
        assert!(r.source_json.is_empty());
        assert!(r.error.contains("10%"));
        assert!(run(source(), vec![]).valid);
    }
    #[test]
    fn typing_audio_matches_only_word_span() {
        let r = run(source(), vec![event(5, true)]);
        let d = doc(&r);
        let a = &d["scene"]["tracks"][2]["elements"][0];
        assert_eq!(a["startTime"], 1224000);
        assert_eq!(a["duration"], 36000);
        assert_eq!(a["params"]["volume"], -5);
        assert_eq!(r.sound_count, 1);
    }
    #[test]
    fn rerun_restores_and_keeps_later_manual_changes() {
        let first = run(source(), vec![event(5, true)]);
        let mut d = doc(&first);
        assert_eq!(
            run(d.clone(), vec![event(5, true)]).source_json,
            first.source_json
        );
        d["scene"]["tracks"][0]["elements"][5]["wordRuns"][0]["wordAnimationId"] =
            json!("manual-animation");
        let clean = doc(&run(d, vec![]));
        assert_eq!(clean["scene"]["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(
            clean["scene"]["tracks"][0]["elements"][5]["wordRuns"][0]["wordAnimationId"],
            "manual-animation"
        );
    }
    #[test]
    fn existing_manual_accents_consume_budget() {
        let mut d = source();
        for i in [0, 1] {
            d["scene"]["tracks"][0]["elements"][i]["wordRuns"][0]["wordAnimationId"] =
                json!("manual");
        }
        assert!(!run(d, vec![event(5, false)]).valid);
    }
    #[test]
    fn typing_has_a_stricter_budget_and_manual_audio_survives_rerun() {
        let mut d = source();
        d["scene"]["tracks"][0]["elements"][5]["wordRuns"][0]["endTime"] = json!(240000);
        let r = run(d, vec![event(5, true)]);
        assert!(!r.valid);
        assert!(r.error.contains("2%"));
        let mut d = doc(&run(source(), vec![event(5, true)]));
        let manual = json!({"id":"manual-music","type":"audio","startTime":0,"duration":120000,"params":{"volume":-20}});
        d["scene"]["tracks"][2]["elements"]
            .as_array_mut()
            .unwrap()
            .push(manual.clone());
        let rerun = doc(&run(d, vec![event(6, true)]));
        assert_eq!(rerun["scene"]["tracks"][2]["elements"], json!([manual]));
        assert_eq!(rerun["scene"]["tracks"].as_array().unwrap().len(), 4);
        assert_ne!(
            rerun["scene"]["tracks"][2]["id"],
            rerun["scene"]["tracks"][3]["id"]
        );
    }
    #[test]
    fn rejects_unknown_and_untimed_words() {
        let mut e = event(5, false);
        e["wordId"] = json!("missing");
        assert!(!run(source(), vec![e]).valid);
        let mut d = source();
        d["scene"]["tracks"][0]["elements"][5]["wordRuns"][0]["endTime"] = json!(999999);
        assert!(!run(d, vec![event(5, false)]).valid);
    }
}
