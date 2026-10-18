//! Lossless source binding transaction shared by native and classic host adapters.
use serde_json::{json, Value};

pub fn missing_used(project: &Value, assets: &[Value]) -> Vec<String> {
    fn visit(value: &Value, ids: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::Object(fields) => {
                if let Some(id) = fields.get("mediaId").and_then(Value::as_str) { ids.insert(id.into()); }
                for child in fields.values() { visit(child, ids); }
            }
            Value::Array(items) => for child in items { visit(child, ids); },
            _ => {}
        }
    }
    let mut used = std::collections::BTreeSet::new();
    visit(project, &mut used);
    loop {
        let before = used.len();
        for asset in assets {
            if asset["id"].as_str().is_some_and(|id| used.contains(id)) {
                if let Some(angles) = asset["unifiedAngles"]["angleAssetIds"].as_array() {
                    used.extend(angles.iter().filter_map(Value::as_str).map(str::to_owned));
                }
                if let Some(id) = asset["unifiedAngles"]["audioAssetId"].as_str() { used.insert(id.into()); }
            }
        }
        if used.len() == before { break; }
    }
    assets.iter().filter(|asset| asset["missing"] == true && asset["id"].as_str().is_some_and(|id| used.contains(id)))
        .map(|asset| asset["name"].as_str().unwrap_or("Unknown media").to_owned()).collect()
}

pub fn relink(record: &Value, source: &str) -> Result<Value, String> {
    if source.trim().is_empty() || source.chars().any(char::is_control) {
        return Err("A valid media source is required".into());
    }
    let mut result = record.clone();
    let fields = result.as_object_mut().ok_or("Media record must be an object")?;
    if fields.contains_key("source") {
        fields.insert("source".into(), source.into());
        fields.insert("offline".into(), false.into());
    } else {
        fields.insert("sourcePath".into(), source.into());
        fields.insert("storageKind".into(), "linked".into());
        fields.insert("missing".into(), false.into());
    }
    Ok(result)
}

/// Classic persists source undo alongside the index; timeline history stays exact.
pub fn classic_binding(record: &Value, source: &str, revision: u64, undo: bool) -> Result<Value, String> {
    classic_binding_with_probe(record, source, revision, undo, None)
}

/// Host-probed source facts validate a corrected recording without identifying
/// a recording by its compressed byte count. Existing timeline clocks stay exact.
pub fn classic_binding_with_probe(record: &Value, source: &str, revision: u64, undo: bool, replacement: Option<&Value>) -> Result<Value, String> {
    let current = record["bindingRevision"].as_u64().unwrap_or(0);
    if revision != current { return Err("Media binding changed. Refresh before relinking.".into()); }
    if !undo {
        if let Some(probe) = replacement {
            let positive = |value: &Value| value.as_f64().filter(|v| v.is_finite() && *v > 0.0);
            let old_size = record["size"].as_u64().unwrap_or(0);
            let new_size = probe["size"].as_u64().filter(|v| *v > 0).ok_or("Replacement source size is missing")?;
            if old_size > 0 && new_size != old_size {
                if record["type"] != "video" { return Err("Changed source bytes require compatible video timing metadata".into()); }
                let duration = positive(&probe["duration"]).ok_or("Replacement video duration is missing")?;
                let original = positive(&record["duration"]).ok_or("Original video duration is missing")?;
                let fps = positive(&record["fps"]).ok_or("Original video frame rate is missing")?;
                let replacement_fps = positive(&probe["fps"]).ok_or("Replacement video frame rate is missing")?;
                // Legacy imports can include an AAC tail of less than one frame.
                if (duration - original).abs() > 1.0 / fps + 0.000_001 {
                    return Err("Replacement video length differs; existing cut timings cannot be preserved".into());
                }
                if (fps - replacement_fps).abs() > 0.000_001 {
                    return Err("Replacement video frame rate differs".into());
                }
                for dimension in ["width", "height"] {
                    if record[dimension].as_u64().filter(|v| *v > 0).is_none() || record[dimension] != probe[dimension] {
                        return Err(format!("Replacement video {dimension} differs"));
                    }
                }
                if probe["startTime"].as_f64().is_none_or(|v| !v.is_finite() || v.abs() > 0.000_001) {
                    return Err("Replacement video must retain the zero source clock".into());
                }
                if record["hasAudio"] == true && probe["hasAudio"] != true {
                    return Err("Replacement video is missing the source audio".into());
                }
            }
            if probe["lastModified"].as_f64().is_none_or(|v| !v.is_finite() || v < 0.0) {
                return Err("Replacement source modification time is missing".into());
            }
        }
    }
    let mut history = record["bindingHistory"].as_array().cloned().unwrap_or_default();
    let mut result = if undo {
        history.pop().ok_or("No previous media binding")?
    } else {
        let mut previous = record.clone();
        previous.as_object_mut().ok_or("Invalid media record")?.remove("bindingHistory");
        history.push(previous);
        relink(record, source)?
    };
    result["bindingHistory"] = json!(history);
    result["bindingRevision"] = json!(current.checked_add(1).ok_or("Binding revision overflow")?);
    if !undo {
        if let Some(probe) = replacement {
            result["size"] = probe["size"].clone();
            result["lastModified"] = probe["lastModified"].clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_checks_referenced_sources_including_unified_angles() {
        let project = json!({"scenes":[{"elements":[{"mediaId":"angles"}]}]});
        let assets = vec![json!({"id":"angles","unifiedAngles":{"angleAssetIds":["clip"]}}),json!({"id":"clip","missing":true,"name":"Camera 1"}),json!({"id":"unused","missing":true,"name":"Unused"})];
        assert_eq!(missing_used(&project, &assets), vec!["Camera 1"]);
    }
    #[test]
    fn relinking_preserves_identity_unknown_metadata_and_undo() {
        let original = json!({"id":"clip","sourcePath":"old.mp4","storageKind":"linked","duration":27.5,"future":{"keep":true}});
        let linked = classic_binding(&original, "new.mp4", 0, false).unwrap();
        assert_eq!(linked["id"], original["id"]);
        assert_eq!(linked["duration"], original["duration"]);
        assert_eq!(linked["future"], original["future"]);
        assert!(classic_binding(&linked, "wrong.mp4", 0, false).is_err());
        let restored = classic_binding(&linked, "", 1, true).unwrap();
        assert_eq!(restored["sourcePath"], "old.mp4");
        assert_eq!(restored["bindingRevision"], 2);
        assert!(relink(&original, "\ninvalid").is_err());
    }

    #[test]
    fn corrected_audio_refreshes_binding_without_changing_source_clocks() {
        let original = json!({"id":"clip","sourcePath":"episode.mp4","type":"video","size":100,"lastModified":1,"duration":6479.317333333333,"fps":25,"width":3840,"height":2160,"hasAudio":true,"future":{"keep":true}});
        let probe = json!({"size":105,"lastModified":2,"duration":6479.28,"fps":25,"width":3840,"height":2160,"startTime":0,"hasAudio":true});
        let linked = classic_binding_with_probe(&original,"episode.mp4",0,false,Some(&probe)).unwrap();
        assert_eq!(linked["size"],105);
        assert_eq!(linked["lastModified"],2);
        assert_eq!(linked["duration"],original["duration"]);
        assert_eq!(linked["future"],original["future"]);
        assert_eq!(linked["id"],original["id"]);
        let restored = classic_binding_with_probe(&linked,"",1,true,None).unwrap();
        assert_eq!(restored["size"],100);
        assert_eq!(restored["lastModified"],1);
        assert!(classic_binding_with_probe(&linked,"episode.mp4",0,false,Some(&probe)).is_err());
        let unknown = json!({"id":"offline", "type":"video", "size":0});
        assert!(classic_binding_with_probe(&unknown,"episode.mp4",0,false,Some(&probe)).is_ok());
        for (key,value) in [("duration",json!(6478)),("fps",json!(30)),("width",json!(1920)),("height",json!(1080)),("startTime",json!(1)),("hasAudio",json!(false))] {
            let mut invalid = probe.clone();invalid[key]=value;
            assert!(classic_binding_with_probe(&original,"episode.mp4",0,false,Some(&invalid)).is_err(),"{key}");
        }
    }
}
