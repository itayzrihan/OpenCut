//! Bridged procedural sound direction: immutable synthesis recipes in the canonical timeline.
use crate::{
    CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document,
    validate_procedural_audio_source,
};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
const OWNER: &str = "automatic-earshot-v1";
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileAutomaticSoundEffectsOptions {
    pub source_json: String,
    pub plan_json: String,
    pub catalog_ids_json: String,
    #[serde(default)]
    pub word_reveals: bool,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticSoundEffectsResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub sound_count: usize,
    pub summary: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    events: Vec<Event>,
    summary: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    name: String,
    start_time: f64,
    volume: f64,
    reason: String,
    procedural: Value,
    #[serde(default)]
    text_element_id: Option<String>,
    #[serde(default)]
    word_id: Option<String>,
}
#[export]
pub fn compile_automatic_sound_effects(
    o: CompileAutomaticSoundEffectsOptions,
) -> AutomaticSoundEffectsResult {
    compile(o).unwrap_or_else(|error| AutomaticSoundEffectsResult {
        valid: false,
        source_json: String::new(),
        error,
        sound_count: 0,
        summary: String::new(),
    })
}
fn compile(o: CompileAutomaticSoundEffectsOptions) -> Result<AutomaticSoundEffectsResult, String> {
    let canonical =
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: o.source_json,
        });
    if !canonical.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value =
        serde_json::from_str(&canonical.formatted_json).map_err(|e| e.to_string())?;
    let plan: Plan = serde_json::from_str(&o.plan_json).map_err(|e| e.to_string())?;
    let catalog: HashSet<String> =
        serde_json::from_str(&o.catalog_ids_json).map_err(|e| e.to_string())?;
    if plan.events.len() > 100 || plan.summary.trim().is_empty() || plan.summary.len() > 2000 {
        return Err("Provide a summary and at most 100 intentional sound events".into());
    }
    let scene = doc["scene"]["id"].as_str().unwrap_or("scene").to_owned();
    let owner = if o.word_reveals {
        "automatic-earshot-word-reveal-v1"
    } else {
        OWNER
    };
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;
    let end = tracks
        .iter()
        .filter(|t| t["type"] != "audio")
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .map(|e| e["startTime"].as_i64().unwrap_or(0) + e["duration"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    if end <= 0 {
        return Err("Sound direction needs timed visual content".into());
    }
    for track in tracks.iter_mut() {
        if let Some(es) = track["elements"].as_array_mut() {
            es.retain(|e| e["automaticEarshotOwner"] != owner)
        }
    }
    tracks.retain(|t| {
        !(t["automaticEarshotOwner"] == owner
            && t["elements"].as_array().is_some_and(Vec::is_empty))
    });
    let mut sounds = Vec::new();
    for (i, event) in plan.events.iter().enumerate() {
        validate_procedural_audio_source(&event.procedural)?;
        if !catalog.contains(event.procedural["presetId"].as_str().unwrap_or("")) {
            return Err("Choose an exact preset from the pinned Earshot catalog".into());
        }
        if !event.start_time.is_finite()
            || event.start_time < 0.0
            || !event.volume.is_finite()
            || !(-48.0..=-3.0).contains(&event.volume)
            || event.name.trim().is_empty()
            || event.name.len() > 120
            || event.reason.trim().is_empty()
            || event.reason.len() > 1000
        {
            return Err(
                "Use finite positive timing, a name/reason and restrained volume from -48 to -3 dB"
                    .into(),
            );
        }
        let a = (event.start_time * 120000.0).round() as i64;
        let duration = (event.procedural["duration"]
            .as_f64()
            .ok_or("Missing duration")?
            * 120000.0)
            .round() as i64;
        if duration <= 0 || a.checked_add(duration).is_none_or(|b| b > end) {
            return Err("Sound event extends outside the visual timeline".into());
        }
        if !o.word_reveals
            && tracks
                .iter()
                .flat_map(|t| t["elements"].as_array().into_iter().flatten())
                .any(|e| {
                    e["automaticEarshotOwner"] == "automatic-earshot-word-reveal-v1"
                        && e["startTime"].as_i64().is_some_and(|start| {
                            start < a + duration && start + e["duration"].as_i64().unwrap_or(0) > a
                        })
                })
        {
            return Err("An existing Earshot word-reveal sound already occupies this beat; avoid duplicate accents".into());
        }
        if o.word_reveals || event.text_element_id.is_some() || event.word_id.is_some() {
            let text = tracks
                .iter()
                .filter(|t| t["hidden"] != true)
                .flat_map(|t| t["elements"].as_array().into_iter().flatten())
                .find(|e| {
                    e["type"] == "text"
                        && e["hidden"] != true
                        && e["id"].as_str() == event.text_element_id.as_deref()
                })
                .ok_or("Unknown visible text anchor")?;
            if o.word_reveals
                && !text["automaticWordAnimation"]
                    .as_array()
                    .is_some_and(|events| {
                        events
                            .iter()
                            .any(|e| e["wordId"].as_str() == event.word_id.as_deref())
                    })
            {
                return Err("Reveal sounds must anchor to words selected by the current word-animation plan".into());
            }
            let word = text["wordRuns"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|w| w["id"].as_str() == event.word_id.as_deref())
                .ok_or("Unknown timed word anchor")?;
            let start = text["startTime"].as_i64().unwrap_or(0)
                + word["startTime"].as_i64().ok_or("Missing word start")?;
            let stop = text["startTime"].as_i64().unwrap_or(0)
                + word["endTime"].as_i64().ok_or("Missing word end")?;
            if a < (start - 60_000).max(0) || a + duration > stop + 120_000 {
                return Err("Anchored sound may lead its word by at most 0.5s and trail by at most 1s; never retime speech".into());
            }
        }
        sounds.push(json!({"id":format!("{owner}:{scene}:sfx:{i}"),"type":"audio","sourceType":"procedural","name":event.name,"startTime":a,"duration":duration,"trimStart":0,"trimEnd":0,"sourceDuration":duration,"procedural":event.procedural,"automaticEarshotOwner":owner,"automaticEarshotReason":event.reason,"params":{"volume":event.volume,"muted":false,"fadeInDuration":0.005,"fadeOutDuration":0.015}}));
    }
    let count = sounds.len();
    if count > 0 {
        let base = format!("{owner}:{scene}:audio");
        let mut id = base.clone();
        let mut suffix = 0;
        while tracks.iter().any(|t| t["id"] == id) {
            suffix += 1;
            id = format!("{base}:{suffix}")
        }
        tracks.push(json!({"id":id,"type":"audio","area":"audio","name":if o.word_reveals{"Word Reveal · Earshot"}else{"Automatic Sound Effects · Earshot"},"automaticEarshotOwner":owner,"muted":false,"elements":sounds}));
    }
    let canonical =
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: doc.to_string(),
        });
    if !canonical.valid {
        return Err(format!(
            "Generated source invalid: {:?}",
            canonical.diagnostics
        ));
    }
    Ok(AutomaticSoundEffectsResult {
        valid: true,
        source_json: canonical.formatted_json,
        error: String::new(),
        sound_count: count,
        summary: plan.summary,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Value {
        json!({"schemaVersion":2,"projectSettings":{"fps":30,"canvasSize":{"width":1080,"height":1920}},"scene":{"id":"s","tracks":[{"id":"v","type":"video","area":"main","elements":[{"id":"v1","type":"video","startTime":0,"duration":1200000,"params":{}}]},{"id":"t","type":"text","area":"overlay","elements":[{"id":"caption","type":"text","startTime":120000,"duration":120000,"params":{"content":"hello"},"automaticWordAnimation":[{"wordId":"word"}],"wordRuns":[{"id":"word","text":"hello","startTime":0,"endTime":60000}]}]}]}})
    }
    fn event() -> Value {
        json!({"name":"Accent","startTime":1.0,"volume":-16,"reason":"Spoken point","procedural":{"version":1,"engine":"earshot","bankRevision":"591fa3e028032e6dce56620a20e932e35667e8d8","presetId":"ui/tap","seed":7,"duration":0.3},"textElementId":"caption","wordId":"word"})
    }
    fn run(d: Value, events: Vec<Value>, word_reveals: bool) -> AutomaticSoundEffectsResult {
        compile_automatic_sound_effects(CompileAutomaticSoundEffectsOptions {
            source_json: d.to_string(),
            plan_json: json!({"summary":"Sparse accents","events":events}).to_string(),
            catalog_ids_json: json!(["ui/tap"]).to_string(),
            word_reveals,
        })
    }
    #[test]
    fn word_sound_preserves_speech_and_is_idempotent() {
        let before = source();
        let r = run(before.clone(), vec![event()], true);
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        assert_eq!(d["scene"]["tracks"][1], before["scene"]["tracks"][1]);
        assert_eq!(
            d["scene"]["tracks"][2]["elements"][0]["sourceType"],
            "procedural"
        );
        assert_eq!(run(d, vec![event()], true).source_json, r.source_json);
    }
    #[test]
    fn wrong_word_and_past_end_reject_atomically() {
        let mut e = event();
        e["wordId"] = json!("missing");
        let r = run(source(), vec![e], true);
        assert!(!r.valid);
        assert!(r.source_json.is_empty());
        let mut e = event();
        e["startTime"] = json!(10);
        assert!(!run(source(), vec![e], false).valid);
    }
    #[test]
    fn bounded_word_lead_and_tail_preserve_anchor_and_speech() {
        let before = source();
        let mut e = event();
        e["startTime"] = json!(0.5);
        e["procedural"]["duration"] = json!(2.0);
        e["procedural"]["apex"] = json!(0.5);
        let r = run(before.clone(), vec![e.clone()], true);
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        assert_eq!(d["scene"]["tracks"][1], before["scene"]["tracks"][1]);
        assert_eq!(d["scene"]["tracks"][2]["elements"][0]["startTime"], 60000);
        e["startTime"] = json!(0.49);
        assert!(!run(source(), vec![e.clone()], true).valid);
        e["startTime"] = json!(0.5);
        e["procedural"]["duration"] = json!(2.01);
        assert!(!run(source(), vec![e], true).valid);
    }
    #[test]
    fn general_pass_rejects_duplicate_word_reveal_accents() {
        let r = run(source(), vec![event()], true);
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        let next = run(d, vec![event()], false);
        assert!(!next.valid);
        assert!(next.error.contains("already occupies"));
    }
    #[test]
    fn unselected_words_cannot_receive_automatic_reveal_sounds() {
        let mut d = source();
        d["scene"]["tracks"][1]["elements"][0]["automaticWordAnimation"] = json!([]);
        let next = run(d, vec![event()], true);
        assert!(!next.valid);
        assert!(next.error.contains("selected"));
    }
    #[test]
    fn rerun_preserves_manual_audio() {
        let r = run(source(), vec![event()], false);
        assert!(r.valid, "{}", r.error);
        let mut d: Value = serde_json::from_str(&r.source_json).unwrap();
        d["scene"]["tracks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"manual","type":"audio","area":"audio","elements":[]}));
        let r = run(d, vec![], false);
        assert!(r.valid, "{}", r.error);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        assert!(
            d["scene"]["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == "manual")
        );
    }
}
