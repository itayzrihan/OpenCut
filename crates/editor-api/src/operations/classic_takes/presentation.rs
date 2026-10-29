//! Rebase presentation-only edits when choosing another archived performance.
//! Timing, dialogue, media, audio sync and authored overlays remain conflict guards.
use super::*;
type Patches = HashMap<(String, Option<u64>), serde_json::Map<String, Value>>;
fn visual(key: &str) -> bool {
    key.starts_with("transform.") || matches!(key, "opacity" | "blendMode")
}
fn normalized(value: &Value) -> Value {
    fn walk(v: &mut Value, ids: &HashMap<String, String>) {
        match v {
            Value::String(s) => {
                if let Some(id) = ids.get(s) {
                    *s = id.clone();
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|v| walk(v, ids)),
            Value::Object(o) => o.values_mut().for_each(|v| walk(v, ids)),
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() <= crate::classic::MAX_SAFE_INTEGER as f64 {
                        *n = serde_json::Number::from(f as i64);
                    }
                }
            }
            _ => {}
        }
    }
    let mut v = value.clone();
    let mut ids = HashMap::new();
    for t in all(&v) {
        if let Some(id) = t["captionSource"]["sourceId"].as_str() {
            if !ids.contains_key(id) {
                ids.insert(id.into(), format!("source-{}", ids.len()));
            }
        }
        for e in arr(&t["elements"]) {
            if let Some(id) = e["id"].as_str() {
                ids.insert(id.into(), format!("element-{}", ids.len()));
            }
        }
    }
    walk(&mut v, &ids);
    v
}
fn conflict() -> CapabilityError {
    CapabilityError::Conflict("Take timing or content changed after assembly. Undo those structural edits before switching takes; framing and caption position edits are preserved.".into())
}
pub(super) fn capture(
    a: &Assembly,
    scene: &Value,
    canvas: &Value,
    context: &InvocationContext,
) -> Result<Patches, CapabilityError> {
    let (words, start, end) = assembly_inventory(a)?;
    let mut next = 0;
    let (baseline, bookmarks) = render(
        a,
        &words,
        start,
        end,
        canvas,
        &mut || {
            next += 1;
            format!("comparison-{next}")
        },
        context,
    )?;
    if digest(&json!({}), &bookmarks) != digest(&json!({}), &scene["bookmarks"]) {
        return Err(conflict());
    }
    let mut current = scene["tracks"].clone();
    let mut patches = Patches::new();
    for (key, base_tracks) in [
        ("main", vec![&baseline["main"]]),
        ("overlay", arr(&baseline["overlay"]).iter().collect()),
        ("audio", arr(&baseline["audio"]).iter().collect()),
    ] {
        let current_tracks: Vec<&mut Value> = if key == "main" {
            vec![&mut current["main"]]
        } else {
            current[key]
                .as_array_mut()
                .ok_or_else(conflict)?
                .iter_mut()
                .collect()
        };
        if current_tracks.len() != base_tracks.len() {
            return Err(conflict());
        }
        for (base, live) in base_tracks.into_iter().zip(current_tracks) {
            let track_id = live["id"].as_str().ok_or_else(conflict)?.to_owned();
            let elements = live["elements"].as_array_mut().ok_or_else(conflict)?;
            if elements.len() != arr(&base["elements"]).len() {
                return Err(conflict());
            }
            for (b, e) in arr(&base["elements"]).iter().zip(elements) {
                let group = e["takeGroup"]["groupIndex"].as_u64();
                let mut patch = serde_json::Map::new();
                let params = e["params"].as_object_mut().ok_or_else(conflict)?;
                let keys: HashSet<String> = params
                    .keys()
                    .chain(b["params"].as_object().ok_or_else(conflict)?.keys())
                    .cloned()
                    .collect();
                for k in keys {
                    if !visual(&k) {
                        continue;
                    }
                    if params.get(&k) != b["params"].get(&k) {
                        // Defaults are explicit in authored UI params; absent removals are structural.
                        patch.insert(k.clone(), params.get(&k).cloned().ok_or_else(conflict)?);
                        if let Some(v) = b["params"].get(&k) {
                            params.insert(k, v.clone());
                        } else {
                            params.remove(&k);
                        }
                    }
                }
                let key = (track_id.clone(), group);
                if let Some(prior) = patches.get(&key) {
                    if prior != &patch {
                        return Err(conflict());
                    }
                } else {
                    patches.insert(key, patch);
                }
            }
        }
    }
    if normalized(&baseline) != normalized(&current) {
        return Err(conflict());
    }
    Ok(patches)
}
pub(super) fn apply(tracks: &mut Value, patches: Patches) {
    let update = |track: &mut Value| {
        let id = track["id"].as_str().unwrap_or("").to_owned();
        for e in track["elements"].as_array_mut().into_iter().flatten() {
            let group = e["takeGroup"]["groupIndex"].as_u64();
            if let Some(patch) = patches.get(&(id.clone(), group)) {
                if let Some(params) = e["params"].as_object_mut() {
                    params.extend(patch.clone());
                }
            }
        }
    };
    update(&mut tracks["main"]);
    for key in ["overlay", "audio"] {
        for t in tracks[key].as_array_mut().into_iter().flatten() {
            update(t);
        }
    }
}
