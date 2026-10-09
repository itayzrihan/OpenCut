//! Classic-only music selection policy and canonical source compilation.
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
const OWNER: &str = "automatic-music-v1";
const TICKS: f64 = 120000.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticMusicOptions {
    pub source_json: String,
    pub assets_json: String,
    pub plan_json: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticMusicResult {
    pub valid: bool,
    pub error: String,
    pub source_json: String,
    pub catalog_json: String,
    pub duration_ticks: i64,
    pub eligible_count: usize,
    pub asset_id: String,
    pub name: String,
    pub reason: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    asset_id: String,
    reason: String,
}

fn duration_ticks(a: &Value) -> Option<i64> {
    let seconds = a["duration"].as_f64()?;
    (seconds.is_finite() && seconds > 0.0 && seconds * TICKS < 9e15)
        .then(|| (seconds * TICKS).floor() as i64)
}
fn read(o: &AutomaticMusicOptions) -> Result<(Value, Vec<Value>, i64), String> {
    let doc: Value = serde_json::from_str(&o.source_json).map_err(|e| e.to_string())?;
    let tracks = doc["scene"]["tracks"]
        .as_array()
        .ok_or("Missing scene tracks")?;
    let end = tracks
        .iter()
        .filter(|t| t["area"] == "main")
        .flat_map(|t| t["elements"].as_array().into_iter().flatten())
        .filter(|e| e["hidden"] != true && (e["type"] == "video" || e["type"] == "image"))
        .filter_map(|e| {
            e["startTime"]
                .as_i64()?
                .checked_add(e["duration"].as_i64()?)
        })
        .max()
        .filter(|e| *e > 0 && *e < 9_000_000_000_000_000)
        .ok_or("No main video duration")?;
    let assets: Vec<Value> = serde_json::from_str(&o.assets_json).map_err(|e| e.to_string())?;
    let mut ids = HashSet::new();
    let mut catalog = Vec::new();
    for a in assets.into_iter().filter(|a| a["folder"] == "music") {
        let id = a["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing music ID")?;
        if !ids.insert(id.to_string()) {
            return Err("Duplicate music ID".into());
        }
        let name = a["name"].as_str().ok_or("Missing music name")?;
        let duration = duration_ticks(&a);
        catalog.push(json!({"id":id,"name":name,"durationSeconds":a["duration"],"durationTicks":duration,"categories":a["categories"],"eligible":duration.is_some_and(|d|d>=end),"lastUsedAt":a["lastUsedAt"].as_u64().unwrap_or(0),"presentationKey":a["presentationKey"]}));
    }
    // Retain every catalog entry, but reserve recent choices when alternatives exist.
    // With a small library leave at least one choice; with one eligible song allow it.
    let eligible = catalog.iter().filter(|a| a["eligible"] == true).count();
    let mut recent: Vec<(String, u64)> = catalog
        .iter()
        .filter(|a| a["eligible"] == true && a["lastUsedAt"].as_u64().unwrap_or(0) > 0)
        .map(|a| {
            (
                a["id"].as_str().unwrap().to_owned(),
                a["lastUsedAt"].as_u64().unwrap(),
            )
        })
        .collect();
    recent.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let cooldown: HashSet<String> = recent
        .into_iter()
        .take(5.min(eligible.saturating_sub(1)))
        .map(|a| a.0)
        .collect();
    for a in &mut catalog {
        a["durationEligible"] = a["eligible"].clone();
        a["recentlyUsed"] = json!(cooldown.contains(a["id"].as_str().unwrap()));
        if a["recentlyUsed"] == true {
            a["eligible"] = json!(false);
        }
    }
    // Random keys come from the host's cryptographic RNG, once per request.
    catalog.sort_by(|a, b| {
        a["presentationKey"]
            .as_str()
            .unwrap_or("")
            .cmp(b["presentationKey"].as_str().unwrap_or(""))
    });
    for a in &mut catalog {
        a.as_object_mut().unwrap().remove("presentationKey");
    }
    Ok((doc, catalog, end))
}
#[export]
pub fn automatic_music_catalog(o: AutomaticMusicOptions) -> AutomaticMusicResult {
    match read(&o) {
        Ok((mut doc, catalog, end)) => {
            // A previous generated song is not evidence of what suits the speech.
            for track in doc["scene"]["tracks"].as_array_mut().unwrap() {
                if let Some(elements) = track["elements"].as_array_mut() {
                    elements.retain(|e| e["automaticMusicOwner"] != OWNER);
                }
            }
            doc["scene"]["tracks"].as_array_mut().unwrap().retain(|t| {
                t["automaticMusicOwner"] != OWNER
                    || t["elements"].as_array().is_some_and(|es| !es.is_empty())
            });
            AutomaticMusicResult {
                valid: true,
                source_json: doc.to_string(),
                eligible_count: catalog.iter().filter(|a| a["eligible"] == true).count(),
                catalog_json: json!(catalog).to_string(),
                duration_ticks: end,
                ..Default::default()
            }
        }
        Err(error) => AutomaticMusicResult {
            error,
            ..Default::default()
        },
    }
}
#[export]
pub fn compile_automatic_music(o: AutomaticMusicOptions) -> AutomaticMusicResult {
    match compile(o) {
        Ok(r) => r,
        Err(error) => AutomaticMusicResult {
            error,
            ..Default::default()
        },
    }
}
fn compile(o: AutomaticMusicOptions) -> Result<AutomaticMusicResult, String> {
    let (mut doc, catalog, end) = read(&o)?;
    let scene_id = doc["scene"]["id"].as_str().unwrap_or("scene").to_owned();
    let plan: Plan = serde_json::from_str(&o.plan_json).map_err(|e| e.to_string())?;
    if plan.reason.trim().is_empty() || plan.reason.len() > 4000 {
        return Err("Explain the musical choice".into());
    }
    let asset = catalog
        .iter()
        .find(|a| a["id"] == plan.asset_id)
        .ok_or("Choose an existing Music asset ID")?;
    if asset["eligible"] != true {
        if asset["recentlyUsed"] == true {
            return Err(
                "This song was used recently. Choose an eligible alternative for variety".into(),
            );
        }
        return Err(
            "Music must be at least as long as the video; never loop or stretch a shorter song"
                .into(),
        );
    }
    let source_duration = asset["durationTicks"]
        .as_i64()
        .ok_or("Unknown music duration")?;
    let tracks = doc["scene"]["tracks"]
        .as_array_mut()
        .ok_or("Missing tracks")?;
    for t in tracks.iter_mut() {
        if let Some(es) = t["elements"].as_array_mut() {
            es.retain(|e| e["automaticMusicOwner"] != OWNER);
        }
    }
    tracks.retain(|t| {
        !(t["automaticMusicOwner"] == OWNER
            && t["elements"].as_array().is_some_and(|es| es.is_empty()))
    });
    let used: HashSet<String> = tracks
        .iter()
        .flat_map(|t| std::iter::once(t).chain(t["elements"].as_array().into_iter().flatten()))
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect();
    let mut suffix = 0;
    while used.contains(&format!("{OWNER}:{scene_id}:track:{suffix}"))
        || used.contains(&format!("{OWNER}:{scene_id}:clip:{suffix}"))
    {
        suffix += 1;
    }
    tracks.push(json!({"id":format!("{OWNER}:{scene_id}:track:{suffix}"),"name":"Automatic Music","type":"audio","area":"audio","muted":false,"automaticMusicOwner":OWNER,"elements":[{
        "id":format!("{OWNER}:{scene_id}:clip:{suffix}"),"name":asset["name"],"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":plan.asset_id,
        "startTime":0,"duration":end,"sourceDuration":source_duration,"trimStart":0,"trimEnd":source_duration-end,"automaticMusicOwner":OWNER,"automaticMusicReason":plan.reason,
        "params":{"volume":-31,"muted":false,"fadeInDuration":0,"fadeOutDuration":0}
    }]}));
    Ok(AutomaticMusicResult {
        valid: true,
        source_json: doc.to_string(),
        duration_ticks: end,
        asset_id: plan.asset_id,
        name: asset["name"].as_str().unwrap().into(),
        reason: plan.reason,
        ..Default::default()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_model_choice_is_rejected_and_complete_catalog_is_retained() {
        let assets: Vec<Value> = (0..12).map(|i|json!({"id":format!("song-{i}"),"name":format!("Song {i}"),"folder":"music","duration":180,"lastUsedAt":if i<5 {100-i} else {0},"presentationKey":format!("{:02}",11-i)})).collect();
        let mut o = options(doc(), "song-0");
        o.assets_json = json!(assets).to_string();
        let prepared = automatic_music_catalog(options_with_assets(&o));
        let catalog: Vec<Value> = serde_json::from_str(&prepared.catalog_json).unwrap();
        assert_eq!(catalog.len(), 12);
        assert_eq!(prepared.eligible_count, 7);
        assert_eq!(catalog[0]["id"], "song-11");
        assert!(
            compile_automatic_music(options_with_assets(&o))
                .error
                .contains("recently")
        );
        o.plan_json = json!({"assetId":"song-11","reason":"Fits the speech"}).to_string();
        assert!(compile_automatic_music(o).valid);
    }
    fn options_with_assets(o: &AutomaticMusicOptions) -> AutomaticMusicOptions {
        AutomaticMusicOptions {
            source_json: o.source_json.clone(),
            assets_json: o.assets_json.clone(),
            plan_json: o.plan_json.clone(),
        }
    }
    #[test]
    fn small_library_rotates_but_single_long_enough_song_remains_available() {
        let mut o = options(doc(), "long");
        let mut a = assets();
        a[1]["lastUsedAt"] = json!(100);
        a[2]["lastUsedAt"] = json!(200);
        o.assets_json = a.to_string();
        assert_eq!(
            automatic_music_catalog(options_with_assets(&o)).eligible_count,
            1
        );
        assert!(!compile_automatic_music(options_with_assets(&o)).valid);
        a[1]["duration"] = json!(30);
        o.assets_json = a.to_string();
        assert!(compile_automatic_music(o).valid);
    }
    #[test]
    fn planning_context_removes_old_music_without_modifying_compilation_source() {
        let first = compile_automatic_music(options(doc(), "long"));
        let original: Value = serde_json::from_str(&first.source_json).unwrap();
        let o = options(original.clone(), "exact");
        let prepared = automatic_music_catalog(options_with_assets(&o));
        assert!(!prepared.source_json.contains("automaticMusicReason"));
        assert!(prepared.source_json.contains("manual"));
        assert!(o.source_json.contains("automaticMusicReason"));
        assert!(compile_automatic_music(o).valid);
    }
    fn doc() -> Value {
        json!({"schemaVersion":2,"scene":{"tracks":[{"id":"v","area":"main","type":"video","elements":[{"type":"video","startTime":0,"duration":14400000}]},{"id":"manual","area":"audio","type":"audio","elements":[{"id":"sfx","duration":20000000}]}]}})
    }
    fn assets() -> Value {
        json!([{"id":"short","name":"Short","folder":"music","duration":60},{"id":"exact","name":"Exact","folder":"music","duration":120},{"id":"long","name":"Long","folder":"music","duration":180},{"id":"sfx","name":"Effect","folder":"sfx","duration":200},{"id":"unknown","name":"Unknown","folder":"music"}])
    }
    fn options(d: Value, id: &str) -> AutomaticMusicOptions {
        AutomaticMusicOptions {
            source_json: d.to_string(),
            assets_json: assets().to_string(),
            plan_json: json!({"assetId":id,"reason":"Calm speech needs a restrained bed"})
                .to_string(),
        }
    }
    #[test]
    fn catalog_uses_main_video_not_sound_tails() {
        let r = automatic_music_catalog(options(doc(), "long"));
        assert!(r.valid);
        assert_eq!(r.duration_ticks, 14400000);
        assert_eq!(r.eligible_count, 2);
        assert!(!r.catalog_json.contains("Effect"));
    }
    #[test]
    fn rejects_short_unknown_and_non_music() {
        for id in ["short", "unknown", "sfx", "invented"] {
            assert!(!compile_automatic_music(options(doc(), id)).valid);
        }
    }
    #[test]
    fn exact_and_long_are_full_span_at_minus_31() {
        for (id, trim) in [("exact", 0), ("long", 7200000)] {
            let r = compile_automatic_music(options(doc(), id));
            assert!(r.valid, "{}", r.error);
            let d: Value = serde_json::from_str(&r.source_json).unwrap();
            let e = &d["scene"]["tracks"][2]["elements"][0];
            assert_eq!(e["duration"], 14400000);
            assert_eq!(e["startTime"], 0);
            assert_eq!(e["trimEnd"], trim);
            assert_eq!(e["params"]["volume"], -31);
            assert_eq!(d["scene"]["tracks"][1], doc()["scene"]["tracks"][1]);
        }
    }
    #[test]
    fn rerun_replaces_owned_music_preserves_manual_audio_and_ids() {
        let first = compile_automatic_music(options(doc(), "long"));
        let mut d: Value = serde_json::from_str(&first.source_json).unwrap();
        d["scene"]["tracks"][2]["elements"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"manual-added","name":"Manual"}));
        let r = compile_automatic_music(options(d, "exact"));
        assert!(r.valid);
        let d: Value = serde_json::from_str(&r.source_json).unwrap();
        let ts = d["scene"]["tracks"].as_array().unwrap();
        assert_eq!(ts.len(), 4);
        assert_eq!(ts[2]["elements"].as_array().unwrap().len(), 1);
        assert_ne!(ts[2]["id"], ts[3]["id"]);
    }
    #[test]
    fn revalidated_short_actual_file_is_rejected() {
        let mut o = options(doc(), "long");
        let mut a = assets();
        a[2]["duration"] = json!(119.999);
        o.assets_json = a.to_string();
        assert!(!compile_automatic_music(o).valid);
    }
    #[test]
    fn empty_video_and_duplicate_ids_rejected() {
        let mut d = doc();
        d["scene"]["tracks"][0]["elements"] = json!([]);
        assert!(!automatic_music_catalog(options(d, "long")).valid);
        let mut o = options(doc(), "long");
        o.assets_json = json!([assets()[0], assets()[0]]).to_string();
        assert!(!automatic_music_catalog(o).valid);
    }

    #[test]
    fn music_ids_do_not_collide_between_scenes() {
        let mut ids = std::collections::HashSet::new();
        for scene in ["smart-a", "smart-b"] {
            let mut input = doc();
            input["scene"]["id"] = json!(scene);
            let result = compile_automatic_music(options(input, "long"));
            assert!(result.valid, "{}", result.error);
            let output: Value = serde_json::from_str(&result.source_json).unwrap();
            let track = output["scene"]["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["automaticMusicOwner"] == OWNER)
                .unwrap();
            assert!(ids.insert(track["id"].as_str().unwrap().to_owned()));
            assert!(ids.insert(track["elements"][0]["id"].as_str().unwrap().to_owned()));
        }
    }
}
