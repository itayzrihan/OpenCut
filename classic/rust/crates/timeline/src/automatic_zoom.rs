//! Classic-only zoom planning. The full Timeline Source transaction remains the
//! owner of state; this module has no store and never executes model-authored code.
use crate::{CanonicalizeTimelineSourceDocumentOptions, canonicalize_timeline_source_document};
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const TICKS: f64 = 120_000.0;
const OWNER: &str = "automatic-zoom-v1";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicZoomPreset {
    pub name: String,
    pub style: String,
    pub description: String,
    pub duration: f64,
    pub scale: f64,
    pub attack: f64,
    pub release: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
}

/// Manual presets share the exact native sampler used by AI-authored zooms.
/// They are unowned manual elements, so rerunning AI never deletes them.
#[export]
pub fn classic_zoom_presets() -> Vec<ClassicZoomPreset> {
    [
        (
            "Jump Cut",
            "jump-cut",
            "Instant punch · eased return",
            2.0,
            1.18,
            0.0,
            0.8,
        ),
        (
            "Smooth",
            "smooth",
            "Gentle approach · eased return",
            2.4,
            1.16,
            0.6,
            0.7,
        ),
        (
            "Snap In",
            "snap-in",
            "Quick entry · eased return",
            2.0,
            1.18,
            0.18,
            0.8,
        ),
        (
            "Zoom Out",
            "zoom-out",
            "Start close · gently pull back",
            2.0,
            1.18,
            0.0,
            0.8,
        ),
    ]
    .into_iter()
    .map(
        |(name, style, description, duration, scale, attack, release)| ClassicZoomPreset {
            name: name.into(),
            style: style.into(),
            description: description.into(),
            duration,
            scale,
            attack,
            release,
            anchor_x: 0.5,
            anchor_y: 0.4,
        },
    )
    .collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ZoomPlan {
    events: Vec<ZoomEvent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ZoomEvent {
    start: f64,
    end: f64,
    style: String,
    scale: f64,
    attack: f64,
    release: f64,
    anchor_x: f64,
    anchor_y: f64,
    reason: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileAutomaticZoomOptions {
    pub source_json: String,
    pub plan_json: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticZoomResult {
    pub valid: bool,
    pub source_json: String,
    pub error: String,
    pub zoom_count: usize,
    pub sound_count: usize,
}

#[export]
pub fn compile_automatic_zoom(options: CompileAutomaticZoomOptions) -> AutomaticZoomResult {
    match compile(options) {
        Ok(result) => result,
        Err(error) => AutomaticZoomResult {
            valid: false,
            source_json: String::new(),
            error,
            zoom_count: 0,
            sound_count: 0,
        },
    }
}

fn compile(options: CompileAutomaticZoomOptions) -> Result<AutomaticZoomResult, String> {
    let canonical =
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: options.source_json,
        });
    if !canonical.valid {
        return Err("Invalid Timeline Source".into());
    }
    let mut doc: Value =
        serde_json::from_str(&canonical.formatted_json).map_err(|e| e.to_string())?;
    let plan: ZoomPlan =
        serde_json::from_str(&options.plan_json).map_err(|e| format!("Invalid zoom plan: {e}"))?;
    let scene_id = doc["scene"]["id"]
        .as_str()
        .ok_or("Missing scene")?
        .to_owned();
    let fps = doc["projectSettings"]["fps"]["numerator"]
        .as_f64()
        .unwrap_or(30.0)
        / doc["projectSettings"]["fps"]["denominator"]
            .as_f64()
            .unwrap_or(1.0);
    if !fps.is_finite() || !(1.0..=240.0).contains(&fps) {
        return Err("Invalid frame rate".into());
    }
    let frame = TICKS / fps;
    let quantize = |s: f64| ((s * TICKS / frame).round() * frame).round() as i64;
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;
    let main = tracks
        .iter()
        .find(|t| t["area"] == "main")
        .ok_or("Main video track required")?;
    if main["hidden"] == true {
        return Err("Main video track is hidden".into());
    }
    let mut spans: Vec<(i64, i64)> = main["elements"]
        .as_array()
        .ok_or("Missing video")?
        .iter()
        .filter(|e| e["type"] == "video" && e["hidden"] != true)
        .filter_map(|e| {
            Some((
                e["startTime"].as_i64()?,
                e["startTime"].as_i64()? + e["duration"].as_i64()?,
            ))
        })
        .collect();
    spans.sort();
    let end = spans
        .iter()
        .map(|s| s.1)
        .max()
        .ok_or("Main video track required")?;
    let total: i64 = spans.iter().map(|s| s.1 - s.0).sum();
    if plan.events.is_empty() {
        return Err("No suitable zooms returned; timeline unchanged".into());
    }
    if plan.events.len() > ((total as f64 / TICKS / 3.0).ceil() as usize).max(1) {
        return Err("Too many zooms: allow at most one event per three seconds on average".into());
    }
    // Merge adjacent silence-cut clips for coverage, but never bridge a real gap.
    let mut coverage: Vec<(i64, i64)> = Vec::new();
    for (a, b) in &spans {
        if let Some(last) = coverage.last_mut() {
            if *a <= last.1 {
                last.1 = last.1.max(*b);
                continue;
            }
        }
        coverage.push((*a, *b));
    }
    let mut effects = Vec::new();
    let mut sounds = Vec::new();
    let mut previous_end = -TICKS as i64;
    let mut previous_sound = -10.0;
    let mut covered = 0i64;
    for (i, e) in plan.events.iter().enumerate() {
        let fail = |message: &str| format!("Zoom {}: {message}", i + 1);
        if [
            e.start, e.end, e.scale, e.attack, e.release, e.anchor_x, e.anchor_y,
        ]
        .iter()
        .any(|v| !v.is_finite())
        {
            return Err(fail("non-finite parameter"));
        }
        if !["jump-cut", "smooth", "snap-in", "zoom-out"].contains(&e.style.as_str()) {
            return Err(fail("unknown style"));
        }
        if !(1.04..=1.30).contains(&e.scale)
            || !(0.0..=1.0).contains(&e.anchor_x)
            || !(0.0..=1.0).contains(&e.anchor_y)
        {
            return Err(fail("scale must be 1.04–1.30; anchors must be 0–1"));
        }
        if e.start < 0.0 || e.end <= e.start || e.end > end as f64 / TICKS + 0.5 / fps {
            return Err(fail("event must lie inside the video"));
        }
        let start = quantize(e.start);
        let stop = quantize(e.end);
        let duration = stop - start;
        if e.start < 0.0 || duration < quantize(0.6) || duration > quantize(4.5) || stop > end {
            return Err(fail("duration must be 0.6–4.5 seconds inside the video"));
        }
        if start < previous_end + quantize(0.35) {
            return Err(fail(
                "events must be ordered with at least 0.35 seconds of breathing room",
            ));
        }
        if !coverage.iter().any(|(a, b)| start >= *a && stop <= *b) {
            return Err(fail("zoom crosses an empty video gap"));
        }
        if !(0.0..=1.2).contains(&e.attack)
            || !(0.0..=1.2).contains(&e.release)
            || e.attack + e.release > duration as f64 / TICKS
        {
            return Err(fail("invalid attack/release times"));
        }
        if (e.style == "smooth" && (e.attack < 0.3 || e.release < 0.3))
            || (e.style == "snap-in" && !(0.08..=0.35).contains(&e.attack))
            || (e.style == "zoom-out" && e.release < 0.3)
        {
            return Err(fail("animation is too fast or missing"));
        }
        if e.reason.trim().is_empty() || e.reason.len() > 1000 {
            return Err(fail("short semantic reason required"));
        }
        let id = format!("{OWNER}:{scene_id}:{i}");
        let release = if ["snap-in", "jump-cut"].contains(&e.style.as_str()) {
            e.release
                .max(0.6)
                .min((duration as f64 / TICKS - e.attack).max(0.001))
        } else {
            e.release
        };
        effects.push(
            json!({"id":id,"type":"effect","name":format!("{} · {}",e.style,e.reason),
            "startTime":start,"duration":duration,"trimStart":0,"trimEnd":0,
            "effectType":"automatic-zoom","enabled":true,
            "params":{"style":e.style,"scale":e.scale,"attack":e.attack,"release":release,
                "anchorX":e.anchor_x,"anchorY":e.anchor_y,"spanSeconds":duration as f64/TICKS},
            "automaticZoomOwner":OWNER}),
        );
        // Sound is a product rule, never a model field. Use the existing authored
        // authored 1.38s Whoosh End excerpt at -35dB, with a minimum 3s cadence.
        if ["snap-in", "jump-cut"].contains(&e.style.as_str())
            && e.scale >= 1.12
            && e.start - previous_sound >= 3.0
        {
            let sound_duration = (end - start).min(165_600);
            sounds.push(json!({"id":format!("{id}:swish"),"type":"audio","sourceType":"library",
                "name":"Automatic Zoom · Swish","startTime":start,"duration":sound_duration,
                "trimStart":0,"trimEnd":964800-sound_duration,"sourceDuration":964800,
                "libraryAssetId":"19f29ed9-a604-4933-ae8c-e494b6cee47f","librarySourceType":"shared",
                "params":{"volume":-35,"muted":false,"fadeInDuration":0,"fadeOutDuration":0.05},
                "automaticZoomOwner":OWNER,"automaticZoomElementId":id}));
            previous_sound = e.start;
        }
        previous_end = stop;
        covered += duration;
    }
    if covered as f64 > total as f64 * 0.65 {
        return Err("Zoom coverage exceeds 65%; leave resting shots".into());
    }
    // Remove owned elements wherever users moved them; preserve manual elements
    // even if they share a generated track. Do not identify ownership by a name.
    for t in tracks.iter_mut() {
        if let Some(elements) = t["elements"].as_array_mut() {
            elements.retain(|e| e["automaticZoomOwner"] != OWNER);
        }
    }
    tracks.retain(|t| {
        !(t["automaticZoomOwner"] == OWNER
            && t["elements"].as_array().is_some_and(|a| a.is_empty()))
    });
    let main_index = tracks
        .iter()
        .position(|t| t["area"] == "main")
        .ok_or("Missing main")?;
    let zoom_count = effects.len();
    let sound_count = sounds.len();
    let unique_track_id = |suffix: &str| {
        let base = format!("{OWNER}:{scene_id}:{suffix}");
        let mut id = base.clone();
        let mut n = 0;
        while tracks.iter().any(|t| t["id"] == id) {
            n += 1;
            id = format!("{base}:{n}");
        }
        id
    };
    let effects_id = unique_track_id("effects");
    let audio_id = unique_track_id("audio");
    tracks.insert(
        main_index,
        json!({"id":effects_id,"area":"overlay","type":"effect",
        "name":"Automatic Zoom","hidden":false,"automaticZoomOwner":OWNER,"elements":effects}),
    );
    if !sounds.is_empty() {
        tracks.push(json!({"id":audio_id,"area":"audio","type":"audio",
        "name":"Automatic Zoom · Swish","muted":false,"automaticZoomOwner":OWNER,"elements":sounds}));
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
    Ok(AutomaticZoomResult {
        valid: true,
        source_json: canonical.formatted_json,
        error: String::new(),
        zoom_count,
        sound_count,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleAutomaticZoomOptions {
    pub style: String,
    pub scale: f64,
    pub attack: f64,
    pub release: f64,
    pub duration: f64,
    pub time: f64,
}

#[export]
pub fn sample_automatic_zoom(p: SampleAutomaticZoomOptions) -> f64 {
    if [p.scale, p.attack, p.release, p.duration, p.time]
        .iter()
        .any(|v| !v.is_finite())
        || p.duration <= 0.0
        || p.time < 0.0
        || p.time >= p.duration
    {
        return 1.0;
    }
    let ease = |v: f64| {
        let v = v.clamp(0.0, 1.0);
        v * v * (3.0 - 2.0 * v)
    };
    let attack = p.attack.max(0.001).min(p.duration);
    let release = if ["jump-cut", "snap-in"].contains(&p.style.as_str()) && p.release <= 0.0 {
        0.6_f64.min(p.duration * 0.6)
    } else {
        p.release.max(0.001).min(p.duration)
    };
    let amount = match p.style.as_str() {
        "jump-cut" => ease((p.duration - p.time) / release),
        "snap-in" => ease(p.time / attack).min(ease((p.duration - p.time) / release)),
        "zoom-out" => 1.0 - ease(p.time / release),
        "smooth" => ease(p.time / attack).min(ease((p.duration - p.time) / release)),
        _ => 0.0,
    };
    1.0 + (p.scale.clamp(1.0, 1.30) - 1.0) * amount
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classic_presets_share_native_envelopes_and_finish_at_baseline() {
        let presets = classic_zoom_presets();
        assert_eq!(
            presets.iter().map(|p| p.style.as_str()).collect::<Vec<_>>(),
            ["jump-cut", "smooth", "snap-in", "zoom-out"]
        );
        for p in presets {
            assert!(p.attack + p.release < p.duration);
            let at = |time| {
                sample_automatic_zoom(SampleAutomaticZoomOptions {
                    style: p.style.clone(),
                    scale: p.scale,
                    attack: p.attack,
                    release: p.release,
                    duration: p.duration,
                    time,
                })
            };
            assert!((at(p.duration - 0.0001) - 1.0).abs() < 0.00001);
            assert_eq!(at(p.duration), 1.0);
            assert!((0..100).any(|i| at(i as f64 * p.duration / 100.0) > 1.1));
        }
    }
    fn source() -> Value {
        json!({"schemaVersion":2,"projectSettings":{"fps":{"numerator":30,"denominator":1}},
        "scene":{"id":"s","name":"Scene","tracks":[
            {"id":"captions","area":"overlay","type":"text","elements":[{"id":"caption","type":"text","startTime":0,"duration":1200000,"params":{"content":"Real speech"}}]},
            {"id":"main","area":"main","type":"video","elements":[{"id":"video","type":"video","startTime":0,"duration":1200000,"params":{"scale":1.7}}]}
        ]}})
    }
    fn event() -> Value {
        json!({"start":2,"end":4,"style":"snap-in","scale":1.18,"attack":0.2,"release":0,"anchorX":0.5,"anchorY":0.4,"reason":"Actual key phrase"})
    }
    fn run(doc: Value, events: Vec<Value>) -> AutomaticZoomResult {
        compile_automatic_zoom(CompileAutomaticZoomOptions {
            source_json: doc.to_string(),
            plan_json: json!({"events":events}).to_string(),
        })
    }
    #[test]
    fn preserves_originals_and_places_effect_below_captions_with_deterministic_sound() {
        let before = source();
        let r = run(before.clone(), vec![event()]);
        assert!(r.valid, "{}", r.error);
        let after: Value = serde_json::from_str(&r.source_json).unwrap();
        let tracks = &after["scene"]["tracks"];
        assert_eq!(tracks[0], before["scene"]["tracks"][0]);
        assert_eq!(tracks[2], before["scene"]["tracks"][1]);
        assert_eq!(tracks[1]["elements"][0]["effectType"], "automatic-zoom");
        assert_eq!(
            tracks[3]["elements"][0]["libraryAssetId"],
            "19f29ed9-a604-4933-ae8c-e494b6cee47f"
        );
        assert_eq!(r.sound_count, 1);
        assert_eq!(tracks[3]["elements"][0]["params"]["volume"], -35);
        assert_eq!(tracks[1]["elements"][0]["params"]["release"], 0.6);
        assert_eq!(tracks[3]["elements"][0]["params"]["fadeOutDuration"], 0.05);
        assert_eq!(run(after, vec![event()]).source_json, r.source_json);
    }
    #[test]
    fn rerun_preserves_manual_elements_in_generated_track() {
        let first = run(source(), vec![event()]);
        let mut doc: Value = serde_json::from_str(&first.source_json).unwrap();
        doc["scene"]["tracks"][1]["elements"].as_array_mut().unwrap().push(json!({"id":"manual","type":"effect","startTime":900000,"duration":120000,"effectType":"blur"}));
        let result = run(doc, vec![event()]);
        assert!(result.valid, "{}", result.error);
        assert!(result.source_json.contains("manual"));
    }
    #[test]
    fn rejects_invalid_plans_without_partial_document() {
        for (key, value) in [
            ("scale", json!(2)),
            ("start", json!(-1)),
            ("end", json!(12)),
            ("anchorX", json!(2)),
            ("style", json!("overlay-movement")),
            ("sound", json!(true)),
        ] {
            let mut e = event();
            e[key] = value;
            let r = run(source(), vec![e]);
            assert!(!r.valid, "{key}");
            assert!(r.source_json.is_empty());
        }
    }
    #[test]
    fn rejects_overlap_and_gaps() {
        let mut second = event();
        second["start"] = json!(3);
        second["end"] = json!(5);
        assert!(!run(source(), vec![event(), second]).valid);
        let mut doc = source();
        doc["scene"]["tracks"][1]["elements"][0]["startTime"] = json!(360000);
        assert!(!run(doc, vec![event()]).valid);
    }

    #[test]
    fn allows_adjacent_cuts_but_rejects_empty_or_hidden_spans() {
        let mut doc = source();
        doc["scene"]["tracks"][1]["elements"] = json!([
            {"id":"a","type":"video","startTime":0,"duration":360000},
            {"id":"b","type":"video","startTime":360000,"duration":840000}
        ]);
        assert!(run(doc.clone(), vec![event()]).valid);
        doc["scene"]["tracks"][1]["elements"][1]["startTime"] = json!(400000);
        assert!(!run(doc.clone(), vec![event()]).valid);
        doc["scene"]["tracks"][1]["elements"][1]["startTime"] = json!(360000);
        doc["scene"]["tracks"][1]["elements"][1]["hidden"] = json!(true);
        assert!(!run(doc, vec![event()]).valid);
    }

    #[test]
    fn rejects_excessive_density_coverage_and_extreme_timestamps() {
        let mut events = Vec::new();
        for i in 0..5 {
            let mut e = event();
            e["start"] = json!(i as f64 * 1.5);
            e["end"] = json!(i as f64 * 1.5 + 0.8);
            events.push(e);
        }
        assert!(!run(source(), events).valid);
        let mut a = event();
        a["start"] = json!(0);
        a["end"] = json!(4);
        let mut b = event();
        b["start"] = json!(5);
        b["end"] = json!(9);
        assert!(!run(source(), vec![a, b]).valid);
        let mut e = event();
        e["start"] = json!(-1e99);
        e["end"] = json!(1e99);
        assert!(!run(source(), vec![e]).valid);
        let tiny = sample_automatic_zoom(SampleAutomaticZoomOptions {
            style: "smooth".into(),
            scale: 1.2,
            attack: 0.5,
            release: 0.5,
            duration: 1.0 / TICKS,
            time: 0.0,
        });
        assert_eq!(tiny, 1.0);
    }
    #[test]
    fn sound_policy_is_selective_and_cadenced() {
        let mut a = event();
        a["end"] = json!(3);
        let mut b = event();
        b["start"] = json!(4);
        b["end"] = json!(5);
        let mut c = event();
        c["start"] = json!(7);
        c["end"] = json!(8);
        c["scale"] = json!(1.1);
        let r = run(source(), vec![a, b, c]);
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.sound_count, 1);
    }
    fn sample(style: &str, t: f64) -> f64 {
        sample_automatic_zoom(SampleAutomaticZoomOptions {
            style: style.into(),
            scale: 1.2,
            attack: 0.5,
            release: 0.5,
            duration: 2.0,
            time: t,
        })
    }
    #[test]
    fn envelope_is_seekable_and_returns_to_baseline() {
        assert_eq!(sample("smooth", 0.0), 1.0);
        assert_eq!(sample("smooth", 1.0), 1.2);
        assert_eq!(sample("smooth", 2.0), 1.0);
        assert_eq!(sample("snap-in", 0.0), 1.0);
        assert!(sample("snap-in", 1.9) < 1.03);
        assert!(sample("jump-cut", 1.9) < 1.03);
        assert_eq!(sample("jump-cut", 0.0), 1.2);
        assert_eq!(sample("zoom-out", 0.0), 1.2);
        assert_eq!(sample("zoom-out", 0.5), 1.0);
        for style in ["smooth", "snap-in", "jump-cut", "zoom-out"] {
            for i in 0..201 {
                let v = sample(style, i as f64 / 100.0);
                assert!((1.0..=1.2).contains(&v));
            }
        }
        assert_eq!(sample("smooth", 0.25), sample("smooth", 1.75));
        assert_eq!(sample("smooth", f64::NAN), 1.0);
    }

    #[test]
    fn legacy_sharp_zooms_also_ease_out_without_a_zero_release_jump() {
        for style in ["snap-in", "jump-cut"] {
            let at = |time| {
                sample_automatic_zoom(SampleAutomaticZoomOptions {
                    style: style.into(),
                    scale: 1.2,
                    attack: 0.2,
                    release: 0.0,
                    duration: 2.0,
                    time,
                })
            };
            assert_eq!(at(1.0), 1.2);
            assert!(at(1.6) > at(1.8));
            assert!(at(1.8) > at(1.95));
            assert!((at(1.99999) - 1.0).abs() < 0.000001);
            assert_eq!(at(2.0), 1.0);
        }
    }
}
