//! Project-scoped original-media transfers. Hosts own authentication, transport
//! and files; this policy never accepts a peer-provided filesystem path.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CHUNK_BYTES: u64 = 256 * 1024;
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaPullRequest {
    pub project_id: String,
    pub media_id: String,
    pub device_id: String,
    pub operation_id: String,
    pub expected_binding_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaPullManifest {
    pub project_id: String,
    pub media_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub last_modified: u64,
}

pub fn safe_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl MediaPullRequest {
    pub fn validate(&self) -> Result<(), String> {
        if [&self.project_id, &self.media_id, &self.device_id, &self.operation_id]
            .iter().any(|id| !safe_id(id)) || self.expected_binding_revision >= u32::MAX as u64 {
            return Err("Invalid project, media, device, operation or binding revision".into());
        }
        Ok(())
    }
}

impl MediaPullManifest {
    pub fn validate(&self, request: &MediaPullRequest, local: &serde_json::Value) -> Result<(), String> {
        request.validate()?;
        if self.project_id != request.project_id || self.media_id != request.media_id
            || local["id"].as_str() != Some(request.media_id.as_str()) {
            return Err("Transferred file belongs to another project or media identity".into());
        }
        if local["unifiedAngles"].is_object() {
            return Err("Pull the original sources of a compound asset individually".into());
        }
        if local["missing"] != true {
            return Err("An available local source must not be replaced by a download".into());
        }
        if local["bindingRevision"].as_u64().unwrap_or(0) != request.expected_binding_revision {
            return Err("Media binding changed; refresh before pulling files".into());
        }
        let expected = local["size"].as_u64().ok_or("Original source byte size is missing")?;
        if self.bytes == 0 || self.bytes > MAX_FILE_BYTES || self.bytes != expected {
            return Err("Remote original has a different byte size".into());
        }
        let kind = local["type"].as_str().ok_or("Original media type is missing")?;
        if !["video", "audio", "image"].contains(&kind)
            || !self.mime_type.starts_with(&format!("{kind}/")) || self.mime_type.len() > 160 {
            return Err("Remote original has a different media type".into());
        }
        if self.file_name.is_empty() || self.file_name.len() > 256
            || self.file_name == "." || self.file_name == ".."
            || self.file_name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
            || self.file_name.ends_with(['.', ' ']) {
            return Err("Remote original has an unsafe filename".into());
        }
        if self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("Remote original requires a SHA-256 checksum".into());
        }
        if self.last_modified > 9_007_199_254_740_991 {
            return Err("Invalid original modification time".into());
        }
        Ok(())
    }

    pub fn validate_chunk(&self, offset: u64, bytes: u64) -> Result<(), String> {
        if offset > self.bytes || bytes == 0 || bytes > CHUNK_BYTES
            || offset.checked_add(bytes).is_none_or(|end| end > self.bytes) {
            return Err("Transferred chunk is outside the requested original".into());
        }
        Ok(())
    }

    pub fn validate_complete(&self, bytes: u64, sha256: &str) -> Result<(), String> {
        if bytes != self.bytes || sha256 != self.sha256 {
            return Err("Downloaded original failed size or SHA-256 verification".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (MediaPullRequest, MediaPullManifest, serde_json::Value) {
        (MediaPullRequest { project_id: "project".into(), media_id: "video".into(), device_id: "laptop".into(), operation_id: "pull_1".into(), expected_binding_revision: 2 },
         MediaPullManifest { project_id: "project".into(), media_id: "video".into(), file_name: "original.mp4".into(), mime_type: "video/mp4".into(), bytes: 600_000, sha256: "a".repeat(64), last_modified: 123 },
         json!({"id":"video","missing":true,"size":600_000,"type":"video","bindingRevision":2,"duration":9,"future":{"keep":true}}))
    }
    #[test]
    fn verifies_exact_original_without_changing_document_or_media() {
        let (request, manifest, local) = fixture(); let before = local.clone();
        manifest.validate(&request, &local).unwrap();
        manifest.validate_chunk(0, CHUNK_BYTES).unwrap();
        manifest.validate_complete(600_000, &"a".repeat(64)).unwrap();
        assert_eq!(local, before);
    }
    #[test]
    fn rejects_wrong_scope_existing_sources_and_stale_bindings() {
        let (request, manifest, local) = fixture();
        for (key, value) in [("id", json!("other")), ("missing", json!(false)), ("size", json!(5)), ("type", json!("audio")), ("bindingRevision", json!(3)), ("unifiedAngles", json!({}))] {
            let mut changed = local.clone(); changed[key] = value;
            assert!(manifest.validate(&request, &changed).is_err(), "{key}");
        }
        let mut other = manifest.clone(); other.project_id = "other".into();
        assert!(other.validate(&request, &local).is_err());
    }
    #[test]
    fn rejects_peer_paths_corrupt_content_and_unbounded_chunks() {
        let (request, manifest, local) = fixture();
        for name in ["../original.mp4", "C:\\secret.mp4", "a/b.mp4", "x\n.mp4", "..", "file."] {
            let mut changed = manifest.clone(); changed.file_name = name.into();
            assert!(changed.validate(&request, &local).is_err(), "{name}");
        }
        assert!(manifest.validate_chunk(600_000, 1).is_err());
        assert!(manifest.validate_chunk(u64::MAX, 1).is_err());
        assert!(manifest.validate_chunk(0, CHUNK_BYTES + 1).is_err());
        assert!(manifest.validate_complete(600_000, &"b".repeat(64)).is_err());
        assert!(manifest.validate_complete(599_999, &manifest.sha256).is_err());
    }
}
