use bridge::export;
use serde::Deserialize;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMissingOptions { pub project_json: String, pub assets_json: String }

#[export]
pub fn media_missing_used(options: MediaMissingOptions) -> Result<String, String> {
    let project = serde_json::from_str(&options.project_json).map_err(|e| e.to_string())?;
    let assets: Vec<serde_json::Value> = serde_json::from_str(&options.assets_json).map_err(|e| e.to_string())?;
    serde_json::to_string(&opencut_account_core::media::missing_used(&project, &assets)).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRelinkOptions {
    pub record_json: String,
    pub source: String,
    pub expected_revision: u32,
    pub undo: bool,
}

#[export]
pub fn media_relink_binding(options: MediaRelinkOptions) -> Result<String, String> {
    let record = serde_json::from_str(&options.record_json).map_err(|e| e.to_string())?;
    let result = opencut_account_core::media::classic_binding(&record, &options.source, options.expected_revision.into(), options.undo)?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// Host identity and I/O are adapters; the account transaction is shared with
/// OpenCutRuntime. JSON keeps the projection independent of UI frameworks.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStorageOptions {
    pub state_json: String,
    pub authenticated_id: String,
    pub configuration_json: String,
}

#[export]
pub fn account_configure_storage(
    AccountStorageOptions {
        state_json,
        authenticated_id,
        configuration_json,
    }: AccountStorageOptions,
) -> Result<String, String> {
    let mut state: opencut_account_core::AccountState =
        serde_json::from_str(&state_json).map_err(|e| e.to_string())?;
    let configuration = serde_json::from_str(&configuration_json).map_err(|e| e.to_string())?;
    state.configure_storage(&authenticated_id, configuration)?;
    serde_json::to_string(&state).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshotOptions {
    pub manifest_json: String,
    pub authenticated_id: String,
}

#[export]
pub fn account_validate_snapshot(
    AccountSnapshotOptions {
        manifest_json,
        authenticated_id,
    }: AccountSnapshotOptions,
) -> Result<(), String> {
    let manifest: opencut_account_core::snapshot::SnapshotManifest =
        serde_json::from_str(&manifest_json).map_err(|error| error.to_string())?;
    manifest.validate(&authenticated_id)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecoveryOptions {
    pub project_json: String,
    pub history_json: String,
    pub source_id: String,
    pub destination_id: String,
}

/// Preserve a browser variant as an independently editable classic project.
/// The host also retains the unmodified source JSON alongside the new variant.
#[export]
pub fn browser_recovery_project(options: BrowserRecoveryOptions) -> Result<String, String> {
    let mut project: serde_json::Value =
        serde_json::from_str(&options.project_json).map_err(|e| e.to_string())?;
    let mut history: serde_json::Value =
        serde_json::from_str(&options.history_json).map_err(|e| e.to_string())?;
    if options.source_id == options.destination_id || options.destination_id.is_empty() {
        return Err("Recovery requires a separate project ID".into());
    }
    let source = project
        .get("metadata")
        .and_then(|v| v.get("id"))
        .or_else(|| project.get("id"))
        .and_then(|v| v.as_str());
    if source != Some(options.source_id.as_str()) {
        return Err("Browser project identity mismatch".into());
    }
    if let Some(metadata) = project.get_mut("metadata").and_then(|v| v.as_object_mut()) {
        metadata.insert("id".into(), options.destination_id.clone().into());
        let name = metadata
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Recovered project");
        metadata.insert("name".into(), format!("{name} (browser recovery)").into());
    } else {
        let name = project
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Recovered project");
        project["name"] = format!("{name} (browser recovery)").into();
    }
    if project.get("id").is_some() {
        project["id"] = options.destination_id.clone().into();
    }
    fn rebind(value: &mut serde_json::Value, source: &str, destination: &str) {
        match value {
            serde_json::Value::Object(fields) => {
                if fields.get("projectId").and_then(|v| v.as_str()) == Some(source) {
                    fields.insert("projectId".into(), destination.into());
                }
                if let Some(metadata) = fields.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                    if metadata.get("id").and_then(|v| v.as_str()) == Some(source) {
                        metadata.insert("id".into(), destination.into());
                    }
                }
                for child in fields.values_mut() {
                    rebind(child, source, destination);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    rebind(child, source, destination);
                }
            }
            _ => {}
        }
    }
    rebind(&mut project, &options.source_id, &options.destination_id);
    rebind(&mut history, &options.source_id, &options.destination_id);
    serde_json::to_string(&serde_json::json!({"project": project, "history": history}))
        .map_err(|e| e.to_string())
}

pub const LINK_MEDIA_AT_BYTES: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaStorageDisposition {
    Copy,
    Link,
    SourcePathRequired,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStorageDispositionOptions {
    pub size: f64,
    pub has_source_path: bool,
    #[serde(default)]
    pub preserve_link: bool,
}

pub fn choose_media_storage(
    MediaStorageDispositionOptions {
        size,
        has_source_path,
        preserve_link,
    }: MediaStorageDispositionOptions,
) -> MediaStorageDisposition {
    let normalized_size = if size.is_finite() {
        size.max(0.0)
    } else {
        f64::MAX
    };

    if preserve_link && has_source_path {
        return MediaStorageDisposition::Link;
    }
    if normalized_size <= LINK_MEDIA_AT_BYTES {
        return MediaStorageDisposition::Copy;
    }
    if has_source_path {
        MediaStorageDisposition::Link
    } else {
        MediaStorageDisposition::SourcePathRequired
    }
}

#[export]
pub fn media_storage_disposition(options: MediaStorageDispositionOptions) -> String {
    match choose_media_storage(options) {
        MediaStorageDisposition::Copy => "copy",
        MediaStorageDisposition::Link => "link",
        MediaStorageDisposition::SourcePathRequired => "sourcePathRequired",
    }
    .to_owned()
}

#[export]
pub fn media_link_threshold_bytes() -> f64 {
    LINK_MEDIA_AT_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_recovery_keeps_unknown_fields_and_rebinds_undo_history() {
        let result = browser_recovery_project(BrowserRecoveryOptions {
            project_json: r#"{"metadata":{"id":"old","name":"Cut"},"future":{"keep":[1,2]}}"#.into(),
            history_json: r#"{"projectId":"old","undoStack":[{"before":{"metadata":{"id":"old"},"extra":true}}]}"#.into(),
            source_id: "old".into(), destination_id: "new".into(),
        }).unwrap();
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["project"]["metadata"]["id"], "new");
        assert_eq!(
            value["project"]["future"]["keep"],
            serde_json::json!([1, 2])
        );
        assert_eq!(
            value["history"]["undoStack"][0]["before"]["metadata"]["id"],
            "new"
        );
        assert_eq!(value["history"]["undoStack"][0]["before"]["extra"], true);
    }

    #[test]
    fn copies_media_up_to_and_including_one_gibibyte() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES,
                has_source_path: true,
                preserve_link: false,
            }),
            MediaStorageDisposition::Copy
        );
    }

    #[test]
    fn links_large_media_when_a_source_path_is_available() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES + 1.0,
                has_source_path: true,
                preserve_link: false,
            }),
            MediaStorageDisposition::Link
        );
    }

    #[test]
    fn refuses_to_copy_large_browser_only_files() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES + 1.0,
                has_source_path: false,
                preserve_link: false,
            }),
            MediaStorageDisposition::SourcePathRequired
        );
    }
}
