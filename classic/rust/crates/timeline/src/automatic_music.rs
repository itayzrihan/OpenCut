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
        catalog.push(json!({"id":id,"name":name,"durationSeconds":a["duration"],"durationTicks":duration,"categories":a["categories"],"eligible":duration.is_some_and(|d|d>=end)}));
    }
    Ok((doc, catalog, end))
}
#[export]
pub fn automatic_music_catalog(o: AutomaticMusicOptions) -> AutomaticMusicResult {
    match read(&o) {
        Ok((_, catalog, end)) => AutomaticMusicResult {
            valid: true,
            eligible_count: catalog.iter().filter(|a| a["eligible"] == true).count(),
            catalog_json: json!(catalog).to_string(),
            duration_ticks: end,
            ..Default::default()
        },
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
    let plan: Plan = serde_json::from_str(&o.plan_json).map_err(|e| e.to_string())?;
    if plan.reason.trim().is_empty() || plan.reason.len() > 4000 {
        return Err("Explain the musical choice".into());
    }
    let asset = catalog
        .iter()
        .find(|a| a["id"] == plan.asset_id)
        .ok_or("Choose an existing Music asset ID")?;
    if asset["eligible"] != true {
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
    while used.contains(&format!("{OWNER}:track:{suffix}"))
        || used.contains(&format!("{OWNER}:clip:{suffix}"))
    {
        suffix += 1;
    }
    tracks.push(json!({"id":format!("{OWNER}:track:{suffix}"),"name":"Automatic Music","type":"audio","area":"audio","muted":false,"automaticMusicOwner":OWNER,"elements":[{
        "id":format!("{OWNER}:clip:{suffix}"),"name":asset["name"],"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":plan.asset_id,
        "startTime":0,"duration":end,"sourceDuration":source_duration,"trimStart":0,"trimEnd":source_duration-end,"automaticMusicOwner":OWNER,"automaticMusicReason":plan.reason,
        "params":{"volume":-28,"muted":false,"fadeInDuration":0,"fadeOutDuration":0}
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
    fn exact_and_long_are_full_span_at_minus_28() {
        for (id, trim) in [("exact", 0), ("long", 7200000)] {
            let r = compile_automatic_music(options(doc(), id));
            assert!(r.valid, "{}", r.error);
            let d: Value = serde_json::from_str(&r.source_json).unwrap();
            let e = &d["scene"]["tracks"][2]["elements"][0];
            assert_eq!(e["duration"], 14400000);
            assert_eq!(e["startTime"], 0);
            assert_eq!(e["trimEnd"], trim);
            assert_eq!(e["params"]["volume"], -28);
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
}
