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
    let current = record["bindingRevision"].as_u64().unwrap_or(0);
    if revision != current { return Err("Media binding changed. Refresh before relinking.".into()); }
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
}
