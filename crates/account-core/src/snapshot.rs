//! Portable snapshot contract shared by storage hosts. Concurrent snapshots are
//! immutable siblings; no device is allowed to overwrite another device's work.
use crate::validate_id;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotManifest {
    pub version: u32,
    pub account_id: String,
    pub snapshot_id: String,
    pub device_id: String,
    pub created_at: String,
    pub files: Vec<SnapshotFile>,
}

impl SnapshotManifest {
    pub fn validate(&self, account_id: &str) -> Result<(), String> {
        if self.version != 1 { return Err("Unsupported snapshot version".into()); }
        validate_id(&self.account_id)?;
        validate_id(&self.snapshot_id)?;
        validate_id(&self.device_id)?;
        if self.account_id != account_id { return Err("Snapshot belongs to another account".into()); }
        if self.created_at.is_empty() || self.created_at.len() > 64 { return Err("Invalid snapshot timestamp".into()); }
        if self.files.len() > 100_000 { return Err("Snapshot exceeds file count limit".into()); }
        let mut paths = BTreeSet::new();
        for file in &self.files {
            if file.path.len() > 2048 || file.path.is_empty() || file.path.contains(['\\', ':', '\0']) || file.path.chars().any(char::is_control) {
                return Err("Invalid snapshot path".into());
            }
            for part in file.path.split('/') {
                let basename = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
                if part.is_empty() || part == "." || part == ".." || part.ends_with(['.', ' ']) || part.contains(['<', '>', '"', '|', '?', '*']) || matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (basename.len() == 4 && (basename.starts_with("COM") || basename.starts_with("LPT")) && basename.as_bytes()[3].is_ascii_digit()) {
                    return Err("Snapshot path is not portable".into());
                }
            }
            if !paths.insert(file.path.to_lowercase()) { return Err("Snapshot contains duplicate paths".into()); }
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("Invalid snapshot checksum".into()); }
            if file.bytes > 9_007_199_254_740_991 { return Err("Snapshot file size exceeds exact host representation".into()); }
        }
        // A file cannot also be a parent directory. Reject before any host I/O.
        for file in &self.files {
            let mut prefix = String::new();
            let components: Vec<_> = file.path.split('/').collect();
            for component in components.iter().take(components.len() - 1) {
                if !prefix.is_empty() { prefix.push('/'); }
                prefix.push_str(component);
                if paths.contains(&prefix.to_lowercase()) { return Err("Snapshot file/directory collision".into()); }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(paths: &[&str]) -> SnapshotManifest {
        SnapshotManifest { version: 1, account_id: "alice".into(), snapshot_id: "snapshot-1".into(), device_id: "desktop".into(), created_at: "2026-09-28T00:00:00Z".into(), files: paths.iter().map(|path| SnapshotFile { path: (*path).into(), bytes: 1, sha256: "a".repeat(64) }).collect() }
    }
    #[test]
    fn ownership_and_portable_paths_are_validated_before_restore() {
        assert!(snapshot(&["projects/one/project.json", "media/שלום.wav"]).validate("alice").is_ok());
        assert!(snapshot(&["asset.wav"]).validate("bob").is_err());
        for path in ["../secret", "/root", "a//b", "a/./b", "C:/a", "a\\b", "a.", "CON.txt", "a/NUL", "a/file:stream", "a/COM1.wav"] { assert!(snapshot(&[path]).validate("alice").is_err(), "{path}"); }
        assert!(snapshot(&["a", "A"]).validate("alice").is_err());
        assert!(snapshot(&["a", "a/b"]).validate("alice").is_err());
    }
}
